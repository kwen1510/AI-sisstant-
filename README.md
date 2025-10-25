# AI(ttention) – Architecture, Auth, and Realtime Flow

This document summarizes the authentication model, realtime (Socket.IO) + keep‑alive flow, and the main features/logic across `index.js` and the HTML UIs.

## Contents
- Auth Logic (client + server)
- WebSocket + Keep‑Alive
- Features and Per‑File Walkthrough
- Key REST APIs and Flows

---

## Auth Logic

- Client‑side (Supabase, OTP)
  - `public/login.html` + `public/js/admin-auth.js` implement email OTP sign‑in via Supabase. Sign‑in is restricted by domain (`window.ADMIN_DOMAIN`, e.g. `ri.edu.sg`).
  - Admin pages (`admin.html`, `checkbox.html`, `mindmap.html`, `prompts.html`, `data.html`) load `public/js/guard-admin.js`, which:
    - Ensures a Supabase session exists and the email domain is allowed.
    - Wraps `window.fetch` to automatically attach `Authorization: Bearer <supabase_jwt>` to any "/api/..." requests.

  Example (client fetch wrapper):
  ```js
  // public/js/guard-admin.js
  const supabase = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
  async function requireSession() {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) throw new Error('Missing session');
    return session;
  }
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('/api/')) {
      const session = await requireSession();
      const headers = new Headers(init.headers || {});
      headers.set('Authorization', `Bearer ${session.access_token}`);
      init = { ...init, headers };
    }
    return originalFetch(input, init);
  };
  ```

- Server‑side (token verification)
  - `index.js` uses a Supabase service client to validate the incoming Bearer token and attach a teacher identity to requests.

  Example (server auth):
  ```js
  // index.js
  async function authenticateTeacher(req) {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) throw new Error('Missing bearer token');
    const token = authHeader.replace('Bearer', '').trim();
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) throw new Error(error?.message || 'Invalid token');
    return data.user; // { id, email, ... }
  }
  ```
  - Protected endpoints call `requireTeacher(req, res)` and compare `session.owner_id` to `teacher.id` for authorization.

Notes
- Server uses `SUPABASE_SERVICE_ROLE_KEY` and never persists browser keys.
- Auth is enforced on REST APIs; socket events are unprotected by JWT but scoped to session codes/rooms.

---

## WebSocket + Keep‑Alive

Socket.IO powers realtime rooms for a session and per‑group subrooms:
- Rooms: `code` for the whole session, and `code-<groupNumber>` for a group.
- Key events:
  - Admin: `admin_join` (join session room), `admin_heartbeat`/`admin_heartbeat_ack`.
  - Student: `join` (session+group), `heartbeat`/`heartbeat_ack`, `record_now`, `stop_recording`, `transcription_and_summary`, `checklist_state`.

Client heartbeat (student):
```js
// public/student.html
heartbeatInterval = setInterval(() => {
  if (socket.connected && currentSession && currentGroup) {
    socket.emit('heartbeat', { session: currentSession, group: currentGroup });
  }
}, 10000);
// Ack handler
socket.on('heartbeat_ack', () => { lastHeartbeatTime = Date.now(); });
```

Server heartbeat handlers and ack:
```js
// index.js (socket flow)
io.on('connection', (socket) => {
  socket.on('heartbeat', ({ session, group }) => {
    socket.emit('heartbeat_ack');
    const mem = activeSessions.get(session);
    if (mem) {
      if (!mem.groups) mem.groups = new Map();
      const st = mem.groups.get(parseInt(group)) || {};
      st.joined = true; st.lastAck = Date.now();
      if (mem.active) st.recording = true;
      mem.groups.set(parseInt(group), st);
      activeSessions.set(session, mem);
    }
  });
  socket.on('admin_heartbeat', ({ sessionCode }) => {
    socket.emit('admin_heartbeat_ack');
  });
});
```

Start/ack reliability cycle:
- When a teacher starts a session (`POST /api/session/:code/start`), the server marks memory state active and repeatedly emits `record_now` to any groups that have joined until each group sends `recording_started` or 30s elapses.

```js
// index.js (excerpt)
socket.on('recording_started', ({ session, group }) => {
  const mem = activeSessions.get(session);
  const st = (mem.groups?.get(parseInt(group)) || {});
  st.joined = true; st.recording = true; st.lastAck = Date.now();
  mem.groups.set(parseInt(group), st);
  activeSessions.set(session, mem);
});
```

---

## Features and Per‑File Walkthrough

