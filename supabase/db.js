import { supabase } from './supabaseClient.js';

const COLLECTION_META = {
  sessions: {
    primaryKey: 'id',
    upsertOn: 'id',
    timestampFields: ['created_at', 'updated_at', 'start_time', 'end_time', 'ended_at', 'last_updated']
  },
  groups: {
    primaryKey: 'id',
    timestampFields: ['created_at']
  },
  session_prompts: {
    primaryKey: 'session_id',
    upsertOn: 'session_id',
    timestampFields: ['updated_at']
  },
  session_logs: {
    primaryKey: 'id',
    timestampFields: ['created_at']
  },
  transcripts: {
    primaryKey: 'id',
    upsertOn: 'session_id,group_id',
    timestampFields: ['created_at', 'updated_at']
  },
  summaries: {
    primaryKey: 'id',
    upsertOn: 'group_id',
    timestampFields: ['created_at', 'updated_at']
  },
  mindmap_sessions: {
    primaryKey: 'id',
    upsertOn: 'session_id',
    timestampFields: ['created_at', 'archived_at']
  },
  mindmap_archives: {
    primaryKey: 'id',
    timestampFields: ['start_time', 'end_time', 'saved_at', 'created_at']
  },
  checkbox_sessions: {
    primaryKey: 'session_id',
    upsertOn: 'session_id',
    timestampFields: ['created_at', 'updated_at']
  },
  checkbox_criteria: {
    primaryKey: 'id',
    timestampFields: ['created_at']
  },
  checkbox_progress: {
    primaryKey: 'id',
    upsertOn: 'session_id,group_number',
    timestampFields: ['created_at', 'updated_at']
  },
  checkbox_results: {
    primaryKey: 'id',
    timestampFields: ['created_at']
  },
  prompt_library: {
    primaryKey: 'id',
    timestampFields: ['created_at', 'updated_at']
  },
  teacher_prompts: {
    primaryKey: 'id',
    timestampFields: ['created_at', 'updated_at', 'last_viewed', 'last_used'],
    fieldMap: {
      authorName: 'author_name',
      isPublic: 'is_public'
    }
  },
  mindmap_nodes: {
    primaryKey: 'id',
    timestampFields: []
  },
  transcriptions: {
    primaryKey: 'id',
    timestampFields: ['created_at']
  }
};

const DEFAULT_TIMESTAMP_FIELDS = [];

const noop = async () => ({ acknowledged: true });

function getCollectionMeta(name) {
  const meta = COLLECTION_META[name] || {};
  if (!meta._normalized) {
    meta.timestampFields = meta.timestampFields || DEFAULT_TIMESTAMP_FIELDS;
    meta.fieldMap = meta.fieldMap || {};
    meta.reverseFieldMap = Object.fromEntries(
      Object.entries(meta.fieldMap).map(([original, dbField]) => [dbField, original])
    );
    meta._normalized = true;
  }
  return meta;
}

function resolveColumn(collectionName, field) {
  if (field === '_id') return 'id';
  const meta = getCollectionMeta(collectionName);
  return meta.fieldMap[field] || field;
}

function serializeTimestamp(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'number') {
    return new Date(value).toISOString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}

function deserializeTimestamp(value) {
  if (value === null || value === undefined) return value;
  const ms = Date.parse(value);
  if (!Number.isNaN(ms)) {
    return ms;
  }
  return value;
}

function normalizeValue(column, value) {
  if (column === 'id' && typeof value === 'object' && value !== null && 'toString' in value) {
    return value.toString();
  }
  return value;
}

function prepareRow(collectionName, doc) {
  const meta = getCollectionMeta(collectionName);
  const prepared = {};
  for (const [key, rawVal] of Object.entries(doc)) {
    if (rawVal === undefined) continue;
    const column = resolveColumn(collectionName, key);
    let value = rawVal;
    if (meta.timestampFields.includes(column)) {
      value = serializeTimestamp(rawVal);
    }
    if (column === 'id' && value === null) continue;
    prepared[column] = value;
  }
  return prepared;
}

