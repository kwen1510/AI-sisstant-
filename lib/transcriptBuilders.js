export function createTranscriptRecord({
  id,
  sessionId,
  groupId,
  text,
  wordCount,
  durationSeconds,
  segmentNumber,
  createdAt,
  isNoise = false
}) {
  if (!sessionId) {
    throw new Error("sessionId is required to create a transcript record");
  }
  if (!groupId) {
    throw new Error("groupId is required to create a transcript record");
  }
  if (!id) {
    throw new Error("id is required to create a transcript record");
  }

  const timestamp = createdAt ? new Date(createdAt).toISOString() : new Date().toISOString();

  return {
    sessionId,
    groupId,
    segment: {
      id,
      text,
      word_count: wordCount ?? 0,
      duration_seconds: durationSeconds ?? 0,
      segment_number: segmentNumber ?? 0,
      is_noise: Boolean(isNoise),
      created_at: timestamp
    }
  };
}

export function createSummaryUpdateFields({
  sessionId,
  text,
  timestamp = Date.now()
}) {
  if (!sessionId) {
    throw new Error("sessionId is required to update a summary record");
  }

  return {
    session_id: sessionId,
    text,
    updated_at: timestamp
  };
}