- Server: `index.js`
  - Session lifecycle (in‑memory + persisted):
    - `GET /api/new-session` creates an in‑memory session (code, interval, owner).
    - `POST /api/session/:code/start` persists if first start, marks active, begins auto-summary timers (for summary mode), and emits `record_now` retries until ack.
    - `POST /api/session/:code/stop` marks inactive, updates duration, emits `stop_recording`.
    - `GET /api/session/:code/status` returns memory/DB state for the owner.
  - Audio ingestion and processing:
    - Summary mode: `POST /api/transcribe-chunk`
      - Validates chunk, forwards to ElevenLabs STT.
      - Appends a transcript segment (per group) and trims history.
      - Generates a cumulative summary via OpenAI and upserts to `summaries`.
      - Emits to students (`transcription_and_summary`) and to admin (`admin_update`).
    - Mindmap mode: `POST /api/transcribe-mindmap-chunk`
      - Forwards to STT, then uses Groq to generate/expand a structured mindmap.
      - Persists mindmap JSON and chat history; returns JSON to the UI.
  - Mindmap admin APIs:
    - `POST /api/mindmap/start`, `/api/mindmap/generate`, `/api/mindmap/expand`, `/api/mindmap/process` for creating, seeding, and evolving mindmaps.
  - Checkbox mode:
    - `POST /api/checkbox/start` stores scenario/criteria; session stays inactive until /start.
    - `POST /api/checkbox/process` analyzes live transcript chunks against rubric criteria and applies locking rules:
      - GREEN is locked; GREY can upgrade to RED/GREEN; RED can only upgrade to GREEN.
      - Emits `admin_update` and a full `checklist_state` to both admin and students (controls visibility via `released_groups`).

    Example (locking core):
    ```js
    // index.js
    if (existingProgress?.status === 'green') {
      // locked – skip
    } else if (existingProgress?.status === 'grey' && (newStatus==='red'||newStatus==='green')) {
      shouldUpdate = true;
    } else if (existingProgress?.status === 'red' && newStatus==='green') {
      shouldUpdate = true;
    }
    ```
  - History/data export:
    - `GET /api/history`, `GET /api/history/session/:code`, `GET /api/data/...` aggregate transcripts, summaries, mindmap/checkbox state for dashboards.
  - Prompt management:
    - Per‑session prompt: `POST/GET /api/session/:code/prompt` (owner‑only).
    - Library: `GET/POST/PUT/DELETE /api/prompt-library`, plus advanced endpoints for teacher prompt collections.

- Admin dashboard: `public/admin.html`
  - Protected by `guard-admin.js`.
  - Creates/starts/stops sessions, shows group tiles with live transcript/summary, and includes heartbeat UI.
  - Emits `admin_join` and consumes `admin_update`, `transcription_and_summary`.

- Student UI: `public/student.html`
  - Join via session code + group.
  - Records microphone in timed chunks; uploads to `/api/transcribe-chunk`.
  - Heartbeats every 10s; shows connection and recording status.
  - Renders `transcription_and_summary` and (in checkbox mode) `checklist_state` once teacher releases.

- Mindmap (teacher): `public/mindmap.html`
  - Protected by `guard-admin.js`.
  - Starts a mindmap session and auto‑records; uploads to `/api/transcribe-mindmap-chunk`.
  - Visualizes the evolving mindmap (D3), maintains an AI chat log for transparency.

- Checkbox (teacher): `public/checkbox.html`
  - Protected by `guard-admin.js`.
  - Defines scenario + rubric criteria, controls start/stop, and releases the checklist to students.

- Prompt Library (teacher): `public/prompts.html`
  - View/search/create/edit/delete prompts across modes; leverages the REST prompt endpoints.

- Data dashboard (teacher): `public/data.html`
  - Paginates and filters sessions, shows per‑mode summaries; can drill down into detailed group transcripts and summaries.

- Login: `public/login.html`
  - OTP email flow via Supabase; wraps `fetch` to include the Bearer token for `/api/*` calls on that page too.

- Legacy/utility: `MONGO_ARCHIVE/public_export/export.html`
  - Small helper for exporting a legacy MongoDB to JSON by POSTing to `/export` (not used in the current Supabase path).

---

## Key End‑to‑End Flows

- Summary Mode (teacher + students)
  1) Teacher creates session (`/api/new-session`), shares code.
  2) Students `join` via Socket.IO; when teacher starts (`/start`), server emits `record_now` until `recording_started` acks.
  3) Students upload periodic chunks (`/api/transcribe-chunk`). Server STT → append → summarise → emit `transcription_and_summary` to group + `admin_update` to teacher.

- Mindmap Mode
  1) Teacher creates mindmap session and sets topic.
  2) As audio chunks arrive (`/api/transcribe-mindmap-chunk`), server STT → Groq mindmap generation/expansion → persist → return JSON to UI to render/update.

- Checkbox Mode
  1) Teacher seeds scenario/criteria and starts the session.
  2) Live chunks analyzed against rubric; progress respects locking rules; teacher can `release_checklist` to students → server emits `checklist_state` for the group.

---

## Representative Snippets

Emit results to clients after transcription (summary mode):
```js
// index.js (after saving transcript and summary)
io.to(`${sessionCode}-${groupNumber}`).emit('transcription_and_summary', {
  transcription: { text, cumulativeText, words, duration, wordCount },
  summary,
  isLatestSegment: true
});
io.to(sessionCode).emit('admin_update', {
  group: groupNumber,
  latestTranscript: text,
  cumulativeTranscript: cumulativeText,
  transcriptDuration: duration,
  transcriptWordCount: wordCount,
  summary,
  stats
});
```

Checklist release to students (teacher → server → everyone in session):
```js
// index.js (socket 'release_checklist')
const checklistData = { groupNumber, criteria: /* from DB + cache */, isReleased: true, sessionCode };
io.to(sessionCode).emit('checklist_state', checklistData);
io.to(`${sessionCode}-${groupNumber}`).emit('checklist_state', checklistData);
```

---

## Environment

- Supabase: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (server), and browser `window.SUPABASE_URL` + `window.SUPABASE_ANON_KEY` (client).
- STT: `ELEVENLABS_KEY` for ElevenLabs Speech‑to‑Text.
- LLM: `OPENAI_API_KEY` (or `OPENAI_KEY`) for summaries and mindmap generation/expansion.

---

## Notes and Considerations
- Socket events currently rely on session codes, not JWT; REST APIs are owner‑validated via Supabase.
- Audio ingestion validates headers (esp. WebM) and sizes; errors are surfaced to admin and students with retry/backoff.
- Transcript storage is incremental per group with trimming to bound history size.
- Mindmap API is disabled if `OPENAI_API_KEY` (or `OPENAI_KEY`) is unset; UI reflects that via error messaging.