function convertRow(collectionName, row) {
  if (!row) return null;
  const meta = getCollectionMeta(collectionName);
  const converted = {};
  for (const [dbField, rawValue] of Object.entries(row)) {
    const targetField = meta.reverseFieldMap[dbField] || dbField;
    const isTimestamp = meta.timestampFields.includes(dbField) || meta.timestampFields.includes(targetField);
    let value = rawValue;
    if (isTimestamp && typeof value === 'string') {
      value = deserializeTimestamp(value);
    }
    converted[targetField] = value;
  }
  if ('id' in row) {
    converted._id = row.id;
  }
  return converted;
}

function clone(data) {
  return JSON.parse(JSON.stringify(data));
}

function applyUpdateOperators(collectionName, originalDoc, update) {
  const doc = clone(originalDoc || {});
  const { $set, $inc, $push } = update;

  if ($set) {
    for (const [key, value] of Object.entries($set)) {
      if (key === '_id' && doc._id) {
        continue;
      }
      doc[key] = value;
    }
  }

  if ($inc) {
    for (const [key, value] of Object.entries($inc)) {
      const current = Number(doc[key] ?? 0);
      doc[key] = current + value;
    }
  }

  if ($push) {
    for (const [key, value] of Object.entries($push)) {
      const target = Array.isArray(doc[key]) ? [...doc[key]] : [];
      if (value && typeof value === 'object' && '$each' in value) {
        target.push(...value.$each);
      } else {
        target.push(value);
      }
      doc[key] = target;
    }
  }

  return doc;
}

function buildOrClause(orFilter) {
  return Object.entries(orFilter)
    .map(([field, value]) => {
      const column = field;
      if (value && typeof value === 'object') {
        if ('$ilike' in value) {
          return `${column}.ilike.${value.$ilike}`;
        }
        if ('$eq' in value) {
          return `${column}.eq.${value.$eq}`;
        }
        if ('$in' in value && Array.isArray(value.$in)) {
          return value.$in
            .map((item) => `${column}.eq.${item}`)
            .join(',');
        }
        if ('$regex' in value) {
          const pattern = value.$regex;
          const cleaned = typeof pattern === 'string' ? pattern : pattern?.source;
          return `${column}.ilike.*${cleaned?.replace(/^\^/, '').replace(/\$$/, '')}*`;
        }
      }
      if (typeof value === 'string') {
        return `${column}.eq.${value}`;
      }
      return `${column}.is.${value}`;
    })
    .join(',');
}

class SupabaseCursor {
  constructor(collection, filter = {}) {
    this.collection = collection;
    this.filter = filter;
    this.ordering = [];
    this.range = null;
    this.selectedColumns = '*';
  }

  sort(orderSpec = {}) {
    this.ordering = Object.entries(orderSpec).map(([field, direction]) => ({
      column: this.collection.resolveColumn(field),
      ascending: direction !== -1 && direction !== 'desc'
    }));
    return this;
  }

  skip(offset) {
    if (!this.range) {
      this.range = { from: offset, to: Infinity };
    } else {
      this.range.from = offset;
    }
    return this;
  }

  limit(count) {
    if (!this.range) {
      this.range = { from: 0, to: count - 1 };
    } else {
      this.range.to = (this.range.from ?? 0) + count - 1;
    }
    return this;
  }

  project(columns) {
    if (Array.isArray(columns)) {
      this.selectedColumns = columns.map((col) => this.collection.resolveColumn(col)).join(',');
    }
    return this;
  }

  async toArray() {
    const { data } = await this.collection._select(this.filter, {
      ordering: this.ordering,
      range: this.range,
      columns: this.selectedColumns
    });
    return data.map((row) => convertRow(this.collection.name, row));
  }

  async count() {
    const { count } = await this.collection._select(this.filter, {
      ordering: [],
      range: null,
      columns: '*',
      count: true,
      head: true
    });
    return count ?? 0;
  }
}

class SupabaseCollection {
  constructor(name) {
    this.name = name;
    this.meta = getCollectionMeta(name);
  }

  resolveColumn(field) {
    return resolveColumn(this.name, field);
  }

  _applyFilter(query, filter = {}) {
    if (!filter || Object.keys(filter).length === 0) {
      return query;
    }

    for (const [field, value] of Object.entries(filter)) {
      if (field === '$or' && Array.isArray(value)) {
        const clauses = value.map((orFilter) => {
          return buildOrClause(
            Object.fromEntries(
              Object.entries(orFilter).map(([k, v]) => [this.resolveColumn(k), v])
            )
          );
        }).join(',');
        query = query.or(clauses);
        continue;
      }

      const column = this.resolveColumn(field);

      if (value && typeof value === 'object' && !Array.isArray(value)) {
        if (value.$in) {
          query = query.in(column, value.$in.map((v) => normalizeValue(column, v)));
        } else if (value.$eq !== undefined) {
          query = query.eq(column, normalizeValue(column, value.$eq));
        } else if (value.$regex) {
          const pattern = typeof value.$regex === 'string' ? value.$regex : value.$regex.source;
          const sanitized = pattern.replace(/^\^/, '').replace(/\$$/, '');
          query = query.ilike(column, `%${sanitized}%`);
        } else if (value.$ilike) {
          query = query.ilike(column, value.$ilike);
        } else {
          throw new Error(`Unsupported filter operator for ${column}`);
        }
      } else {
        query = query.eq(column, normalizeValue(column, value));
      }
    }

    return query;
  }

  _applyOrdering(query, ordering = []) {
    let ordered = query;
    ordering.forEach(({ column, ascending }) => {
      ordered = ordered.order(column, { ascending, nullsFirst: !ascending });
    });
    return ordered;
  }

  _applyRange(query, range) {
    if (!range) return query;
    const from = Math.max(range.from ?? 0, 0);
    const to = range.to === Infinity ? null : range.to;
    if (to !== null) {
      return query.range(from, to);
    }
    return query.range(from, from + 1000); // safety window
  }

  async _select(filter = {}, options = {}) {
    const {
      ordering = [],
      range = null,
      columns = '*',
      count = false,
      head = false
    } = options;

    let query = supabase.from(this.name).select(columns, {
      count: count ? 'exact' : undefined,
      head
    });

    const columnFilter = Object.fromEntries(
      Object.entries(filter).map(([key, val]) => [key, val])
    );

    query = this._applyFilter(query, columnFilter);
    query = this._applyOrdering(query, ordering);
    query = this._applyRange(query, range);

    const { data, error, count: totalCount } = await query;
    if (error) throw error;
    return { data: data ?? [], count: totalCount ?? null };
  }

  collection(name) {
    return new SupabaseCollection(name);
  }

  async findOne(filter = {}) {
    const { data } = await this._select(filter, { range: { from: 0, to: 0 } });
    return convertRow(this.name, data[0]);
  }

  async insertOne(document) {
    const row = prepareRow(this.name, document);
    const { data, error } = await supabase.from(this.name).insert(row).select().maybeSingle();
    if (error) throw error;
    const inserted = convertRow(this.name, data);
    return {
      acknowledged: true,
      insertedId: inserted?._id ?? null,
      inserted
    };
  }

  async insertMany(documents) {
    if (!Array.isArray(documents) || documents.length === 0) {
      return { acknowledged: true, insertedCount: 0 };
    }
    const rows = documents.map((doc) => prepareRow(this.name, doc));
    const { data, error } = await supabase.from(this.name).insert(rows).select();
    if (error) throw error;
    return {
      acknowledged: true,
      insertedCount: data?.length ?? 0,
      insertedIds: (data ?? []).map((row) => row.id)
    };
  }

  find(filter = {}) {
    return new SupabaseCursor(this, filter);
  }

  async findOneAndUpdate(filter, update, options = {}) {
    const existing = await this.findOne(filter);
    if (!existing) {
      if (options.upsert) {
        const baseDoc = { ...filter };
        const upsertDoc = applyUpdateOperators(this.name, baseDoc, update);
        const row = prepareRow(this.name, upsertDoc);
        const upsertOptions = {};
        if (this.meta.upsertOn) {
          upsertOptions.onConflict = this.meta.upsertOn;
        }
        const { data, error } = await supabase.from(this.name).upsert(row, upsertOptions).select().maybeSingle();
        if (error) throw error;
        return convertRow(this.name, data);
      }
      return null;
    }

    const updatedDoc = applyUpdateOperators(this.name, existing, update);
    const patch = prepareRow(this.name, updatedDoc);

    let query = supabase.from(this.name).update(patch);
    query = this._applyFilter(query, { [this.meta.primaryKey || 'id']: existing[this.meta.primaryKey || 'id'] });
    const { data, error } = await query.select().maybeSingle();
    if (error) throw error;
    return convertRow(this.name, data);
  }

  async updateOne(filter, update, options = {}) {
    const existing = await this.findOne(filter);
    if (!existing) {
      if (options.upsert) {
        const base = { ...filter };
        const upsertDoc = applyUpdateOperators(this.name, base, update);
        const row = prepareRow(this.name, upsertDoc);
        const upsertOptions = {};
        if (this.meta.upsertOn) {
          upsertOptions.onConflict = this.meta.upsertOn;
        }
        const { data, error } = await supabase.from(this.name).upsert(row, upsertOptions).select();
        if (error) throw error;
        return { matchedCount: 0, modifiedCount: 0, upsertedId: data?.[0]?.id ?? null };
      }
      return { matchedCount: 0, modifiedCount: 0 };
    }

    const updatedDoc = applyUpdateOperators(this.name, existing, update);
    const patch = prepareRow(this.name, updatedDoc);

    let query = supabase.from(this.name).update(patch);
    query = this._applyFilter(query, { [this.meta.primaryKey || 'id']: existing[this.meta.primaryKey || 'id'] });

    const { error } = await query;
    if (error) throw error;
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async updateMany(filter, update) {
    const rows = await this.find(filter).toArray();
    if (rows.length === 0) {
      return { matchedCount: 0, modifiedCount: 0 };
    }

    let modifiedCount = 0;
    for (const row of rows) {
      const updatedDoc = applyUpdateOperators(this.name, row, update);
      const patch = prepareRow(this.name, updatedDoc);
      let query = supabase.from(this.name).update(patch);
      query = this._applyFilter(query, { [this.meta.primaryKey || 'id']: row[this.meta.primaryKey || 'id'] });
      const { error } = await query;
      if (error) throw error;
      modifiedCount += 1;
    }

    return { matchedCount: rows.length, modifiedCount };
  }

  async deleteOne(filter) {
    const existing = await this.findOne(filter);
    if (!existing) {
      return { deletedCount: 0 };
    }

    let query = supabase.from(this.name).delete();
    query = this._applyFilter(query, { [this.meta.primaryKey || 'id']: existing[this.meta.primaryKey || 'id'] });
    const { error } = await query;
    if (error) throw error;
    return { deletedCount: 1 };
  }

  async deleteMany(filter = {}) {
    let query = supabase.from(this.name).delete();
    query = this._applyFilter(query, filter);
    const { error, count } = await query.select('*', { count: 'exact' });
    if (error) throw error;
    return { deletedCount: count ?? 0 };
  }

  async countDocuments(filter = {}) {
    const cursor = this.find(filter);
    return cursor.count();
  }

  async distinct(field) {
    const column = this.resolveColumn(field);
    const { data, error } = await supabase.from(this.name).select(`${column}`, { distinct: true });
    if (error) throw error;
    return data.map((row) => row[column]).filter((value) => value !== null);
  }

  async aggregate() {
    throw new Error(`Aggregation pipelines are not supported on collection ${this.name}. Use Supabase SQL or compute in application code.`);
  }

  async createIndex() {
    return noop();
  }
}

class SupabaseDatabase {
  collection(name) {
    return new SupabaseCollection(name);
  }
}

export function createSupabaseDb() {
  return new SupabaseDatabase();
}
