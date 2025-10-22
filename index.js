import 'dotenv/config';      
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { v4 as uuid } from "uuid";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import multer from "multer";
import Groq from "groq-sdk";
import { createSupabaseDb } from "./supabase/db.js";
import { supabase } from "./supabase/supabaseClient.js";
import { createTranscriptRecord, createSummaryUpdateFields } from "./lib/transcriptBuilders.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log("🚀 Starting Smart Classroom Live Transcription Server...");

// Initialize ElevenLabs client
const elevenlabs = new ElevenLabsClient({
  apiKey: process.env.ELEVENLABS_KEY,
});

let groqClient = null;
if (process.env.GROQ_API_KEY) {
  groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
} else {
  console.warn("⚠️ GROQ_API_KEY not set; mindmap generation will be unavailable.");
}

// Session state management
const activeSessions = new Map(); // sessionCode -> { id, code, active, interval, startTime }
const sessionTimers = new Map();  // sessionCode -> timer

// Global storage for session transcript history
const sessionTranscriptHistory = new Map();

// Utility helpers and globals
// Cache the latest emitted checklist state per session+group so we can reuse it on release
const latestChecklistState = new Map();

// Helper function to manage transcript history
function addToTranscriptHistory(sessionCode, transcript) {
  if (!sessionTranscriptHistory.has(sessionCode)) {
    sessionTranscriptHistory.set(sessionCode, []);
  }
  
  const history = sessionTranscriptHistory.get(sessionCode);
  history.push({
    transcript: transcript,
    timestamp: new Date().toISOString()
  });
  
  // Keep only the last 3 chunks for context
  if (history.length > 3) {
    history.shift();
  }
  
  console.log(`📝 Context History: Session ${sessionCode} now has ${history.length} chunks`);
}

function getContextualTranscript(sessionCode) {
  const history = sessionTranscriptHistory.get(sessionCode) || [];
  if (history.length === 0) return '';
  
  // Return combined transcript with context markers
  const contextText = history.map((chunk, index) => {
    const isLatest = index === history.length - 1;
    const chunkLabel = isLatest ? 'CURRENT CHUNK' : `PREVIOUS CHUNK ${history.length - index - 1}`;
    return `[${chunkLabel}]: ${chunk.transcript}`;
  }).join('\n\n');
  
  console.log(`🧠 Context Window: Sending ${history.length} chunks for analysis`);
  return contextText;
}

function clearTranscriptHistory(sessionCode) {
  sessionTranscriptHistory.delete(sessionCode);
  console.log(`🗑️ Cleared transcript history for session: ${sessionCode}`);
}

// Helper function to get current mindmap data from database
async function getMindmapData(sessionCode) {
  try {
    const session = await db.collection("sessions").findOne({ code: sessionCode });
    if (!session) {
      console.log(`⚠️ Session ${sessionCode} not found for mindmap data retrieval`);
      return null;
    }
    
    return session.mindmap_data || null;
  } catch (error) {
    console.error(`❌ Error retrieving mindmap data for session ${sessionCode}:`, error);
    return null;
  }
}

function computeTranscriptStats(segments = []) {
  const base = {
    total_segments: segments.length,
    total_words: 0,
    total_duration: 0,
    last_update: null
  };

  for (const segment of segments) {
    base.total_words += Number(segment?.word_count ?? 0);
    base.total_duration += Number(segment?.duration_seconds ?? 0);
    if (segment?.created_at) {
      base.last_update = segment.created_at;
    }
  }

  return base;
}

function extractTranscriptSegments(record) {
  const payload = record?.payload;
  if (!payload) return [];
  const segments = Array.isArray(payload.segments) ? payload.segments : [];
  return segments;
}

function segmentToTranscript(segment) {
  return {
    id: segment.id,
    text: segment.text,
    word_count: segment.word_count,
    duration_seconds: segment.duration_seconds,
    segment_number: segment.segment_number,
    is_noise: segment.is_noise,
    created_at: segment.created_at
  };
}

async function getTranscriptBundle(sessionId, groupId) {
  if (!sessionId || !groupId) {
    return { record: null, segments: [], stats: computeTranscriptStats([]) };
  }

  const record = await db.collection("transcripts").findOne({
    session_id: sessionId,
    group_id: groupId
  });

  const segments = extractTranscriptSegments(record);
  const stats = record?.payload?.stats ?? computeTranscriptStats(segments);
  return { record, segments, stats };
}

async function persistTranscriptBundle({ sessionId, groupId, segments, record }) {
  const stats = computeTranscriptStats(segments);
  const now = Date.now();
  const payload = {
    segments,
    stats
  };

  if (!record) {
    const result = await db.collection("transcripts").insertOne({
      _id: uuid(),
      session_id: sessionId,
      group_id: groupId,
      payload,
      segment_cursor: segments.length,
      created_at: now,
      updated_at: now
    });
    return {
      record: result.inserted,
      segments,
      stats
    };
  }

  const updated = await db.collection("transcripts").findOneAndUpdate(
    { _id: record._id },
    {
      $set: {
        payload,
        segment_cursor: segments.length,
        updated_at: now
      }
    },
    { upsert: false }
  );

  return {
    record: updated,
    segments,
    stats
  };
}

async function appendTranscriptSegment({ sessionId, groupId, segment }) {
  const { record, segments } = await getTranscriptBundle(sessionId, groupId);
  const updatedSegments = [...segments, segment];
  return persistTranscriptBundle({
    sessionId,
    groupId,
    segments: updatedSegments,
    record
  });
}

async function trimTranscriptSegments({ sessionId, groupId, record, segments, maxSegments = 100 }) {
  if (!Array.isArray(segments) || segments.length <= maxSegments) {
    return { record, segments };
  }

  const trimmed = segments.slice(-maxSegments);
  const result = await persistTranscriptBundle({
    sessionId,
    groupId,
    segments: trimmed,
    record
  });

  console.log(`🧹 Trimmed transcript history to last ${maxSegments} segments for group ${groupId}`);
  return result;
}

async function authenticateTeacher(req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    throw new Error('Missing bearer token');
  }
  const token = authHeader.replace('Bearer', '').trim();
  if (!token) {
    throw new Error('Missing bearer token');
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error) {
    throw new Error(error.message || 'Invalid token');
  }
  if (!data?.user) {
    throw new Error('User not found for token');
  }
  return data.user;
}

async function requireTeacher(req, res) {
  try {
    const user = await authenticateTeacher(req);
    req.teacher = user;
    return user;
  } catch (err) {
    console.warn(`🔒 Teacher authentication failed: ${err.message}`);
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
}

/* ---------- 1. Supabase ---------- */
const db = createSupabaseDb();

async function connectToDatabase() {
  try {
    console.log('📦 Connecting to Supabase...');
    const { error } = await supabase.from('sessions').select('id').limit(1);
    if (error && error.code !== 'PGRST116') {
      throw error;
    }
    console.log('📦 Supabase connected');

    // Seed default prompts for teachers (idempotent)
    await seedDefaultPrompts();
    
    // Start server after database connection
    const port = process.env.PORT || 10000;
    http.listen(port, () => {
      console.log(`🎯 Server running at http://localhost:${port}`);
    });
  } catch (error) {
    console.error('❌ Supabase connection failed:', error);
    process.exit(1);
  }
}

// Connect to database on startup
connectToDatabase();

/* ---------- 2. Express + Socket.IO ---------- */
const app = express();
app.use(express.static(path.join(__dirname, "public")));

// Setup multer for file uploads
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

const http = createServer(app);
const io   = new Server(http, { cors: { origin: "*" } });

/* Serve student and admin pages */
app.get("/student", (req, res) => {
  console.log("📚 Serving student page");
  res.sendFile(path.join(__dirname, "public", "student.html"));
});
app.get("/admin", (req, res) => {
  console.log("👨‍🏫 Serving admin page");
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});
// Removed unused static pages and test pages: /admin_static, /test-transcription, /test-recording, /history

/* Health check endpoint for Render deployment */
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: "2.0.0",
    features: ["transcription", "checkbox-mode", "mindmap-mode", "summary-mode"],
    environment: process.env.NODE_ENV || "development",
    port: process.env.PORT || 10000
  });
});

/* Test transcription API endpoint */
app.post("/api/test-transcription", upload.single('audio'), async (req, res) => {
  try {
    console.log("🧪 Test transcription request received");
    
    if (!req.file) {
      return res.status(400).json({ error: "No audio file provided" });
    }
    
    const audioBuffer = req.file.buffer;
    console.log(`📁 Received audio file: ${audioBuffer.length} bytes, mimetype: ${req.file.mimetype}`);
    
    // Test the transcription function
    const startTime = Date.now();
    const transcription = await transcribe(audioBuffer);
    const endTime = Date.now();
    
    const debug = {
      fileSize: audioBuffer.length,
      mimeType: req.file.mimetype,
      processingTime: `${endTime - startTime}ms`,
      timestamp: new Date().toISOString()
    };
    
    console.log(`✅ Test transcription completed in ${endTime - startTime}ms`);
    
    res.json({
      success: true,
      transcription,
      debug
    });
    
  } catch (err) {
    console.error("❌ Test transcription error:", err);
    res.status(500).json({ 
      error: "Transcription failed", 
      details: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});

/* Test summary API endpoint */
app.post("/api/test-summary", express.json(), async (req, res) => {
  try {
    console.log("🧪 Test summary request received");
    
    const { text, customPrompt } = req.body;
    if (!text) {
      return res.status(400).json({ error: "No text provided for summarization" });
    }
    
    console.log(`📝 Received text for summarization (${text.length} characters)`);
    
    // Test the summary function with custom prompt
    const startTime = Date.now();
    const summary = await summarise(text, customPrompt);
    const endTime = Date.now();
    
    const debug = {
      textLength: text.length,
      processingTime: `${endTime - startTime}ms`,
      timestamp: new Date().toISOString(),
      promptUsed: customPrompt || "default"
    };
    
    console.log(`✅ Test summary completed in ${endTime - startTime}ms`);
    
    res.json({
      success: true,
      summary,
      debug
    });
    
  } catch (err) {
    console.error("❌ Test summary error:", err);
    res.status(500).json({ 
      error: "Summary failed", 
      details: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});

/* Session prompt management endpoints */
app.post("/api/session/:code/prompt", express.json(), async (req, res) => {
  try {
    const teacher = await requireTeacher(req, res);
    if (!teacher) return;

    const { code } = req.params;
    const { prompt } = req.body;
    
    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: "Prompt is required" });
    }
    
    // Get session ID
    let session = await db.collection("sessions").findOne({ code: code });
    if (!session) {
      // Session might not be persisted yet - create a placeholder record
      const mem = activeSessions.get(code);
      if (!mem) {
        return res.status(404).json({ error: "Session not found" });
      }

      const newId = uuid();
      await db.collection("sessions").insertOne({
        _id: newId,
        owner_id: teacher.id,
        code: code,
        interval_ms: mem.interval || 30000,
        created_at: mem.created_at || Date.now(),
        active: mem.active || false,
        start_time: mem.startTime || null,
        end_time: null,
        total_duration_seconds: null
      });
      session = { _id: newId, owner_id: teacher.id };
      mem.ownerId = teacher.id;
      activeSessions.set(code, mem);
    } else if (session.owner_id !== teacher.id) {
      return res.status(403).json({ error: "Forbidden" });
    }
    
    // Do NOT cleanup transcripts/summaries on prompt save
    
    // Save prompt for this session
    await db.collection("session_prompts").findOneAndUpdate(
      { session_id: session._id },
      { $set: { prompt: prompt.trim(), updated_at: Date.now() } },
      { upsert: true }
    );

    // Also cache the current prompt in memory so subsequent summaries use it immediately
    const mem = activeSessions.get(code);
    if (mem) {
      activeSessions.set(code, { ...mem, customPrompt: prompt.trim() });
    }
    
    console.log(`💾 Saved custom prompt for session ${code}`);
    res.json({ success: true, message: "Prompt saved successfully" });
    
  } catch (err) {
    console.error("❌ Failed to save prompt:", err);
    res.status(500).json({ error: "Failed to save prompt" });
  }
});

app.get("/api/session/:code/prompt", async (req, res) => {
  try {
    const teacher = await requireTeacher(req, res);
    if (!teacher) return;

    const { code } = req.params;
    
    // Get session ID
    const session = await db.collection("sessions").findOne({ code: code });
    if (!session) {
      return res.json({ prompt: null, message: "No custom prompt set for this session" });
    }

    if (session.owner_id !== teacher.id) {
      return res.status(403).json({ error: "Forbidden" });
    }
    
    // Get prompt for this session
    const promptData = await db.collection("session_prompts").findOne({ session_id: session._id });
    
    if (promptData) {
      res.json({ 
        prompt: promptData.prompt,
        updatedAt: promptData.updated_at
      });
    } else {
      res.json({ 
        prompt: null,
        message: "No custom prompt set for this session"
      });
    }
    
  } catch (err) {
    console.error("❌ Failed to load prompt:", err);
    res.status(500).json({ error: "Failed to load prompt" });
  }
});

/* Prompt library management */
app.get("/api/prompt-library", async (req, res) => {
  try {
    const prompts = await db
      .collection("prompt_library")
      .find({})
      .sort({ name: 1 })
      .toArray();
    res.json(prompts);
  } catch (err) {
    console.error("❌ Failed to load prompt library:", err);
    res.status(500).json({ error: "Failed to load prompt library" });
  }
});

app.post("/api/prompt-library", express.json(), async (req, res) => {
  try {
    const { name, text } = req.body;
    if (!name || !text) {
      return res.status(400).json({ error: "Name and text are required" });
    }
    const result = await db
      .collection("prompt_library")
      .insertOne({ name: name.trim(), text: text.trim() });
    res.json({ _id: result.insertedId, name: name.trim(), text: text.trim() });
  } catch (err) {
    console.error("❌ Failed to save prompt to library:", err);
    res.status(500).json({ error: "Failed to save prompt" });
  }
});

app.put("/api/prompt-library/:id", express.json(), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, text } = req.body;
    if (!name && !text) {
      return res.status(400).json({ error: "Nothing to update" });
    }
    const update = {};
    if (name) update.name = name.trim();
    if (text) update.text = text.trim();
    await db
      .collection("prompt_library")
      .updateOne({ _id: id }, { $set: update });
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Failed to update prompt:", err);
    res.status(500).json({ error: "Failed to update prompt" });
  }
});

app.delete("/api/prompt-library/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await db.collection("prompt_library").deleteOne({ _id: id });
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Failed to delete prompt:", err);
    res.status(500).json({ error: "Failed to delete prompt" });
  }
});

/* Admin API: create new session */
app.get("/api/new-session", async (req, res) => {
  try {
    const teacher = await requireTeacher(req, res);
    if (!teacher) return;

    const id = uuid();
    const code = req.query.code || Math.floor(100000 + Math.random() * 900000).toString();
    const interval = Number(req.query.interval) || 30000;
    
    // Clear any existing session with same code (unlikely but safe)
    activeSessions.delete(code);
    
    // Store session in memory only - no database persistence until recording starts
    activeSessions.set(code, {
      id,
      code,
      active: false,
      interval,
      startTime: null,
      created_at: Date.now(),
      persisted: false, // Flag to track if saved to database
      ownerId: teacher.id
    });
    
    console.log(`🆕 New session created in memory: Code=${code}, Interval=${interval}ms (memory only)`);
    res.json({ code, interval });
  } catch (err) {
    console.error("❌ Failed to create session:", err);
    res.status(500).json({ error: "Failed to create session" });
  }
});

/* Get session status */
app.get("/api/session/:code/status", async (req, res) => {
  try {
    const teacher = await requireTeacher(req, res);
    if (!teacher) return;

    const code = req.params.code;
    const sessionState = activeSessions.get(code);
    
    if (!sessionState) {
      const existing = await db.collection("sessions").findOne({ code });
      if (!existing || existing.owner_id !== teacher.id) {
        return res.status(404).json({ error: "Session not found" });
      }
      return res.json(existing);
    }

    if (sessionState.ownerId && sessionState.ownerId !== teacher.id) {
      return res.status(403).json({ error: "Forbidden" });
    }
    
    console.log(`📋 Session ${code} found in memory`);
    res.json(sessionState);
  } catch (err) {
    console.error("❌ Failed to get session status:", err);
    res.status(500).json({ error: "Failed to get session status" });
  }
});

/* Admin API: start/stop session */
app.post("/api/session/:code/start", express.json(), async (req, res) => {
  try {
    const teacher = await requireTeacher(req, res);
    if (!teacher) return;

    const { interval } = req.body;
    const code = req.params.code;
    const startTime = Date.now();
    
    // Get session from memory
    const sessionState = activeSessions.get(code);
    if (!sessionState) {
      return res.status(404).json({ error: "Session not found in memory" });
    }

      if (sessionState.ownerId && sessionState.ownerId !== teacher.id) {
        return res.status(403).json({ error: "Forbidden" });
      }

      sessionState.ownerId = sessionState.ownerId || teacher.id;
    
    // Persist to database when recording actually starts (first time only)
    if (!sessionState.persisted) {
      // Check if session already exists in database (in case of server restart)
      const existingSession = await db.collection("sessions").findOne({ code: code });
      
      if (existingSession) {
        if (existingSession.owner_id !== teacher.id) {
          return res.status(403).json({ error: "Forbidden" });
        }
        // Session exists in database, just update it
        await db.collection("sessions").updateOne(
          { code: code },
          { $set: { 
            active: true, 
            interval_ms: interval || 30000,
            start_time: startTime,
            end_time: null,
            total_duration_seconds: null
          } }
        );
        
        // Update the session state with the existing database ID
        sessionState.id = existingSession._id;
        sessionState.persisted = true;
        sessionState.ownerId = teacher.id;
        console.log(`🔄 Session ${code} already exists in database, updated with ID: ${existingSession._id}`);
      } else {
        // Generate a new unique ID for database insertion
        const dbSessionId = uuid();
        
        await db.collection("sessions").insertOne({
          _id: dbSessionId,
          owner_id: teacher.id,
          code: code,
          interval_ms: interval || 30000,
          created_at: sessionState.created_at,
          active: true,
          start_time: startTime,
          end_time: null,
          total_duration_seconds: null
        });
        
        // Update the session state with the database ID
        sessionState.id = dbSessionId;
        sessionState.persisted = true;
        sessionState.ownerId = teacher.id;
        console.log(`💾 Session ${code} persisted to database on first start with ID: ${dbSessionId}`);
      }
    } else {
      // Update existing database record
      await db.collection("sessions").updateOne(
        { code: code, owner_id: teacher.id },
        { $set: { 
          active: true, 
          interval_ms: interval || 30000,
          start_time: startTime,
          end_time: null,
          total_duration_seconds: null
        } }
      );
      console.log(`🔄 Session ${code} updated in database`);
    }
    
    // Update memory state
    sessionState.active = true;
    sessionState.interval = interval || 30000;
    sessionState.startTime = startTime;

    // Notify all clients to reset their local state before recording starts
    io.to(code).emit("session_reset");

    io.to(code).emit("record_now", interval || 30000);

    // Reliability: continual retries until explicit client ack (recording_started) or timeout
    const mem = activeSessions.get(code);
    if (mem) {
      if (!mem.groups) mem.groups = new Map();
      // Configure retry scheduler (every 4s, up to 30s)
      if (mem.startRetryInterval) clearInterval(mem.startRetryInterval);
      mem.startRetryUntil = Date.now() + 30000;
      mem.active = true;
      mem.startRetryInterval = setInterval(() => {
        try {
          const current = activeSessions.get(code);
          if (!current || !current.groups || !current.active) {
            clearInterval(mem.startRetryInterval);
            return;
          }
          const pending = [];
          current.groups.forEach((state, grp) => {
            if (state?.joined && !state?.recording) pending.push(grp);
          });
          if (pending.length === 0 || Date.now() > current.startRetryUntil) {
            clearInterval(current.startRetryInterval);
            current.startRetryInterval = null;
            activeSessions.set(code, current);
            if (pending.length === 0) {
              console.log("✅ All groups acknowledged recording start");
            } else {
              console.log(`⏱️ Retry window ended. Pending groups without ack: [${pending.join(', ')}]`);
            }
            return;
          }
          console.log(`🔄 Re-emitting record_now to pending groups: [${pending.join(', ')}]`);
          pending.forEach(grp => io.to(`${code}-${grp}`).emit("record_now", interval || 30000));
        } catch (e) {
          console.warn("⚠️ record_now scheduler error:", e.message);
        }
      }, 4000);
      activeSessions.set(code, mem);
    }
    
    console.log(`▶️  Session ${code} started recording (interval: ${interval || 30000}ms)`);
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Failed to start session:", err);
    res.status(500).json({ error: "Failed to start session" });
  }
});

app.post("/api/session/:code/stop", async (req, res) => {
  try {
    const teacher = await requireTeacher(req, res);
    if (!teacher) return;

    const code = req.params.code;
    const endTime = Date.now();
    
    // Get session from memory
    const sessionState = activeSessions.get(code);
    if (!sessionState) {
      return res.status(404).json({ error: "Session not found in memory" });
    }

    if (sessionState.ownerId && sessionState.ownerId !== teacher.id) {
      return res.status(403).json({ error: "Forbidden" });
    }
    
    // Only update database if session was persisted (i.e., recording was started)
    if (sessionState.persisted) {
      // Calculate total duration in seconds
      const totalDurationSeconds = sessionState.startTime ? 
        Math.floor((endTime - sessionState.startTime) / 1000) : 0;
      
      await db.collection("sessions").updateOne(
        { code: code, owner_id: teacher.id },
        { $set: { 
          active: false,
          end_time: endTime,
          total_duration_seconds: totalDurationSeconds
        } }
      );
      
      console.log(`💾 Session ${code} stopped and saved to database (duration: ${totalDurationSeconds}s)`);
    } else {
      console.log(`⏹️  Session ${code} stopped (was never persisted to database)`);
    }
    
    // Update memory state
    sessionState.active = false;
    sessionState.startTime = null;
    if (sessionState.startRetryInterval) {
      clearInterval(sessionState.startRetryInterval);
      sessionState.startRetryInterval = null;
    }
    
    io.to(code).emit("stop_recording");
    
    console.log(`⏹️  Session ${code} stopped recording`);
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Failed to stop session:", err);
    res.status(500).json({ error: "Failed to stop session" });
  }
});

/* Admin API: get transcripts for a specific group */
app.get("/api/transcripts/:code/:number", async (req, res) => {
  try {
    const teacher = await requireTeacher(req, res);
    if (!teacher) return;

    const { code, number } = req.params;
    console.log(`📝 Fetching transcripts for session ${code}, group ${number}`);
    
    // Get session and group IDs
    const session = await db.collection("sessions").findOne({ code: code });
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    if (session.owner_id !== teacher.id) {
      return res.status(403).json({ error: "Forbidden" });
    }
    
    const group = await db.collection("groups").findOne({ session_id: session._id, number: parseInt(number) });
    if (!group) {
      return res.status(404).json({ error: "Group not found" });
    }
    
    // Get aggregated transcripts for this group
    const { segments, stats } = await getTranscriptBundle(session._id, group._id);
    const transcripts = [...segments].reverse().map((segment) => ({
      id: segment.id,
      text: segment.text,
      word_count: segment.word_count,
      duration_seconds: segment.duration_seconds,
      segment_number: segment.segment_number,
      is_noise: segment.is_noise,
      created_at: segment.created_at
    }));
    
    // Get the latest summary
    const summary = await db.collection("summaries").findOne({ group_id: group._id });
    
    res.json({
      transcripts: transcripts.map((t) => ({
        ...t,
        created_at: t.created_at ? new Date(t.created_at).toISOString() : null
      })),
      summary: summary || { text: "No summary available", updated_at: null },
      stats: {
        totalSegments: stats.total_segments,
        totalWords: stats.total_words,
        totalDuration: stats.total_duration,
        lastUpdate: stats.last_update ? new Date(stats.last_update).toISOString() : null
      }
    });
    
  } catch (err) {
    console.error("❌ Failed to fetch transcripts:", err);
    res.status(500).json({ error: "Failed to fetch transcripts" });
  }
});

/* Admin API: get historical data */
app.get("/api/history", async (req, res) => {
  try {
    const teacher = await requireTeacher(req, res);
    if (!teacher) return;

    const { 
      sessionCode, 
      startDate, 
      endDate, 
      limit = 50, 
      offset = 0,
      includeTranscripts = 'true',
      includeSummaries = 'true'
    } = req.query;
    
    console.log(`📊 Fetching historical data with filters:`, { sessionCode, startDate, endDate, limit, offset });
    
    // Get sessions with basic info
    const sessionQuery = { owner_id: teacher.id };
    if (sessionCode) {
      sessionQuery.code = sessionCode;
    }
    let sessions = await db.collection("sessions")
      .find(sessionQuery)
      .sort({ created_at: -1 })
      .skip(parseInt(offset))
      .limit(parseInt(limit))
      .toArray();

    if (startDate || endDate) {
      const startMs = startDate ? new Date(startDate).getTime() : null;
      const endMs = endDate ? new Date(endDate).getTime() : null;
      sessions = sessions.filter((s) => {
        const created = s.created_at;
        if (startMs && created < startMs) return false;
        if (endMs && created > endMs) return false;
        return true;
      });
    }
    
    const result = {
      sessions: await Promise.all(sessions.map(async s => {
        // Calculate current duration for active sessions
        let currentDuration = s.total_duration_seconds || 0;
        if (s.active && s.start_time) {
          currentDuration = Math.floor((Date.now() - s.start_time) / 1000);
        }
        
        return {
          ...s,
          created_at: new Date(s.created_at).toISOString(),
          interval_seconds: s.interval_ms / 1000,
          current_duration_seconds: currentDuration,
          groups: []
        };
      })),
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: sessions.length === parseInt(limit)
      }
    };
    
    // For each session, get detailed group data if requested
    if (includeTranscripts === 'true' || includeSummaries === 'true') {
      for (const session of result.sessions) {
        // Get groups for this session
        const groups = await db.collection("groups").find({ session_id: session._id }).sort({ number: 1 }).toArray();
        
        for (const group of groups) {
          const groupData = {
            number: group.number,
            transcripts: [],
            summary: null,
            stats: {
              totalSegments: 0,
              totalWords: 0,
              totalDuration: 0
            }
          };
          
          if (includeTranscripts === 'true') {
            const { segments, stats } = await getTranscriptBundle(session._id, group._id);
            groupData.transcripts = segments.map((segment) => ({
              ...segmentToTranscript(segment),
              created_at: segment.created_at ? new Date(segment.created_at).toISOString() : null
            }));
            groupData.stats = {
              totalSegments: stats.total_segments,
              totalWords: stats.total_words,
              totalDuration: stats.total_duration,
              lastUpdate: stats.last_update ? new Date(stats.last_update).toISOString() : null
            };
          }
          
          if (includeSummaries === 'true') {
            // Get summary for this group
            const summary = await db.collection("summaries").findOne({ group_id: group._id });
            
            if (summary) {
              groupData.summary = {
                text: summary.text,
                updated_at: new Date(summary.updated_at).toISOString()
              };
            }
          }
          
          session.groups.push(groupData);
        }
      }
    }
    
    // After all groups are pushed to session.groups in /api/history:
    for (const session of result.sessions) {
      session.group_count = session.groups.length;
      session.total_transcripts = session.groups.reduce((sum, g) => sum + (g.stats?.totalSegments || 0), 0);
      session.total_words = session.groups.reduce((sum, g) => sum + (g.stats?.totalWords || 0), 0);
      // Use actual session duration (current for active sessions, total for completed)
      session.total_duration = session.current_duration_seconds || 0;
    }
    
    res.json(result);
    
  } catch (err) {
    console.error("❌ Failed to fetch historical data:", err);
    res.status(500).json({ error: "Failed to fetch historical data" });
  }
});

/* Admin API: get specific session details */
app.get("/api/history/session/:code", async (req, res) => {
  try {
    const teacher = await requireTeacher(req, res);
    if (!teacher) return;

    const { code } = req.params;
    console.log(`📋 Fetching detailed data for session: ${code}`);
    
    // Get session info
    const session = await db.collection("sessions").findOne({ code: code });
    
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    if (session.owner_id !== teacher.id) {
      return res.status(403).json({ error: "Forbidden" });
    }
    
    // Get all groups for this session
    const groups = await db.collection("groups").find({ session_id: session._id }).sort({ number: 1 }).toArray();
    
    const result = {
      session: {
        ...session,
        created_at: new Date(session.created_at).toISOString(),
        interval_seconds: session.interval_ms / 1000
      },
      groups: []
    };
    
    for (const group of groups) {
      const { segments, stats } = await getTranscriptBundle(session._id, group._id);

      // Get summary
      const summary = await db.collection("summaries").findOne({ group_id: group._id });
      
      const transcripts = segments.map((segment) => ({
        ...segmentToTranscript(segment),
        created_at: segment.created_at ? new Date(segment.created_at).toISOString() : null
      }));

      const groupData = {
        number: group.number,
        transcripts,
        summary: summary ? {
          text: summary.text,
          updated_at: new Date(summary.updated_at).toISOString()
        } : null,
        stats: {
          totalSegments: stats.total_segments,
          totalWords: stats.total_words,
          totalDuration: stats.total_duration,
          firstTranscript: transcripts.length > 0 ? transcripts[0].created_at : null,
          lastTranscript: transcripts.length > 0 ? transcripts[transcripts.length - 1].created_at : null
        }
      };
      
      result.groups.push(groupData);
    }
    
    res.json(result);
    
  } catch (err) {
    console.error("❌ Failed to fetch session details:", err);
    res.status(500).json({ error: "Failed to fetch session details" });
  }
});

/* Admin API: delete multiple sessions */
app.delete("/api/history/sessions", express.json(), async (req, res) => {
  try {
    const teacher = await requireTeacher(req, res);
    if (!teacher) return;

    const { sessionIds } = req.body;
    
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      return res.status(400).json({ error: "Invalid session IDs provided" });
    }
    
    console.log(`🗑️  Deleting ${sessionIds.length} sessions:`, sessionIds);
    
    // Get session details first for cleanup
    const sessions = await db.collection("sessions").find({ _id: { $in: sessionIds }, owner_id: teacher.id }).toArray();
    
    if (sessions.length === 0) {
      return res.status(404).json({ error: "No sessions found to delete" });
    }
    
    // Delete related data for each session
    for (const session of sessions) {
      const groups = await db.collection("groups").find({ session_id: session._id }).toArray();
      const groupIds = groups.map(g => g._id);
      
      if (groupIds.length > 0) {
        // Delete transcripts, summaries for all groups
        await db.collection("transcripts").deleteMany({ group_id: { $in: groupIds } });
        await db.collection("summaries").deleteMany({ group_id: { $in: groupIds } });
        
        // Delete groups
        await db.collection("groups").deleteMany({ session_id: session._id });
      }
      
      // Delete session prompts
      await db.collection("session_prompts").deleteMany({ session_id: session._id });
      
      // Delete mindmap related data
      await db.collection("mindmap_sessions").deleteMany({ session_id: session._id });
      await db.collection("mindmap_nodes").deleteMany({ session_id: session._id });
      
      // Delete checkbox related data
      await db.collection("checkbox_sessions").deleteMany({ session_id: session._id });
      await db.collection("checkbox_criteria").deleteMany({ session_id: session._id });
      await db.collection("checkbox_progress").deleteMany({ session_id: session._id });
      
      // Delete session logs
      await db.collection("session_logs").deleteMany({ session_id: session._id });
      
      console.log(`🧹 Cleaned up data for session ${session.code}`);
    }
    
    // Delete the sessions themselves
    const deleteResult = await db.collection("sessions").deleteMany({ _id: { $in: sessionIds }, owner_id: teacher.id });
    
    console.log(`✅ Deleted ${deleteResult.deletedCount} sessions successfully`);
    
    res.json({ 
      success: true, 
      deletedCount: deleteResult.deletedCount,
      message: `Successfully deleted ${deleteResult.deletedCount} sessions and their related data`
    });
    
  } catch (err) {
    console.error("❌ Failed to delete sessions:", err);
    res.status(500).json({ error: "Failed to delete sessions" });
  }
});

/* ---------- Mindmap Mode API Endpoints ---------- */

/* Create mindmap session */
app.post("/api/mindmap/session", express.json(), async (req, res) => {
  try {
    const teacher = await requireTeacher(req, res);
    if (!teacher) return;

    const { sessionCode, mainTopic, interval = 30000 } = req.body;
    
    if (!sessionCode || !mainTopic) {
      return res.status(400).json({ error: "Session code and main topic required" });
    }
    
    console.log(`🧠 Creating mindmap session: ${sessionCode} with topic: ${mainTopic}`);
    
    const now = Date.now();
    const existingSession = await db.collection("sessions").findOne({ code: sessionCode });
    
    if (existingSession && existingSession.owner_id && existingSession.owner_id !== teacher.id) {
      return res.status(403).json({ error: "Session owned by another teacher" });
    }

    const sessionId = existingSession?._id || uuid();

    if (!existingSession) {
      await db.collection("sessions").insertOne({
        _id: sessionId,
        owner_id: teacher.id,
        code: sessionCode,
        mode: "mindmap",
        interval_ms: interval,
        active: true,
        main_topic: mainTopic,
        created_at: now,
        start_time: now,
        end_time: null,
        metadata: {},
        strictness: 2
      });
    } else {
      await db.collection("sessions").updateOne(
        { _id: existingSession._id },
        {
          $set: {
            owner_id: teacher.id,
            mode: "mindmap",
            main_topic: mainTopic,
            interval_ms: interval,
            active: true,
            start_time: now,
            end_time: null,
            updated_at: now
          }
        }
      );
    }
    
    const mindmapSession = await db.collection("mindmap_sessions").findOne({ session_id: sessionId });
    if (!mindmapSession) {
      await db.collection("mindmap_sessions").insertOne({
        _id: uuid(),
        session_id: sessionId,
        main_topic: mainTopic,
        current_mindmap: null,
        chat_history: [],
        created_at: now
      });
    } else {
      await db.collection("mindmap_sessions").updateOne(
        { session_id: sessionId },
        {
          $set: {
            main_topic: mainTopic
          }
        }
      );
    }
    
    activeSessions.set(sessionCode, {
      id: sessionId,
      code: sessionCode,
      mode: "mindmap",
      ownerId: teacher.id,
      active: true,
      interval,
      startTime: now,
      created_at: existingSession?.created_at ?? now,
      persisted: true
    });
    
    res.json({ 
      success: true, 
      sessionId,
      message: "Mindmap session created successfully" 
    });
    
  } catch (err) {
    console.error("❌ Failed to create mindmap session:", err);
    res.status(500).json({ error: err.message || "Failed to create mindmap session" });
  }
});

/* Generate initial mindmap from text */
app.post("/api/mindmap/generate", express.json(), async (req, res) => {
  try {
    const teacher = await requireTeacher(req, res);
    if (!teacher) return;

    const { sessionCode, text } = req.body;
    
    if (!sessionCode || !text) {
      return res.status(400).json({ error: "Session code and text required" });
    }
    
    console.log(`🧠 Generating initial mindmap for session: ${sessionCode}`);
    
    // Get session info
    const session = await db.collection("sessions").findOne({ code: sessionCode, mode: "mindmap" });
    if (!session) {
      return res.status(404).json({ error: "Mindmap session not found" });
    }
    if (session.owner_id !== teacher.id) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (session.owner_id !== teacher.id) {
      return res.status(403).json({ error: "Forbidden" });
    }
    
    // Generate mindmap using AI
    const mindmapData = await generateInitialMindmap(text, session.main_topic);
    
    // Store the generated mindmap
    await db.collection("mindmap_sessions").updateOne(
      { session_id: session._id },
      { 
        $set: { current_mindmap: mindmapData },
        $push: { 
          chat_history: {
            type: 'user',
            content: text,
            timestamp: Date.now()
          }
        }
      }
    );
    
    // Log the processing
    await db.collection("session_logs").insertOne({
      _id: uuid(),
      session_id: session._id,
      type: "mindmap_generated",
      content: text,
      ai_response: { action: "generate", data: mindmapData },
      created_at: Date.now()
    });
    
    res.json({
      success: true,
      data: mindmapData,
      message: "Initial mindmap generated successfully"
    });
    
  } catch (err) {
    console.error("❌ Failed to generate mindmap:", err);
    res.status(500).json({ error: "Failed to generate mindmap" });
  }
});

/* Expand existing mindmap with new information */
app.post("/api/mindmap/expand", express.json(), async (req, res) => {
  try {
    const teacher = await requireTeacher(req, res);
    if (!teacher) return;

    const { sessionCode, text } = req.body;
    
    if (!sessionCode || !text) {
      return res.status(400).json({ error: "Session code and text required" });
    }
    
    console.log(`🧠 Expanding mindmap for session: ${sessionCode}`);
    
    // Get session and current mindmap
    const session = await db.collection("sessions").findOne({ code: sessionCode, mode: "mindmap" });
    if (!session) {
      return res.status(404).json({ error: "Mindmap session not found" });
    }
    if (session.owner_id !== teacher.id) {
      return res.status(403).json({ error: "Forbidden" });
    }
    
    const mindmapSession = await db.collection("mindmap_sessions").findOne({ session_id: session._id });
    if (!mindmapSession || !mindmapSession.current_mindmap) {
      return res.status(400).json({ error: "No existing mindmap found. Generate initial mindmap first." });
    }
    
    // Expand mindmap using AI
    const result = await expandMindmap(text, mindmapSession.current_mindmap, session.main_topic);
    
    // Store the updated mindmap and chat history
    await db.collection("mindmap_sessions").updateOne(
      { session_id: session._id },
      { 
        $set: { current_mindmap: result.updatedMindmap },
        $push: { 
          chat_history: {
            type: 'user',
            content: text,
            timestamp: Date.now()
          }
        }
      }
    );
    
    // Log the processing
    await db.collection("session_logs").insertOne({
      _id: uuid(),
      session_id: session._id,
      type: "mindmap_expanded",
      content: text,
      ai_response: { action: "expand", explanation: result.explanation, data: result.updatedMindmap },
      created_at: Date.now()
    });
    
    res.json({
      success: true,
      data: result.updatedMindmap,
      message: result.explanation,
      rawAiResponse: result.rawResponse // For collapsible display
    });
    
  } catch (err) {
    console.error("❌ Failed to expand mindmap:", err);
    res.status(500).json({ error: err.message || "Failed to expand mindmap" });
  }
});

/* Process transcript for mindmap (for recording mode) */
app.post("/api/mindmap/process", express.json(), async (req, res) => {
  try {
    const teacher = await requireTeacher(req, res);
    if (!teacher) return;

    const { sessionCode, transcript } = req.body;
    
    if (!sessionCode || !transcript) {
      return res.status(400).json({ error: "Session code and transcript required" });
    }
    
    console.log(`🧠 Processing transcript for mindmap session: ${sessionCode}`);
    
    // Get session and current mindmap
    const session = await db.collection("sessions").findOne({ code: sessionCode, mode: "mindmap" });
    if (!session) {
      return res.status(404).json({ error: "Mindmap session not found" });
    }
    if (session.owner_id !== teacher.id) {
      return res.status(403).json({ error: "Forbidden" });
    }
    
    const mindmapSession = await db.collection("mindmap_sessions").findOne({ session_id: session._id });
    if (!mindmapSession) {
      return res.status(404).json({ error: "Mindmap session details not found" });
    }
    
    let result;
    
    // If no current mindmap, generate initial one
    if (!mindmapSession.current_mindmap) {
      console.log(`🧠 No existing mindmap, generating initial one...`);
      const mindmapData = await generateInitialMindmap(transcript, session.main_topic);
      
      await db.collection("mindmap_sessions").updateOne(
        { session_id: session._id },
        { 
          $set: { current_mindmap: mindmapData },
          $push: {
            chat_history: {
              type: 'auto',
              content: transcript,
              timestamp: Date.now()
            }
          }
        }
      );
      
      result = {
        success: true,
        action: "generate",
        data: mindmapData,
        message: "Initial mindmap generated from transcript"
      };
    } else {
      // Expand existing mindmap
      console.log(`🧠 Expanding existing mindmap...`);
      const expansion = await expandMindmap(transcript, mindmapSession.current_mindmap, session.main_topic);
      
      await db.collection("mindmap_sessions").updateOne(
        { session_id: session._id },
        { 
          $set: { current_mindmap: expansion.updatedMindmap },
          $push: {
            chat_history: {
              type: 'auto',
              content: transcript,
              timestamp: Date.now()
            }
          }
        }
      );
      
      result = {
        success: true,
        action: "expand", 
        data: expansion.updatedMindmap,
        message: expansion.explanation
      };
    }
    
    // Log the processing
    await db.collection("session_logs").insertOne({
      _id: uuid(),
      session_id: session._id,
      type: result.action === "generate" ? "transcript_generated" : "transcript_expanded",
      content: transcript,
      ai_response: result,
      created_at: Date.now()
    });
    
    res.json(result);
    
  } catch (err) {
    console.error("❌ Failed to process mindmap transcript:", err);
    res.status(500).json({ error: err.message || "Failed to process transcript" });
  }
});

/* Get mindmap data */
app.get("/api/mindmap/:sessionCode", async (req, res) => {
  try {
    const teacher = await requireTeacher(req, res);
    if (!teacher) return;

    const { sessionCode } = req.params;
    
    console.log(`🧠 Fetching mindmap data for session: ${sessionCode}`);
    
    // Get session info
    const session = await db.collection("sessions").findOne({ code: sessionCode, mode: "mindmap" });
    if (!session) {
      return res.status(404).json({ error: "Mindmap session not found" });
    }
    if (session.owner_id !== teacher.id) {
      return res.status(403).json({ error: "Forbidden" });
    }

    // Get mindmap session details
    const mindmapSession = await db.collection("mindmap_sessions").findOne({ session_id: session._id });
    if (!mindmapSession) {
      return res.status(404).json({ error: "Mindmap session details not found" });
    }

    // Get session logs
    const logs = await db.collection("session_logs")
      .find({ session_id: session._id })
      .sort({ created_at: 1 })
      .toArray();

    res.json({
      success: true,
      data: mindmapSession.current_mindmap,
      mainTopic: mindmapSession.main_topic,
      chatHistory: mindmapSession.chat_history || [],
      logs: logs
    });
    
  } catch (err) {
    console.error("❌ Failed to fetch mindmap data:", err);
    res.status(500).json({ error: err.message || "Failed to fetch mindmap data" });
  }
});

/* Save mindmap session with metadata */
app.post("/api/mindmap/save", express.json(), async (req, res) => {
  try {
    const teacher = await requireTeacher(req, res);
    if (!teacher) return;

    const { sessionCode, mainTopic, startTime, endTime, duration, durationFormatted, 
            nodeCount, speechInputs, mindmapData, chatHistory, version, savedAt } = req.body;
    
    if (!sessionCode || !mainTopic || !mindmapData) {
      return res.status(400).json({ error: "Session code, main topic, and mindmap data required" });
    }
    
    console.log(`🧠 Saving mindmap session: ${sessionCode} with metadata`);
    
    // Get session info
    const session = await db.collection("sessions").findOne({ code: sessionCode, mode: "mindmap" });
    if (!session) {
      return res.status(404).json({ error: "Mindmap session not found" });
    }
    if (session.owner_id !== teacher.id) {
      return res.status(403).json({ error: "Forbidden" });
    }

    // Create comprehensive session archive
    const sessionArchive = {
      _id: uuid(),
      session_id: session._id,
      session_code: sessionCode,
      main_topic: mainTopic,
      start_time: new Date(startTime),
      end_time: new Date(endTime),
      duration_seconds: duration,
      duration_formatted: durationFormatted,
      node_count: nodeCount,
      speech_inputs: speechInputs,
      mindmap_data: mindmapData,
      chat_history: chatHistory || [],
      version: version || "1.0",
      saved_at: new Date(savedAt),
      created_at: Date.now()
    };

    // Save to archived sessions collection
    await db.collection("mindmap_archives").insertOne(sessionArchive);

    // Update the main session with final metadata
    await db.collection("sessions").updateOne(
      { _id: session._id },
      { 
        $set: { 
          end_time: Date.now(),
          archived: true,
          final_node_count: nodeCount,
          final_duration: duration
        }
      }
    );

    // Update mindmap session with final data
    await db.collection("mindmap_sessions").updateOne(
      { session_id: session._id },
      { 
        $set: { 
          current_mindmap: mindmapData,
          chat_history: chatHistory || [],
          archived_at: Date.now(),
          final_metadata: {
            duration: duration,
            nodeCount: nodeCount,
            speechInputs: speechInputs
          }
        }
      }
    );

    res.json({
      success: true,
      archiveId: sessionArchive._id,
      message: "Session saved successfully with metadata"
    });
    
  } catch (err) {
    console.error("❌ Failed to save mindmap session:", err);
    res.status(500).json({ error: "Failed to save mindmap session" });
  }
});

// AI Functions for hierarchical mindmap processing
async function generateInitialMindmap(contextualText, mainTopic) {
  if (!groqClient) {
    throw new Error("Mindmap generation unavailable: GROQ_API_KEY not configured.");
  }

  try {
    console.log(`🧠 Groq Mindmap: Generating initial academic mindmap for topic: "${mainTopic}"`);

    const completion = await groqClient.chat.completions.create({
      model: "openai/gpt-oss-120b",
      temperature: 0,
      top_p: 1,
      max_completion_tokens: 2048,
      reasoning_effort: "low",
      response_format: { type: "json_object" },
      stream: false,
      messages: [
        {
          role: "system",
          content: "You transform noisy classroom transcripts into structured JSON mindmaps. Respond only with JSON."
        },
        {
          role: "user",
          content: `
Create an academic mindmap based on the classroom transcript below.

TOPIC: ${mainTopic}

TRANSCRIPT:
${contextualText}

Return JSON with this exact shape:
{
  "topic": "${mainTopic}",
  "version": "${new Date().toISOString()}",
  "nodes": [
    { "id": "uuid", "parent_id": null, "label": "main point", "type": "main" },
    { "id": "uuid", "parent_id": "uuid", "label": "supporting detail", "type": "sub" },
    { "id": "uuid", "parent_id": "uuid", "label": "example or evidence", "type": "example" }
  ],
  "message": "optional note when no content"
}

Rules:
- Depth ≤ 3.
- Remove filler/noise.
- Preserve technical terms; paraphrase general phrasing.
- Use valid UUIDs for every id.
- If there is no meaningful content, return an empty "nodes" array and add a helpful "message".
`
        }
      ]
    });

    const responseText = completion.choices?.[0]?.message?.content?.trim();
    if (!responseText) {
      throw new Error("Groq returned an empty response.");
    }

    let parsed;
    try {
      parsed = JSON.parse(responseText);
    } catch (err) {
      console.error("❌ Groq mindmap JSON parse error:", err);
      throw new Error("Failed to parse Groq mindmap response.");
    }

    if (!parsed.nodes || parsed.nodes.length === 0) {
      console.log("⚠️ Groq Mindmap: No meaningful academic content detected");
      return {
        name: mainTopic,
        children: []
      };
    }

    const convertedResult = convertMaestroToLegacy(parsed, mainTopic);
    return convertedResult;
  } catch (error) {
    console.error("❌ Failed to generate mindmap via Groq:", error);
    throw error;
  }
}

// Convert Mind-Map Maestro format to our legacy hierarchical format
function convertMaestroToLegacy(maestroData, mainTopic) {
  const legacy = {
    name: mainTopic,
    children: []
  };
  
  // Group nodes by parent_id
  const nodeMap = {};
  const rootNodes = [];
  
  maestroData.nodes.forEach(node => {
    nodeMap[node.id] = {
      name: node.label,
      children: [],
      type: node.type,
      id: node.id
    };
    
    if (node.parent_id === null) {
      rootNodes.push(nodeMap[node.id]);
    }
  });
  
  // Build hierarchy
  maestroData.nodes.forEach(node => {
    if (node.parent_id !== null && nodeMap[node.parent_id]) {
      nodeMap[node.parent_id].children.push(nodeMap[node.id]);
    }
  });
  
  // Add root nodes as children of main topic
  legacy.children = rootNodes;
  
  console.log(`✅ Mind-Map Maestro: Converted ${maestroData.nodes.length} nodes to legacy format`);
  return legacy;
}

async function expandMindmap(contextualText, currentMindmap, mainTopic) {
  if (!groqClient) {
    throw new Error("Mindmap expansion unavailable: GROQ_API_KEY not configured.");
  }

  try {
    console.log(`🧠 Groq Mindmap: Expanding mindmap for topic "${mainTopic}"`);
    
    // Convert current mindmap to Maestro format for processing
    const currentMaestroFormat = convertLegacyToMaestro(currentMindmap, mainTopic);
    
    const completion = await groqClient.chat.completions.create({
      model: "openai/gpt-oss-120b",
      temperature: 0,
      top_p: 1,
      max_completion_tokens: 2048,
      reasoning_effort: "low",
      response_format: { type: "json_object" },
      stream: false,
      messages: [
        {
          role: "system",
          content: "You expand classroom mindmaps. Append new nodes without deleting existing ones. Reply with JSON only."
        },
        {
          role: "user",
          content: `
TOPIC: ${mainTopic}

CURRENT MINDMAP (JSON):
${JSON.stringify(currentMaestroFormat, null, 2)}

NEW TRANSCRIPT CHUNK:
${contextualText}

Task: Add only genuinely new academic ideas to the existing mindmap. Never delete or rename existing nodes.

Return JSON:
{
  "action": "ignore|expand",
  "topic": "${mainTopic}",
  "version": "${new Date().toISOString()}",
  "nodes": [ ...all existing nodes plus any new ones... ],
  "explanation": "brief natural language summary"
}

Rules:
- Deduplicate ideas already present.
- Depth ≤ 3.
- Use UUIDs for new nodes.
- If no useful content, set "action": "ignore" and keep nodes unchanged.
`
        }
      ]
    });

    const responseText = completion.choices?.[0]?.message?.content?.trim();
    if (!responseText) {
      throw new Error("Groq returned an empty response.");
    }

    let result;
    try {
      result = JSON.parse(responseText);
    } catch (err) {
      console.error("❌ Groq mindmap expansion parse error:", err);
      throw new Error("Failed to parse Groq expansion response.");
    }

    if (result.action === "ignore") {
      console.log("⚠️ Groq Mindmap: Current chunk contained no new academic content");
      return {
        updatedMindmap: currentMindmap, // Return unchanged mindmap
        explanation: result.explanation || 'Content filtered out: no academic value',
        rawResponse: responseText,
        filtered: true
      };
    }

    // Convert result back to legacy format
    const updatedLegacyFormat = convertMaestroToLegacy(result, mainTopic);

    console.log(`✅ Groq Mindmap: Expansion processed with ${result.nodes.length} total nodes`);

    return {
      updatedMindmap: updatedLegacyFormat,
      explanation: result.explanation || 'Academic mindmap updated successfully',
      rawResponse: responseText,
      filtered: false
    };
    
  } catch (error) {
    console.error("❌ Failed to expand mindmap via Groq:", error);
    throw error;
  }
}

// Convert legacy hierarchical format to Mind-Map Maestro format
function convertLegacyToMaestro(legacyData, mainTopic) {
  const maestro = {
    topic: mainTopic,
    version: new Date().toISOString(),
    nodes: []
  };
  
  let nodeCounter = 0;
  
  function addNode(node, parentId = null, depth = 0) {
    const nodeId = `node-${nodeCounter++}`;
    let nodeType = 'main';
    
    if (depth === 1) nodeType = 'main';
    else if (depth === 2) nodeType = 'sub';
    else if (depth >= 3) nodeType = 'example';
    
    // Don't add the root node itself, only its children
    if (node.name !== mainTopic) {
      maestro.nodes.push({
        id: nodeId,
        parent_id: parentId,
        label: node.name,
        type: nodeType
      });
    }
    
    // Process children
    if (node.children && node.children.length > 0) {
      node.children.forEach(child => {
        addNode(child, node.name === mainTopic ? null : nodeId, depth + 1);
      });
    }
  }
  
  addNode(legacyData);
  return maestro;
}


app.post("/api/mindmap/examples", express.json(), async (req, res) => {
  try {
    if (!groqClient) {
      return res.status(500).json({ error: 'Groq client not configured' });
    }

    const { topic, nodeLabel, siblingIdeas = [], childIdeas = [] } = req.body || {};

    if (!nodeLabel) {
      return res.status(400).json({ error: 'nodeLabel is required' });
    }

    const prompt = `You are a teaching assistant who suggests concise mindmap ideas.
TOPIC: ${topic || 'Unknown Topic'}
NODE: ${nodeLabel}
RELATED SIBLINGS: ${siblingIdeas.join('; ') || 'None'}
ALREADY DISCUSSED CHILDREN: ${childIdeas.join('; ') || 'None'}
Provide 3-5 short example ideas (max 12 words each) that could extend this node. Reply as JSON in the shape {\"examples\":[\"idea 1\", ...]}. Do not include explanations.`;

    const completion = await groqClient.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      temperature: 0.4,
      top_p: 1,
      max_completion_tokens: 512,
      reasoning_effort: 'low',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'You generate structured JSON for mindmap brainstorming. Keep suggestions concise and educational.'
        },
        {
          role: 'user',
          content: prompt
        }
      ]
    });

    const raw = completion.choices?.[0]?.message?.content?.trim() || '{}';
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      console.warn('Groq JSON parse error:', parseErr, raw);
      return res.json({ examples: [], raw });
    }

    const examples = Array.isArray(parsed.examples) ? parsed.examples.filter(Boolean).slice(0, 5) : [];
    res.json({ examples, raw });
  } catch (error) {
    console.error('❌ Groq example generation failed:', error);
    res.status(500).json({ error: 'Failed to generate examples' });
  }
});

/* Generate examples for mindmap playground */
app.post("/api/generate-examples", express.json(), async (req, res) => {
  try {
    if (!groqClient) {
      return res.status(500).json({ error: 'Groq client not configured' });
    }

    const { topic, count = 2 } = req.body;
    if (!topic) {
      return res.status(400).json({ error: 'Topic is required' });
    }

    const prompt = `Generate ${count} concise example ideas related to "${topic}". Each example should be a short phrase (max 8 words). Return as a JSON array of strings.`;

    const completion = await groqClient.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      temperature: 0.6,
      max_completion_tokens: 200,
      messages: [
        {
          role: 'system',
          content: 'You generate concise educational examples. Return only a JSON array of strings.'
        },
        {
          role: 'user',
          content: prompt
        }
      ]
    });

    const raw = completion.choices?.[0]?.message?.content?.trim() || '[]';
    let examples;
    try {
      examples = JSON.parse(raw);
    } catch (parseErr) {
      console.warn('Groq JSON parse error:', parseErr, raw);
      examples = [`Example 1 for ${topic}`, `Example 2 for ${topic}`, `Example 3 for ${topic}`];
    }

    if (!Array.isArray(examples)) {
      examples = [`Example 1 for ${topic}`, `Example 2 for ${topic}`, `Example 3 for ${topic}`];
    }

    res.json(examples);
  } catch (error) {
    console.error('❌ Groq example generation failed:', error);
    res.status(500).json({ error: 'Failed to generate examples' });
  }
});

/* Generate a single point for mindmap playground */
app.post("/api/generate-point", express.json(), async (req, res) => {
  try {
    if (!groqClient) {
      return res.status(500).json({ error: 'Groq client not configured' });
    }

    const { topic } = req.body;
    if (!topic) {
      return res.status(400).json({ error: 'Topic is required' });
    }

    const prompt = `Generate a single, concise point or idea related to "${topic}". It should be a short phrase (max 8 words) that could be a sub-topic or supporting detail. Return just the phrase, no quotes or extra text.`;

    const completion = await groqClient.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      temperature: 0.7,
      max_completion_tokens: 50,
      messages: [
        {
          role: 'system',
          content: 'You generate concise educational points. Return only the phrase, no quotes or explanations.'
        },
        {
          role: 'user',
          content: prompt
        }
      ]
    });

    const point = completion.choices?.[0]?.message?.content?.trim() || `Point about ${topic}`;
    res.json(point);
  } catch (error) {
    console.error('❌ Groq point generation failed:', error);
    res.status(500).json({ error: 'Failed to generate point' });
  }
});

/* Generate contextual point based on graph structure */
app.post("/api/generate-contextual-point", express.json(), async (req, res) => {
  try {
    if (!groqClient) {
      return res.status(500).json({ error: 'Groq client not configured' });
    }

    const { graphData, selectedNode } = req.body;
    if (!graphData || !selectedNode) {
      return res.status(400).json({ error: 'Graph data and selected node are required' });
    }

    // Convert graph structure to text for context
    const graphContext = convertGraphToText(graphData);
    
    const prompt = `Based on this mindmap structure:
${graphContext}

Current selected node: "${selectedNode}"

Generate a single, relevant point that would logically extend this node. Consider the existing structure and relationships. Return just a concise phrase (max 8 words) that fits naturally with the current mindmap.`;

    const completion = await groqClient.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      temperature: 0.7,
      max_completion_tokens: 50,
      messages: [
        {
          role: 'system',
          content: 'You generate contextually relevant mindmap points. Return only the phrase, no quotes or explanations.'
        },
        {
          role: 'user',
          content: prompt
        }
      ]
    });

    const point = completion.choices?.[0]?.message?.content?.trim() || `Point about ${selectedNode}`;
    res.json(point);
  } catch (error) {
    console.error('❌ Groq contextual point generation failed:', error);
    res.status(500).json({ error: 'Failed to generate contextual point' });
  }
});

/* Ask question about the mindmap */
app.post("/api/ask-question", express.json(), async (req, res) => {
  try {
    if (!groqClient) {
      return res.status(500).json({ error: 'Groq client not configured' });
    }

    const { question, graphData, selectedNode } = req.body;
    if (!question || !graphData || !selectedNode) {
      return res.status(400).json({ error: 'Question, graph data, and selected node are required' });
    }

    // Convert graph structure to text for context
    const graphContext = convertGraphToText(graphData);
    
    const prompt = `Based on this mindmap structure:
${graphContext}

Current selected node: "${selectedNode}"

User question: "${question}"

Provide a concise answer (max 8 words) that could be added as a new node to this mindmap. The answer should be relevant to both the question and the existing structure.`;

    const completion = await groqClient.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      temperature: 0.7,
      max_completion_tokens: 50,
      messages: [
        {
          role: 'system',
          content: 'You provide concise answers that fit naturally into mindmap structures. Return only the answer phrase, no quotes or explanations.'
        },
        {
          role: 'user',
          content: prompt
        }
      ]
    });

    const answer = completion.choices?.[0]?.message?.content?.trim() || `Answer about ${selectedNode}`;
    res.json(answer);
  } catch (error) {
    console.error('❌ Groq question processing failed:', error);
    res.status(500).json({ error: 'Failed to process question' });
  }
});

// Helper function to convert graph structure to readable text
function convertGraphToText(node, depth = 0) {
  const indent = '  '.repeat(depth);
  let text = `${indent}${node.name}`;
  
  if (node.children && node.children.length > 0) {
    text += '\n' + node.children.map(child => convertGraphToText(child, depth + 1)).join('\n');
  }
  
  return text;
}

/* ---------- Checkbox Mode API Endpoints ---------- */

/* Cleanup session data */
app.post("/api/cleanup/:sessionCode", async (req, res) => {
  try {
    const teacher = await requireTeacher(req, res);
    if (!teacher) return;
    const { sessionCode } = req.params;
    // Ensure teacher owns the session before cleaning
    const session = await db.collection("sessions").findOne({ code: sessionCode });
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (session.owner_id !== teacher.id) return res.status(403).json({ error: "Forbidden" });
    await cleanupOldSessionData(sessionCode);
    res.json({ success: true, message: `Session ${sessionCode} cleaned up` });
  } catch (err) {
    console.error(`❌ Cleanup API error:`, err);
    res.status(500).json({ error: "Cleanup failed" });
  }
});

/* Create checkbox session */
app.post("/api/checkbox/session", express.json(), async (req, res) => {
  try {
    const teacher = await requireTeacher(req, res);
    if (!teacher) return;
    const { sessionCode, criteria, scenario, interval, strictness = 2 } = req.body; // Default strictness to 2 (moderate)
    
    if (!sessionCode || !criteria || criteria.length === 0) {
      return res.status(400).json({ error: "Session code and criteria required" });
    }
    
    console.log(`☑️ Creating checkbox session: ${sessionCode} with ${criteria.length} criteria`);
    console.log(`📝 Scenario: ${scenario ? scenario.substring(0, 100) + '...' : 'None provided'}`);
    console.log(`⚖️ Strictness level: ${strictness} (1=Lenient, 2=Moderate, 3=Strict)`);
    
    // Check if session already exists
    let session = await db.collection("sessions").findOne({ code: sessionCode });
    
    // Clean up any old data for this session to ensure fresh start
    if (session) {
      await cleanupOldSessionData(sessionCode);
    }
    
    // Create or update session
    if (!session) {
      // Create new session
      session = {
        _id: uuid(),
        owner_id: teacher.id,
        code: sessionCode,
        mode: "checkbox",
        active: false, // Stay inactive until /api/session/:code/start is called
        interval_ms: interval || 30000,
        strictness: strictness, // Store strictness level
        created_at: Date.now()
      };
      
      await db.collection("sessions").insertOne(session);
    } else {
      // Update existing session
      await db.collection("sessions").updateOne(
        { _id: session._id },
        { 
          $set: { 
            owner_id: teacher.id,
            mode: "checkbox", 
            active: false, // Stay inactive until /api/session/:code/start is called
            interval_ms: interval || 30000,
            strictness: strictness, // Update strictness level
            updated_at: Date.now() 
          }
        }
      );
    }
    
    // Create checkbox session record with scenario
    await db.collection("checkbox_sessions").findOneAndUpdate(
      { session_id: session._id },
      {
        $set: {
          scenario: scenario,
          created_at: Date.now()
        }
      },
      { upsert: true }
    );
    
    // Add criteria (delete existing ones first to avoid duplicates)
    await db.collection("checkbox_criteria").deleteMany({ session_id: session._id });
    await db.collection("checkbox_progress").deleteMany({ session_id: session._id });
    
    const criteriaIds = [];
    const memCriteria = [];
    for (let index = 0; index < criteria.length; index++) {
      const criterion = criteria[index];
      const criterionId = uuid();
      await db.collection("checkbox_criteria").insertOne({
        _id: criterionId,
        session_id: session._id,
        description: criterion.description,
        rubric: criterion.rubric || '',  // Add rubric field
        weight: criterion.weight || 1,
        order_index: index,
        created_at: Date.now()
      });
      criteriaIds.push(criterionId);
      memCriteria.push({
        _id: criterionId,
        description: criterion.description,
        rubric: criterion.rubric || '',
        order_index: index
      });
      
      // Initialize progress records for each group (1-10 for now)
      // This ensures all criteria have a baseline state
      for (let groupNum = 1; groupNum <= 10; groupNum++) {
        await db.collection("checkbox_progress").insertOne({
          _id: uuid(),
          session_id: session._id,
          criteria_id: criterionId,
          group_number: groupNum,
          status: 'grey',
          completed: false,
          quote: null,
          created_at: Date.now()
        });
      }
    }
    
    // Add to/update active sessions and cache current checkbox config in memory
    const existingMem = activeSessions.get(sessionCode) || {};
    activeSessions.set(sessionCode, {
      id: session._id,
      code: sessionCode,
      mode: "checkbox",
      ownerId: teacher.id,
      active: false, // Stay inactive until /api/session/:code/start is called
      interval: interval,
      startTime: null,
      created_at: existingMem.created_at || Date.now(),
      persisted: true,
      checkbox: {
        scenario: scenario || "",
        criteria: memCriteria,
        strictness
      }
    });
    
    res.json({
      success: true,
      sessionId: session._id,
      criteriaIds,
      message: "Checkbox session created successfully" 
    });
    
  } catch (err) {
    console.error("❌ Failed to create checkbox session:", err);
    res.status(500).json({ error: "Failed to create checkbox session" });
  }
});

/* Process transcript for checkbox */
app.post("/api/checkbox/process", express.json(), async (req, res) => {
  try {
    const teacher = await requireTeacher(req, res);
    if (!teacher) return;
    const { sessionCode, transcript, groupNumber = 1, criteria: clientCriteria, scenario: clientScenario } = req.body; // allow client-provided config
    
    if (!sessionCode || !transcript) {
      return res.status(400).json({ error: "Session code and transcript required" });
    }
    
    console.log(`☑️ Processing transcript for checkbox session: ${sessionCode}, group: ${groupNumber}`);
    
    // Get session info
    const session = await db.collection("sessions").findOne({ code: sessionCode, mode: "checkbox" });
    if (!session) {
      return res.status(404).json({ error: "Checkbox session not found" });
    }
    if (session.owner_id !== teacher.id) {
      return res.status(403).json({ error: "Forbidden" });
    }
    
    // Prefer client-provided or in-memory scenario/criteria for speed
    const mem = activeSessions.get(sessionCode);
    const strictness = session.strictness || 2;
    let scenario = clientScenario ?? mem?.checkbox?.scenario ?? "";
    let criteria = clientCriteria ?? mem?.checkbox?.criteria;

    // Fallback to DB only if not provided
    if (!criteria || criteria.length === 0) {
      criteria = await db.collection("checkbox_criteria")
        .find({ session_id: session._id })
        .sort({ order_index: 1, created_at: 1 })
        .toArray();
    }
    if (!scenario) {
      const checkboxSession = await db.collection("checkbox_sessions").findOne({ session_id: session._id });
      scenario = checkboxSession?.scenario || "";
    }

    // Normalize criteria to expected shape and drop any hardcoded/default leftovers
    criteria = (criteria || []).map((c, index) => ({
      originalIndex: typeof c.originalIndex === 'number' ? c.originalIndex : index,
      description: (c.description || '').toString(),
      rubric: (c.rubric || '').toString()
    }));
    
    if (criteria.length === 0) {
      return res.status(400).json({ error: "No criteria found for session" });
    }
    
    // Get existing progress for this group to avoid re-evaluating GREEN criteria
    const existingProgressRecords = await db.collection("checkbox_progress")
      .find({ 
        session_id: session._id,
        group_number: groupNumber 
      })
      .toArray();
    
    // Build existing progress array indexed by criteria position
    const existingProgress = [];
    criteria.forEach((c, idx) => {
      const progress = existingProgressRecords.find(p => p.criteria_id === c._id);
      if (progress) {
        existingProgress[idx] = {
          status: progress.status,
          quote: progress.quote,
          completed: progress.completed
        };
      } else {
        existingProgress[idx] = null;
      }
    });
    
    console.log(`📋 Found ${existingProgressRecords.length} existing progress records for group ${groupNumber}`);
    const greenCount = existingProgress.filter(p => p && p.status === 'green').length;
    if (greenCount > 0) {
      console.log(`📋 Preserving ${greenCount} GREEN criteria from previous evaluations`);
    }
    
    // Process the transcript with scenario context and strictness
    const result = await processCheckboxTranscript(transcript, criteria, scenario, strictness, existingProgress);
    
    // Log the processing result (persist once per round)
    await db.collection("session_logs").insertOne({
      _id: uuid(),
      session_id: session._id,
      type: "checkbox_analysis",
      content: transcript,
      ai_response: result,
      created_at: Date.now()
    });
    
    // Update progress for matched criteria
    const progressUpdates = [];
    const now = Date.now();
    
    for (const match of result.matches) {
      const criterion = criteria[match.criteria_index];
      if (criterion) {
        // Check existing progress to implement proper locking rules
        const existingProgress = await db.collection("checkbox_progress").findOne({
          session_id: session._id,
          criteria_id: criterion._id
        });
        
        // Implement locking rules:
        // 1. GREEN stays GREEN forever (locked)
        // 2. GREY has no quotes and can become RED or GREEN
        // 3. RED can become GREEN but not GREY
        let shouldUpdate = false;
        let newStatus = match.status;
        let newQuote = match.status === 'grey' ? null : match.quote; // Grey has no quotes
        
        if (!existingProgress) {
          // No existing progress - always update
          shouldUpdate = true;
        } else if (existingProgress.status === 'green') {
          // GREEN is locked - never update
          console.log(`📋 Criteria ${match.criteria_index} already GREEN (locked) with quote: "${existingProgress.quote}" - skipping update`);
          shouldUpdate = false;
        } else if (existingProgress.status === 'grey') {
          // GREY can become RED or GREEN
          if (match.status === 'red' || match.status === 'green') {
            shouldUpdate = true;
            console.log(`📋 Criteria ${match.criteria_index} upgrading from GREY to ${match.status.toUpperCase()}`);
          }
        } else if (existingProgress.status === 'red') {
          // RED can only become GREEN
          if (match.status === 'green') {
            shouldUpdate = true;
            console.log(`📋 Criteria ${match.criteria_index} upgrading from RED to GREEN`);
          } else {
            console.log(`📋 Criteria ${match.criteria_index} staying RED - cannot downgrade to ${match.status.toUpperCase()}`);
            shouldUpdate = false;
          }
        }
        
        if (shouldUpdate) {
          await db.collection("checkbox_progress").findOneAndUpdate(
            { 
              session_id: session._id,
              criteria_id: criterion._id,
              group_number: groupNumber  // Add group_number to the query
            },
            {
              $set: {
                completed: newStatus === 'green', // Only mark as completed if green
                quote: newQuote, // No quote for grey status
                status: newStatus,
                completed_at: now,
                group_number: groupNumber  // Ensure group_number is set
              }
            },
            { upsert: true }
          );
          
          // Emit using both stable DB criteria_id and display index to avoid off-by-one errors
          progressUpdates.push({
            criteriaId: match.criteria_index,
            criteriaDbId: criterion._id,
            description: criterion.description,
            completed: match.status === 'green',
            quote: match.quote,
            status: match.status
          });
          
          console.log(`📋 Checkbox update for criteria idx=${match.criteria_index} (_id=${criterion._id}): "${match.quote}" - STATUS: ${match.status}`);
        } else {
          console.log(`📋 Criteria ${match.criteria_index} already completed with quote: "${existingProgress.quote}" - skipping update`);
        }
      }
    }
    
    console.log(`📤 Sending ${progressUpdates.length} checkbox updates to admin for group ${groupNumber}`);
    
    // Send checkbox updates to admin
    io.to(sessionCode).emit("admin_update", {
      group: groupNumber,
      latestTranscript: transcript,
      checkboxUpdates: progressUpdates,
      isActive: true
    });
    
    // NEW: Also emit full checklist state to both teachers and students
    // Get the current release state from database
    const checkboxSessionData = await db.collection("checkbox_sessions").findOne({ session_id: session._id });
    const isReleased = checkboxSessionData?.released_groups?.[groupNumber] || false;
    
    // Get all current progress for this group
    const allProgress = await db.collection("checkbox_progress").find({
      session_id: session._id,
      group_number: groupNumber
    }).toArray();
    
    // Build complete checklist state
    const checklistData = {
      groupNumber: groupNumber,
      criteria: criteria.map((c, idx) => {
        const progress = allProgress.find(p => p.criteria_id === c._id);
        return {
          id: idx, // stable index based on sorted order_index
          dbId: c._id,
          description: c.description,
          rubric: c.rubric || '',
          status: progress?.status || 'grey',
          completed: progress?.completed || false,
          quote: progress?.quote || null
        };
      }),
      scenario: checkboxSession?.scenario || "",
      timestamp: Date.now(),
      isReleased: isReleased,  // Controls student visibility
      sessionCode: sessionCode
    };
    
    console.log(`📨 Emitting checklist state to all (released: ${isReleased})`);
    
    // Emit to everyone in session
    io.to(sessionCode).emit('checklist_state', checklistData);
    io.to(`${sessionCode}-${groupNumber}`).emit('checklist_state', checklistData);
    // Cache latest state
    latestChecklistState.set(`${sessionCode}-${groupNumber}`, checklistData);
    
    res.json({
      success: true,
      matches: result.matches.length,
      reason: result.reason,
      progressUpdates: progressUpdates
    });
    
  } catch (err) {
    console.error("❌ Failed to process checkbox transcript:", err);
    res.status(500).json({ error: "Failed to process transcript" });
  }
});

/* Get checkbox data */
app.get("/api/checkbox/:sessionCode", async (req, res) => {
  try {
    const teacher = await requireTeacher(req, res);
    if (!teacher) return;
    const { sessionCode } = req.params;
    
    console.log(`☑️ Fetching checkbox data for session: ${sessionCode}`);
    
    // Get session info
    const session = await db.collection("sessions").findOne({ code: sessionCode, mode: "checkbox" });
    if (!session) {
      return res.status(404).json({ error: "Checkbox session not found" });
    }
    if (session.owner_id !== teacher.id) {
      return res.status(403).json({ error: "Forbidden" });
    }
    
    // Get checkbox session data (includes scenario)
    const checkboxSession = await db.collection("checkbox_sessions").findOne({ session_id: session._id });
    
    // Get criteria
    const criteria = await db.collection("checkbox_criteria")
      .find({ session_id: session._id })
      .sort({ order_index: 1, created_at: 1 })
      .toArray();
    
    // Get progress for each criterion
    const progress = await db.collection("checkbox_progress")
      .find({ session_id: session._id })
      .toArray();
    
    // Combine criteria with progress
    const criteriaWithProgress = criteria.map(criterion => {
      const prog = progress.find(p => p.criteria_id === criterion._id);
      return {
        ...criterion,
        completed: prog?.completed || false,
        confidence: prog?.confidence || 0,
        evidence: prog?.evidence || null,
        completedAt: prog?.completed_at || null
      };
    });
    
    // Get recent logs
    const logs = await db.collection("session_logs")
      .find({ session_id: session._id })
      .sort({ created_at: -1 })
      .limit(50)
      .toArray();
    
    // Calculate statistics
    const completedCount = criteriaWithProgress.filter(c => c.completed).length;
    const totalCount = criteriaWithProgress.length;
    const completionRate = totalCount > 0 ? (completedCount / totalCount) * 100 : 0;
    
    res.json({
      success: true,
      session: {
        code: sessionCode,
        createdAt: session.created_at,
        scenario: checkboxSession?.scenario || ""
      },
      criteria: criteriaWithProgress,
      stats: {
        total: totalCount,
        completed: completedCount,
        completionRate: Math.round(completionRate)
      },
      logs: logs
    });
    
  } catch (err) {
    console.error("❌ Failed to fetch checkbox data:", err);
    res.status(500).json({ error: "Failed to fetch checkbox data" });
  }
});

/* Get session logs */
app.get("/api/logs/:sessionCode", async (req, res) => {
  try {
    const { sessionCode } = req.params;
    const { limit = 100, type } = req.query;
    
    console.log(`📋 Fetching logs for session: ${sessionCode}`);
    
    // Get session info
    const session = await db.collection("sessions").findOne({ code: sessionCode });
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }
    
    // Build query
    const query = { session_id: session._id };
    if (type) {
      query.type = type;
    }
    
    // Get logs
    const logs = await db.collection("session_logs")
      .find(query)
      .sort({ created_at: -1 })
      .limit(parseInt(limit))
      .toArray();
    
    res.json({
      success: true,
      logs: logs,
      session: {
        code: sessionCode,
        mode: session.mode
      }
    });
    
  } catch (err) {
    console.error("❌ Failed to fetch logs:", err);
    res.status(500).json({ error: "Failed to fetch logs" });
  }
});

/* ---------- Auto-summary management ---------- */
const activeSummaryTimers = new Map();

function startAutoSummary(sessionCode, intervalMs) {
  // Clear any existing timer for this session
  stopAutoSummary(sessionCode);
  
  const timer = setInterval(async () => {
    console.log(`⏰ Auto-generating summaries for session ${sessionCode}`);
    
    // Check if session is still active (both in memory and database)
    const sessionState = activeSessions.get(sessionCode);
    const session = await db.collection("sessions").findOne({ code: sessionCode, active: true });
    
    if (!session || !sessionState?.active) {
      console.log(`⚠️  Session ${sessionCode} no longer active, stopping auto-summary`);
      stopAutoSummary(sessionCode);
      return;
    }
    
    const groups = await db.collection("groups").find({ session_id: session._id }).sort({ number: 1 }).toArray();
    console.log(`🔄 Processing summaries for ${groups.length} groups in session ${sessionCode}`);
    
    for (const group of groups) {
      await generateSummaryForGroup(sessionCode, group.number);
    }
  }, intervalMs); // Use the same interval as recording instead of fixed 10 seconds
  
  activeSummaryTimers.set(sessionCode, timer);
  console.log(`⏰ Started auto-summary timer for session ${sessionCode} (every ${intervalMs}ms)`);
}

function stopAutoSummary(sessionCode) {
  const timer = activeSummaryTimers.get(sessionCode);
  if (timer) {
    clearInterval(timer);
    activeSummaryTimers.delete(sessionCode);
    console.log(`⏰ Stopped auto-summary timer for session ${sessionCode}`);
  }
}

// Concurrency guard for transcription
const processingGroups = new Set();

async function generateSummaryForGroup(sessionCode, groupNumber) {
  const groupKey = `${sessionCode}-${groupNumber}`;
  
  // Prevent overlapping processing for the same group
  if (processingGroups.has(groupKey)) {
    console.log(`⏳ Group ${groupNumber} already being processed, skipping`);
    return;
  }
  
  processingGroups.add(groupKey);
  
  try {
    console.log(`📋 Processing group ${groupNumber} in session ${sessionCode}`);
    
    // Find sockets in this group and get their audio data
    const roomName = `${sessionCode}-${groupNumber}`;
    const socketsInRoom = await io.in(roomName).fetchSockets();
    
    if (socketsInRoom.length === 0) {
      console.log(`ℹ️  No active sockets in group ${groupNumber}, skipping`);
      return;
    }
    
    // Collect audio from all sockets in this group
    let hasAudio = false;
    let combinedAudio = [];
    
    for (const socket of socketsInRoom) {
      if (socket.localBuf && socket.localBuf.length > 0) {
        // For WebM containers, we should have at most one complete container per socket
        // For other formats, we might have multiple chunks
        const audioChunks = socket.localBuf.filter(chunk => chunk.data.length > 20000); // Guardrail: only process substantial chunks
        
        if (audioChunks.length > 0) {
          // For WebM, we need to handle both complete containers and partial chunks
          const baseMime = extractMime(audioChunks[0].format);
          if (baseMime === 'audio/webm') {
            // First, look for a complete WebM container
            const completeContainer = audioChunks.find(chunk => {
              const header = chunk.data.slice(0, 4).toString('hex');
              return header === '1a45dfa3' && !chunk.isPartial;
            });
            
            if (completeContainer) {
              console.log(`✅ Found complete WebM container (${completeContainer.data.length} bytes) from socket ${socket.id}`);
              combinedAudio.push(completeContainer);
              hasAudio = true;
            } else {
              // Don't try to combine partial chunks - they create corrupted WebM data
              // Instead, just skip this processing cycle and wait for a complete container
              console.log(`⏭️  No complete WebM container found, skipping processing (${audioChunks.length} partial chunks available)`);
              console.log(`💡 Waiting for complete WebM container with header 1a45dfa3...`);
            }
          } else {
            // For other formats, add all substantial chunks
            combinedAudio.push(...audioChunks);
            hasAudio = true;
          }
        }
        
        socket.localBuf.length = 0; // Clear buffer after processing
      }
    }
    
    if (!hasAudio) {
      console.log(`ℹ️  No substantial audio data available for group ${groupNumber}, skipping`);
      return;
    }
    
    // Process each blob individually instead of concatenating
    for (const audioChunk of combinedAudio) {
      console.log(`🔄 Processing ${audioChunk.data.length} bytes of audio data for group ${groupNumber}`);
      
      // Validate audio before sending to API
      if (audioChunk.data.length < 1000) {
        console.log(`⚠️  Audio too small (${audioChunk.data.length} bytes), skipping`);
        continue;
      }
      
      // Check if audio has valid headers for common formats
      const header = audioChunk.data.slice(0, 4).toString('hex');
      const validHeaders = {
        '1a45dfa3': 'WebM',
        '52494646': 'WAV/RIFF',
        '00000020': 'MP4',
        '4f676753': 'OGG'
      };
      
      if (validHeaders[header]) {
        console.log(`✅ Valid ${validHeaders[header]} header detected: ${header}`);
      } else {
        console.log(`⚠️  Unknown audio header: ${header}, proceeding anyway`);
        // Log the first few bytes for debugging
        const firstBytes = audioChunk.data.slice(0, 8).toString('hex');
        console.log(`🔍 First 8 bytes: ${firstBytes}`);
      }
      
      // Get transcription for this individual audio chunk
      console.log("🗣️  Starting transcription for current chunk...");
      
      console.log(`🎵 Audio format: ${audioChunk.format}`);
      
      const transcription = await transcribe(audioChunk.data, audioChunk.format);
      
      // Only proceed if we have valid transcription
      let cleanedText = transcription.text;
      if (transcription.text && transcription.text !== "No transcription available" && transcription.text !== "Transcription failed") {
        // Transcript cleaning removed - using raw transcription
        console.log(`📝 Transcription for group ${groupNumber}:`, {
          text: cleanedText,
          duration: transcription.words.length > 0 ? 
            transcription.words[transcription.words.length - 1].end : 0,
          wordCount: transcription.words.length
        });
        
        // Save this individual transcription segment
        const session = await db.collection("sessions").findOne({ code: sessionCode });
        const group = await db.collection("groups").findOne({ session_id: session._id, number: parseInt(groupNumber) });
        
        if (group) {
          // Save the transcription segment
          const now = Date.now();
          const transcriptId = uuid();
          
          // Calculate word count and duration with fallbacks
          const wordCount = transcription.words && transcription.words.length > 0 ? 
            transcription.words.length : 
            transcription.text.split(' ').filter(w => w.trim().length > 0).length;
          
          const duration = transcription.words && transcription.words.length > 0 ? 
            transcription.words[transcription.words.length - 1].end : 
            Math.max(10, Math.min(30, transcription.text.length * 0.05)); // Estimate 0.05 seconds per character
          
          const transcriptRecord = createTranscriptRecord({
            id: transcriptId,
            sessionId: session._id,
            groupId: group._id,
            text: cleanedText,
            wordCount,
            durationSeconds: duration,
            createdAt: now,
            segmentNumber: Math.floor(now / 30000),
            isNoise: false
          });

          const { segments, stats } = await appendTranscriptSegment({
            sessionId: transcriptRecord.sessionId,
            groupId: transcriptRecord.groupId,
            segment: transcriptRecord.segment
          });
          
          // Combine all transcripts for summary (but only transcribe current chunk)
          const fullText = segments.map(t => t.text).join(' ');
          
          // Generate summary of the entire conversation so far
          console.log("🤖 Generating summary of full conversation...");
          
          // Get custom prompt for this session
          // Resolve the latest prompt: prefer memory cache (if admin changed it mid-session), fall back to DB
          let customPrompt = activeSessions.get(sessionCode)?.customPrompt || null;
          if (!customPrompt && session) {
            const promptData = await db.collection("session_prompts").findOne({ session_id: session._id });
            customPrompt = promptData?.prompt || null;
          }
          
          const summary = await summarise(fullText, customPrompt);
          
          // Save/update the summary
          await db.collection("summaries").findOneAndUpdate(
            { group_id: group._id },
            { $set: createSummaryUpdateFields({ sessionId: session._id, text: summary, timestamp: now }) },
            { upsert: true }
          );
          
          // Send both new transcription and updated summary to clients
          io.to(roomName).emit("transcription_and_summary", {
            transcription: {
              text: cleanedText,
              words: transcription.words,
              duration: duration,
              wordCount: wordCount
            },
            summary,
            isLatestSegment: true
          });
          
          // Send update to admin console
          io.to(sessionCode).emit("admin_update", {
            group: groupNumber,
            latestTranscript: cleanedText,
            cumulativeTranscript: fullText, // Add full conversation for admin
            transcriptDuration: duration,
            transcriptWordCount: wordCount,
            summary,
            stats: {
              totalSegments: stats.total_segments,
              totalWords: stats.total_words,
              totalDuration: stats.total_duration,
              lastUpdate: stats.last_update || new Date(now).toISOString()
            }
          });
          
          console.log(`✅ Results saved and sent for session ${sessionCode}, group ${groupNumber}`);
        }
      } else {
        console.log(`⚠️  No valid transcription for group ${groupNumber}`);
      }
    }
    
  } catch (err) {
    console.error(`❌ Error processing group ${groupNumber}:`, err);
  } finally {
    processingGroups.delete(groupKey);
  }
}

// Helper to clean up transcript using Anthropic
async function cleanTranscriptWithAnthropic(text) {
  return summarise(
    text,
    "Clean up the following transcript for grammar, punctuation, and readability, but do not summarize or remove any content. Only return the cleaned transcript:"
  );
}

/* ---------- 3. WebSocket flow ---------- */
io.on("connection", socket => {
  console.log(`🔌 New socket connection: ${socket.id}`);
  let groupId, localBuf = [], sessionCode, groupNumber;

  // Live prompt updates from admin: keep latest prompt in memory to avoid DB reads
  socket.on('prompt_update', data => {
    try {
      const { sessionCode: code, prompt } = data || {};
      if (!code || typeof prompt !== 'string') return;
      const mem = activeSessions.get(code);
      if (mem) {
        activeSessions.set(code, { ...mem, customPrompt: prompt });
      }
    } catch (e) {
      console.warn('⚠️ prompt_update handling error:', e.message);
    }
  });
  
  // Attach buffer to socket for auto-summary access
  socket.localBuf = localBuf;

  // Timestamp helper for logs
  function ts() { return new Date().toISOString(); }

  // Admin joins session room
  socket.on("admin_join", ({ code }) => {
    try {
      console.log(`👨‍🏫 Admin socket ${socket.id} joining session room: ${code}`);
      socket.join(code);
      console.log(`✅ Admin joined session room: ${code}`);
    } catch (err) {
      console.error("❌ Error admin joining session room:", err);
    }
  });

  socket.on("join", async ({ code, group }) => {
    try {
      console.log(`[${ts()}] 👋 Socket ${socket.id} attempting to join session ${code}, group ${group}`);
      
      // Check memory only - no database lookup
      const sessionState = activeSessions.get(code);
      
      if (!sessionState) {
        console.log(`❌ Session ${code} not found`);
        return socket.emit("error", "Session not found");
      }
      
      sessionCode = code;
      groupNumber = group;
      
      // Only create database entries if session has been persisted (i.e., recording started)
      if (sessionState.persisted) {
        // Session exists in database, handle group creation normally
        const sess = await db.collection("sessions").findOne({ code: code });
        if (!sess) {
          console.log(`❌ Session ${code} not found in database despite being marked as persisted`);
          return socket.emit("error", "Session data inconsistent");
        }
        
        const existing = await db.collection("groups").findOne({ session_id: sess._id, number: parseInt(group) });
        groupId = existing?._id ?? uuid();
        
        if (!existing) {
          await db.collection("groups").insertOne({
            _id: groupId,
            session_id: sess._id,
            number: parseInt(group)
          });
          console.log(`📝 Created new group: Session ${code}, Group ${group}, ID: ${groupId}`);
        } else {
          console.log(`🔄 Rejoined existing group: Session ${code}, Group ${group}, ID: ${groupId}`);
        }
      } else {
        // Session not yet persisted, just create a temporary group ID
        groupId = uuid();
        console.log(`📝 Created temporary group ID for unpersisted session: ${groupId}`);
      }
      
      socket.join(code);
      socket.join(`${code}-${group}`);
      
      // Send different status based on session state
      if (sessionState.active) {
        socket.emit("joined", { code, group, status: "recording", interval: sessionState.interval || 30000, mode: sessionState.mode || "summary" });
        console.log(`✅ Socket ${socket.id} joined ACTIVE session ${code}, group ${group}`);
        // Track joined group for reliability retries
        const mem = activeSessions.get(code) || {};
        if (!mem.groups) mem.groups = new Map();
        mem.groups.set(parseInt(group), { joined: true, recording: false, lastAck: Date.now() });
        activeSessions.set(code, mem);
        // Immediate emit to this group if server is active and not yet recording
        io.to(`${code}-${parseInt(group)}`).emit("record_now", sessionState.interval || 30000);
      } else {
        socket.emit("joined", { code, group, status: "waiting", interval: sessionState.interval || 30000, mode: sessionState.mode || "summary" });
        console.log(`✅ Socket ${socket.id} joined INACTIVE session ${code}, group ${group} - waiting for start`);
        const mem = activeSessions.get(code) || {};
        if (!mem.groups) mem.groups = new Map();
        mem.groups.set(parseInt(group), { joined: true, recording: false, lastAck: Date.now() });
        activeSessions.set(code, mem);
      }
      
      // Notify admin about student joining
      socket.to(code).emit("student_joined", { group, socketId: socket.id });
      console.log(`[${ts()}] 📢 Notified admin about student joining group ${group}`);
      
    } catch (err) {
      console.error("❌ Error joining session:", err);
      socket.emit("error", "Failed to join session");
    }
  });

  socket.on("student:chunk", ({ data, format }) => {
    // Note: This event is no longer used. Students now upload chunks directly via /api/transcribe-chunk
    console.log(`⚠️  Received old-style chunk from ${sessionCode}, group ${groupNumber} - ignoring (use /api/transcribe-chunk instead)`);
  });

  // Handle heartbeat to keep connection alive (especially for background recording)
  socket.on("heartbeat", ({ session, group }) => {
    console.log(`[${ts()}] 💓 Heartbeat from session ${session}, group ${group} (socket: ${socket.id})`);
    socket.emit("heartbeat_ack");
    // Mark group alive; if session active, also flag as recording
    const mem = activeSessions.get(session);
    if (mem) {
      if (!mem.groups) mem.groups = new Map();
      const st = mem.groups.get(parseInt(group)) || {};
      st.joined = true;
      st.lastAck = Date.now();
      if (mem.active) st.recording = true;
      mem.groups.set(parseInt(group), st);
      activeSessions.set(session, mem);
    }
  });

  // Explicit client acknowledgement when recording actually starts
  socket.on('recording_started', ({ session, group, interval }) => {
    try {
      const mem = activeSessions.get(session);
      if (!mem) return;
      if (!mem.groups) mem.groups = new Map();
      const st = mem.groups.get(parseInt(group)) || {};
      st.joined = true;
      st.recording = true;
      st.lastAck = Date.now();
      mem.groups.set(parseInt(group), st);
      activeSessions.set(session, mem);
      console.log(`✅ recording_started ack from group ${group} (session ${session})`);
    } catch (e) {
      console.warn('⚠️ recording_started handler error:', e.message);
    }
  });

  // Handle admin heartbeat
  socket.on("admin_heartbeat", ({ sessionCode }) => {
    console.log(`[${ts()}] 💓 Admin heartbeat from session ${sessionCode} (socket: ${socket.id})`);
    socket.emit("admin_heartbeat_ack");
  });

  // Optional: server-side keepalive ping back every 10s to all sockets in same room
  // This helps some proxies keep connections warm

  /* ===== DEV ONLY: Simulate disconnect test (guarded by env) ===== */
  socket.on('dev_simulate_disconnect', ({ sessionCode: code, target = 'all', group = 1, durationMs = 5000 }) => {
    if (!process.env.ALLOW_DEV_TEST) {
      console.log('🚫 dev_simulate_disconnect ignored (ALLOW_DEV_TEST not set)');
      return;
    }
    try {
      console.log(`🧪 DEV: simulate disconnect → session ${code}, target=${target}, group=${group}, duration=${durationMs}ms`);
      const payload = { durationMs: Number(durationMs) || 5000 };
      if (target === 'all') {
        io.to(code).emit('dev_simulate_disconnect', payload);
      } else {
        io.to(`${code}-${parseInt(group)}`).emit('dev_simulate_disconnect', payload);
      }
    } catch (e) {
      console.warn('⚠️ dev_simulate_disconnect error:', e.message);
    }
  });
  /* ===== END DEV ONLY ===== */

  // Handle upload errors from students
  socket.on("upload_error", ({ session, group, error, chunkSize, timestamp }) => {
    console.log(`❌ Upload error from session ${session}, group ${group}: ${error}`);
    
    // Notify admin about the upload error
    socket.to(session).emit("upload_error", {
      group: group,
      error: error,
      chunkSize: chunkSize,
      timestamp: timestamp,
      socketId: socket.id
    });
    
    // Log error for debugging
    console.log(`📊 Upload error details: ${chunkSize} bytes, ${error}`);
  });

  socket.on("disconnect", () => {
    if (sessionCode && groupNumber) {
    console.log(`[${ts()}] 🔌 Socket ${socket.id} disconnected from session ${sessionCode}, group ${groupNumber}`);
      
      // Notify admin about student leaving
      socket.to(sessionCode).emit("student_left", { group: groupNumber, socketId: socket.id });
    } else {
      console.log(`🔌 Socket ${socket.id} disconnected (no session/group)`);
    }
    
    // Clean up socket buffer to prevent memory leaks
    if (socket.localBuf) {
      socket.localBuf.length = 0;
      socket.localBuf = null;
    }
    
    // Remove from processing groups if it was being processed
    if (sessionCode && groupNumber) {
      const groupKey = `${sessionCode}-${groupNumber}`;
      processingGroups.delete(groupKey);
    }
  });

  // Handle student disconnection
  socket.on('disconnect', () => {
    console.log(`🔌 Socket disconnected: ${socket.id}`);
    
    // Socket.IO automatically handles room cleanup when sockets disconnect
    // No manual cleanup needed for socket rooms
    // activeSessions only stores session metadata, not socket collections
  });

  // Debug helper - tell client what rooms they're in
  socket.on('get_my_rooms', () => {
    console.log(`🔍 Socket ${socket.id} requested room info`);
    console.log(`🔍 Socket ${socket.id} is in rooms:`, Array.from(socket.rooms));
    socket.emit('room_info', {
      socketId: socket.id,
      rooms: Array.from(socket.rooms)
    });
  });

  // Handle checklist release to students
  socket.on('release_checklist', async (data) => {
    try {
      console.log(`📤 Teacher releasing checklist to Group ${data.groupNumber} in session ${data.sessionCode}`);
      const groupNumber = Number(data.groupNumber);
      if (!Number.isFinite(groupNumber)) {
        console.error(`❌ Invalid group number received for release_checklist: ${data.groupNumber}`);
        return;
      }
      const cacheKey = `${data.sessionCode}-${groupNumber}`;
      const cached = latestChecklistState.get(cacheKey);
      if (cached) {
        console.log(`🗄️ Using cached checklist_state as merge source (cached ${cached.criteria?.length || 0} items)`);
      }
      
      // Get the session from database to get its _id
      const session = await db.collection("sessions").findOne({ code: data.sessionCode });
      if (!session) {
        console.error(`❌ Session ${data.sessionCode} not found in database`);
        return;
      }

      const existingCheckboxSession = await db.collection("checkbox_sessions").findOne({ session_id: session._id });
      const nowTs = Date.now();
      const updatedCheckboxSession = {
        ...(existingCheckboxSession || {}),
        session_id: session._id,
        scenario: existingCheckboxSession?.scenario ?? data.scenario ?? "",
        released_groups: {
          ...(existingCheckboxSession?.released_groups || {}),
          [groupNumber]: true
        },
        release_timestamps: {
          ...(existingCheckboxSession?.release_timestamps || {}),
          [groupNumber]: nowTs
        },
        updated_at: nowTs
      };

      await db.collection("checkbox_sessions").findOneAndUpdate(
        { session_id: session._id },
        { $set: updatedCheckboxSession },
        { upsert: true }
      );

      console.log(`✅ Release flag set for group ${groupNumber} in session ${data.sessionCode}`);
      
      const checkboxSession = updatedCheckboxSession;

      // Build authoritative checklist state from DB progress for this group
      const dbCriteria = await db.collection("checkbox_criteria")
        .find({ session_id: session._id })
        .sort({ order_index: 1, created_at: 1 })
        .toArray();
      const progress = await db.collection("checkbox_progress")
        .find({ session_id: session._id, group_number: groupNumber })
        .toArray();
      
      // Fallback: if DB has no criteria yet (race on first start), use teacher-provided payload
      const incomingCriteria = Array.isArray(data.criteria) ? data.criteria : [];
      let finalCriteria;
      if (!dbCriteria || dbCriteria.length === 0) {
        console.warn(`⚠️ No DB criteria found for session ${data.sessionCode}. Falling back to teacher payload with ${incomingCriteria.length} items.`);
        finalCriteria = incomingCriteria.map((c, idx) => ({
          id: Number(c.id ?? idx),
          dbId: c.dbId,
          description: c.description,
          rubric: c.rubric || '',
          status: c.status || 'grey',
          completed: c.status === 'green' ? true : Boolean(c.completed),
          quote: c.quote ?? null
        }));
      } else {
        // Build from DB first
        finalCriteria = dbCriteria.map((c, idx) => {
          const prog = progress.find(p => p.criteria_id === c._id);
          return {
            id: idx,
            dbId: c._id,
            description: c.description,
            rubric: c.rubric || '',
            status: prog?.status || 'grey',
            completed: prog?.completed || (prog?.status === 'green') || false,
            quote: prog?.quote || null
          };
        });
        // Merge in teacher payload to avoid initial all-grey if DB progress isn't there yet
        if (incomingCriteria.length > 0) {
          const byDbId = new Map(incomingCriteria.filter(x => x.dbId).map(x => [x.dbId, x]));
          const byIdx = new Map(incomingCriteria.map(x => [Number(x.id), x]));
          finalCriteria = finalCriteria.map(item => {
            const fromTeacher = (item.dbId && byDbId.get(item.dbId)) || byIdx.get(Number(item.id));
            if (!fromTeacher) return item;
            const teacherStatus = fromTeacher.status || 'grey';
            const preferTeacher = (teacherStatus === 'green') || (item.status === 'grey' && teacherStatus !== 'grey');
            if (preferTeacher) {
              return {
                ...item,
                status: teacherStatus,
                completed: teacherStatus === 'green' ? true : item.completed,
                quote: (fromTeacher.quote && fromTeacher.quote !== 'null') ? fromTeacher.quote : item.quote
              };
            }
            return item;
          });
        }
        // Merge in cached latest state to avoid blanks on first release
        if (cached && Array.isArray(cached.criteria) && cached.criteria.length > 0) {
          const cacheByIdx = new Map(cached.criteria.map(x => [Number(x.id), x]));
          finalCriteria = finalCriteria.map(item => {
            const fromCache = cacheByIdx.get(Number(item.id));
            if (!fromCache) return item;
            const cacheStatus = fromCache.status || 'grey';
            const preferCache = (cacheStatus === 'green') || (item.status === 'grey' && cacheStatus !== 'grey');
            if (preferCache) {
              return {
                ...item,
                status: cacheStatus,
                completed: cacheStatus === 'green' ? true : item.completed,
                quote: (fromCache.quote && fromCache.quote !== 'null') ? fromCache.quote : item.quote
              };
            }
            return item;
          });
        }
      }
      
      // Ensure stable ordering by numeric id
      finalCriteria = (finalCriteria || []).slice().sort((a, b) => Number(a.id) - Number(b.id));
      if (!finalCriteria || finalCriteria.length === 0) {
        // Last resort: if everything failed, use cached criteria entirely
        if (cached && Array.isArray(cached.criteria) && cached.criteria.length > 0) {
          console.warn('⚠️ DB and teacher payload empty, falling back to cached checklist state entirely');
          finalCriteria = cached.criteria.map(c => ({
            id: Number(c.id),
            dbId: c.dbId,
            description: c.description,
            rubric: c.rubric || '',
            status: c.status || 'grey',
            completed: Boolean(c.completed),
            quote: c.quote ?? null
          }));
        }
      }
      
      const checklistData = {
        sessionCode: data.sessionCode,
        groupNumber,
        criteria: finalCriteria,
        scenario: checkboxSession?.scenario || data.scenario || "",
        timestamp: Date.now(),
        isReleased: true
      };
      
      console.log('📤 Emitting authoritative released checklist:', {
        group: checklistData.groupNumber,
        criteriaCount: checklistData.criteria.length,
        sampleStatuses: checklistData.criteria.map(c => c.status).slice(0, 7)
      });
      
      // Emit to everyone - students will now see it because isReleased is true
      io.to(data.sessionCode).emit('checklist_state', checklistData);
      io.to(`${data.sessionCode}-${groupNumber}`).emit('checklist_state', checklistData);
      latestChecklistState.set(cacheKey, checklistData);
      
      console.log(`✅ Checklist released to session ${data.sessionCode} for Group ${groupNumber}`);
    } catch (error) {
      console.error('❌ Error handling checklist release:', error);
    }
  });
});

/* ---------- 4. External API helpers ---------- */
// Helper to extract base MIME type (before semicolon)
function extractMime(mime) {
  if (!mime) return 'audio/webm';
  return mime.split(';')[0].trim().toLowerCase();
}

async function transcribe(buf, format = 'audio/webm') {
  try {
    console.log(`🌐 Calling ElevenLabs API for transcription (${buf.length} bytes, format: ${format})`);
    
    // Additional validation
    if (!buf || buf.length === 0) {
      console.log("⚠️  Empty audio buffer provided");
      return { text: "No audio data available", words: [] };
    }
    
    if (buf.length < 1000) {
      console.log(`⚠️  Audio buffer too small (${buf.length} bytes) for transcription`);
      return { text: "Audio too short for transcription", words: [] };
    }
    
    // Create FormData for the API call
    const FormData = (await import('form-data')).default;
    const formData = new FormData();
    
    // Extract base MIME type and map formats correctly
    const baseMime = extractMime(format);
    let audioMime = baseMime;
    let filename = 'audio.webm';
    
    // Map formats using base MIME, not the whole string
    switch (baseMime) {
      case 'audio/wav':
      case 'audio/x-wav':
      case 'audio/wave':
      case 'audio/pcm':
        audioMime = 'audio/wav';
        filename = 'audio.wav';
        break;
        
      case 'audio/mp4':
      case 'audio/m4a':
        audioMime = 'audio/mp4';
        filename = 'audio.mp4';
        break;
        
      case 'audio/ogg':
      case 'audio/opus':
        audioMime = 'audio/ogg';
        filename = 'audio.ogg';
        break;
        
      default:
        // Keep WebM as WebM (default case)
        audioMime = 'audio/webm';
        filename = 'audio.webm';
    }
    
    // Validate audio headers based on format
    const header = buf.slice(0, 4).toString('hex');
    console.log(`🔍 Audio header: ${header} (format: ${audioMime})`);
    
    // Additional validation for WebM containers
    if (audioMime === 'audio/webm') {
      if (header !== '1a45dfa3') {
        console.log(`❌ Invalid WebM header: ${header}, expected: 1a45dfa3`);
        console.log(`🚫 Rejecting WebM data - only complete containers should be processed`);
        return { text: "Invalid WebM container - only complete containers are supported", words: [] };
      }
      
      // Check for minimum WebM container size
      if (buf.length < 1000) {
        console.log(`❌ WebM container too small: ${buf.length} bytes`);
        return { text: "WebM container too small", words: [] };
      }
      
      console.log(`✅ Valid WebM container detected (${buf.length} bytes)`);
    }
    
    // Add the audio buffer as a file
    formData.append('file', buf, {
      filename: filename,
      contentType: audioMime
    });
    formData.append('model_id', 'scribe_v1');
    formData.append('timestamps_granularity', 'word');
    
    // Make direct API call instead of using SDK
    const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_KEY,
        ...formData.getHeaders()
      },
      body: formData
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ ElevenLabs API error: ${response.status} ${response.statusText}`);
      console.error('Error response:', errorText);
      
      // Handle specific error cases
      if (response.status === 400) {
        try {
          const errorJson = JSON.parse(errorText);
          if (errorJson.detail?.message?.includes('corrupted')) {
            console.log("🔄 Audio appears corrupted - this might be due to WebM container issues");
            console.log(`📊 Audio details: ${buf.length} bytes, format: ${audioMime}, header: ${buf.slice(0, 4).toString('hex')}`);
            return { text: "Audio quality issue - WebM container may be incomplete", words: [] };
          }
        } catch (e) {
          // If we can't parse the error, continue with generic error
        }
      }
      
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }
    
    const result = await response.json();
    console.log("✅ ElevenLabs transcription successful");
    
    // Return both text and word-level data
    return {
      text: result.text || "No transcription available",
      words: result.words || []
    };
    
  } catch (err) {
    console.error("❌ Transcription error:", err);
    console.error("Error details:", err.message);
    
    // Return a more user-friendly error message
    if (err.message.includes('corrupted') || err.message.includes('invalid_content')) {
      return { text: "Audio quality issue - please try again", words: [] };
    }
    
    return { text: "Transcription temporarily unavailable", words: [] };
  }
}

async function summarise(text, customPrompt) {
  try {
    console.log(`🌐 Calling Anthropic API for summarization`);
    const basePrompt = customPrompt || "Summarise the following classroom discussion in ≤6 clear bullet points:";
    
  const body = {
      model: "claude-sonnet-4-20250514",
      max_tokens: 800, // Reduced from 2000 - ultra-efficient prompt needs fewer tokens
      temperature: 0, // Set to 0 for maximum consistency
    messages: [
      {
          role: "user",
          content: `${basePrompt}\n\n${text}`
      }
    ]
  };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
    headers: {
        "x-api-key": process.env.ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
    
    if (!res.ok) {
      console.error(`❌ Anthropic API error: ${res.status} ${res.statusText}`);
      const errorText = await res.text();
      console.error("Error response:", errorText);
      return "Summarization failed";
    }

  const j = await res.json();
    console.log("✅ Anthropic summarization successful");
  return j.content?.[0]?.text?.trim() ?? "(no summary)";
  } catch (err) {
    console.error("❌ Summarization error:", err);
    return "Summarization failed";
  }
}

async function processMindmapTranscript(text, mainTopic, existingNodes = []) {
  try {
    console.log(`🧠 Processing transcript for mindmap...`);
    
    const existingNodesText = existingNodes.length > 0 ? 
      `\n\nExisting mindmap structure:\n${existingNodes.map(node => 
        `${node.level === 0 ? 'MAIN:' : node.level === 1 ? 'TOPIC:' : node.level === 2 ? 'SUBTOPIC:' : 'EXAMPLE:'} ${node.content}`
      ).join('\n')}` : '';
    
    const prompt = `You are analyzing classroom discussion to build a mindmap. The main topic is: "${mainTopic}"

Analyze this new transcript segment and determine:
1. Is this irrelevant chatter that should be ignored? 
2. If relevant, is it a new main point, subpoint, or example?
3. How should it fit into the existing mindmap structure?

${existingNodesText}

New transcript: "${text}"

Respond with JSON in this exact format:
{
  "action": "ignore|add_node",
  "reason": "brief explanation of your decision",
  "node": {
    "content": "the content to add (if action is add_node)",
    "level": 1,
    "parent_id": "id of parent node or null for main topics"
  }
}

Levels: 1=main topic, 2=subtopic, 3=sub-subtopic/example`;

    const body = {
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      temperature: 0.3,
      messages: [
        {
          role: "user",
          content: prompt
        }
      ]
    };

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
    
    if (!res.ok) {
      console.error(`❌ Mindmap processing API error: ${res.status} ${res.statusText}`);
      return { action: "ignore", reason: "API error", node: null };
    }

    const response = await res.json();
    const result = JSON.parse(response.content?.[0]?.text?.trim() ?? '{"action": "ignore", "reason": "parsing error", "node": null}');
    
    console.log("✅ Mindmap processing successful");
    return result;
  } catch (err) {
    console.error("❌ Mindmap processing error:", err);
    return { action: "ignore", reason: "Processing error", node: null };
  }
}

async function processCheckboxTranscript(text, criteria, scenario = "", strictness = 2, existingProgress = []) {
  try {
    console.log(`☑️ Processing transcript for 3-state checkbox evaluation (strictness: ${strictness})...`);
    
    // Check if API key is available
    const apiKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_KEY;
    if (!apiKey) {
      console.log(`🧪 ANTHROPIC API KEY not set - returning mock test data for demonstration`);
      console.log(`🔍 Checked for: ANTHROPIC_API_KEY and ANTHROPIC_KEY environment variables`);
      
      // Return mock matches for testing when API key is not available
      const mockMatches = [];
      
      // Check for some obvious matches in the text for demonstration
      if (text.toLowerCase().includes('back titration') && text.toLowerCase().includes('not soluble')) {
        mockMatches.push({
          criteria_index: 0,
          quote: "back titration is used because CaCO3 is not soluble",
          status: "green"
        });
      }
      
      // Include existing GREEN criteria in the response
      existingProgress.forEach((progress, index) => {
        if (progress && progress.status === 'green') {
          mockMatches.push({
            criteria_index: index,
            quote: progress.quote,
            status: "green"
          });
        }
      });
      
      return {
        matches: mockMatches
      };
    }
    
    console.log(`✅ Using Anthropic API for ${strictness === 1 ? 'LENIENT' : strictness === 2 ? 'MODERATE' : 'STRICT'} transcript analysis`);
    
    // Filter out already GREEN criteria from evaluation
    const criteriaToEvaluate = [];
    const greenCriteria = [];
    
    criteria.forEach((c, i) => {
      const progress = existingProgress[i];
      if (progress && progress.status === 'green') {
        // This criterion is already GREEN - don't re-evaluate
        greenCriteria.push({
          criteria_index: i,
          quote: progress.quote,
          status: "green"
        });
        console.log(`📋 Skipping evaluation for criteria ${i} - already GREEN with quote: "${progress.quote}"`);
      } else {
        // This criterion needs evaluation
        criteriaToEvaluate.push({ ...c, originalIndex: i });
      }
    });
    
    console.log(`📋 Evaluating ${criteriaToEvaluate.length} criteria (skipping ${greenCriteria.length} already GREEN)`);
    
    // If all criteria are already GREEN, just return them
    if (criteriaToEvaluate.length === 0) {
      console.log(`✅ All criteria already GREEN - no evaluation needed`);
      return {
        matches: greenCriteria
      };
    }
    
    // Create detailed criteria text with rubrics for evaluation
    const criteriaText = criteriaToEvaluate.map((c, i) => {
      return `${c.originalIndex}. ${c.description}\n   RUBRIC: ${c.rubric}`;
    }).join('\n\n');
    
    const scenarioContext = scenario ? `\nDiscussion Context/Scenario: ${scenario}\n` : '';
    
    // Adjust evaluation framework based on strictness level
    let evaluationFramework = '';
    
    if (strictness === 1) { // Lenient
      evaluationFramework = `
🟢 GREEN STATUS - Award when:
• Student demonstrates general understanding of the concept
• The main idea is correct, even if some details are missing
• Accept partial explanations that show conceptual grasp
• Be generous with interpretations - if they're on the right track, it's GREEN
• Accept different ways of expressing the same concept

🔴 RED STATUS - Award when:
• Student mentions the topic but shows fundamental misunderstanding
• Major conceptual errors are present
• The core idea is wrong, even if they tried

⚪ GREY STATUS - Award when:
• The topic is NOT discussed at all
• No evidence exists that the student engaged with this concept
• Set quote to null for grey items`;
    } else if (strictness === 3) { // Strict
      evaluationFramework = `
🟢 GREEN STATUS - Award ONLY when:
• Student demonstrates COMPLETE and PRECISE understanding
• ALL rubric requirements must be explicitly addressed
• The explanation must be thorough and accurate
• Every detail specified in the rubric must be present
• No partial credit - it's either fully correct or not

🔴 RED STATUS - Award when:
• Student attempts the topic but ANY rubric requirement is missing
• Even minor inaccuracies or omissions result in RED
• Partial understanding is still RED if not complete

⚪ GREY STATUS - Award when:
• The topic is NOT discussed at all
• No evidence exists that the student engaged with this concept
• Set quote to null for grey items`;
    } else { // Moderate (default)
      evaluationFramework = `
🟢 GREEN STATUS - Award ONLY when:
• Student demonstrates understanding of BOTH the label concept AND the rubric requirements
• The RUBRIC requirements (in parentheses) MUST be addressed (even if expressed differently)
• Accept different ways of expressing the same concept:
  - "0.1 cm³", "0.10 cm cube", "0.1 cubic centimeters" all mean the same thing
  - "2 consistent results" = "two consistent results" = "after 2 consistent titrations"
  - Numbers can be expressed as digits or words
• Their explanation must align with BOTH the label AND the specific rubric details
• Accept phonetic variations (e.g., "metal orange" = "methyl orange") but require conceptual accuracy

🔴 RED STATUS - Award when:
• Student mentions the topic/label but FAILS to address the rubric requirements
• Student attempts the concept but misses key rubric details
• Student shows partial understanding but lacks the specific rubric content
• They demonstrate engagement but don't meet the rubric criteria
• IMPORTANT: If they mention WRONG information (e.g., "10 consistent results" instead of "2"), mark as RED

⚪ GREY STATUS - Award when:
• The topic is NOT discussed at all
• No evidence exists that the student engaged with this concept
• Set quote to null for grey items`;
    }
    
    const prompt = `You are an expert educational evaluator analyzing student discussion transcripts against specific learning objectives. Your task is to provide precise, consistent evaluations using a 3-state system.

${strictness === 1 ? 'EVALUATION MODE: LENIENT - Be generous and focus on conceptual understanding' : 
  strictness === 3 ? 'EVALUATION MODE: STRICT - Require complete and precise answers with all details' : 
  'EVALUATION MODE: MODERATE - Balance conceptual understanding with important details'}

INDEXED OBJECTIVES (use the IDX numbers exactly as shown):
${criteriaToEvaluate.map(c => `IDX ${c.originalIndex}: ${c.description}\nRUBRIC: ${c.rubric}`).join('\n\n')}

IMPORTANT: When you output matches, the "criteria_index" value MUST be one of the IDX numbers shown above. Do not invent or shift indices. If multiple objectives seem possible, choose the single best match by rubric alignment.

STUDENT DISCUSSION TRANSCRIPT:
"${text}"

${scenarioContext}

EVALUATION FRAMEWORK:
${evaluationFramework}

CRITICAL EVALUATION RULES:

1. ${strictness === 1 ? 'FLEXIBLE MATCHING' : strictness === 3 ? 'EXACT MATCHING' : 'INTELLIGENT MATCHING'}:
   ${strictness === 1 ? 
   `- Accept any reasonable interpretation of the concept
   - Partial understanding is often sufficient for GREEN
   - Focus on whether they grasp the main idea` : 
   strictness === 3 ? 
   `- Require precise and complete answers
   - All rubric details must be explicitly stated
   - No assumptions or generous interpretations` :
   `- The rubric content is important but can be expressed differently
   - Accept equivalent expressions and terminology
   - Look for the MEANING, not exact wording`}

2. TRANSCRIPTION ERROR TOLERANCE AND SYNONYMS:
   - Accept phonetically similar terms (metal orange ≈ methyl orange)
   - Units/expressions equivalence: cm³ = cm3 = cm cubed = cubic centimeters
   - Chemical/name equivalence: HCl = hydrochloric acid; CaCO3 = calcium carbonate; insoluble ≈ not soluble
   - Common ASR artifacts: "title volume" ≈ "titre volume"; "titer" ≈ "titre"
   - Accept digit/word variations (2 = two, 0.1 = 0.10)
   - Focus on conceptual understanding over exact pronunciation

3. SPECIFICITY:
   - Map each quote to ONE best objective (do not duplicate a quote across objectives)
   - Prefer the objective whose rubric terms most closely appear in the quote

4. QUOTE SELECTION:
   - For GREEN/RED, include a short exact quote that demonstrates why
   - For GREY, set quote to null

RESPONSE FORMAT (JSON ONLY):
{
  "matches": [ { "criteria_index": <IDX>, "quote": <string|null>, "status": "green|red|grey", "why": <string|null> } ]
}

QUALITY CHECK:
- Use only the provided IDX values
- No explanations outside JSON
- Prefer the objective with the strongest rubric term overlap with the quote

Begin evaluation now:`;

    const body = {
      model: "claude-sonnet-4-20250514", // Using Claude Sonnet 4 as requested
      max_tokens: 2000, // Increased for comprehensive prompt and detailed analysis
      temperature: 0, // Set to 0 for maximum consistency
      messages: [
        {
          role: "user",
          content: prompt
        }
      ]
    };

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
    
    if (!res.ok) {
      console.error(`❌ Checkbox processing API error: ${res.status} ${res.statusText}`);
      return { matches: [] };
    }

    const response = await res.json();
    const responseText = response.content?.[0]?.text?.trim();

    console.log(`🔍 Anthropic response text: "${responseText?.substring(0, 300)}..."`);

    // Robust JSON extraction that tolerates Markdown code fences and extra text
    const extractJson = (text) => {
      if (!text || typeof text !== 'string') return null;
      let t = text.trim();
      // Remove fenced blocks ```json ... ```
      const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fenced) {
        t = fenced[1].trim();
      } else {
        // Strip stray leading/trailing backticks
        t = t.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
      }
      // Direct parse first
      try {
        return JSON.parse(t);
      } catch (_) {
        // Fallback: extract first JSON object substring
        const m = t.match(/\{[\s\S]*\}/);
        if (m) {
          try {
            return JSON.parse(m[0]);
          } catch (_) {
            return null;
          }
        }
        return null;
      }
    };

    let result = extractJson(responseText) || { matches: [] };
    
    // Validate the result structure
    if (!result || typeof result !== 'object') {
      console.warn("⚠️ Invalid response structure (not an object), creating default structure");
      result = { matches: [] };
    }
    
    if (!result.matches || !Array.isArray(result.matches)) {
      console.warn("⚠️ Missing or invalid matches array, creating empty array");
      result.matches = [];
    }
    
    // Validate each match object with 'why' rationale
    result.matches = result.matches.filter(match => {
      // Coerce criteria_index if Anthropic returns string like 'IDX 6' or '6'
      if (typeof match?.criteria_index === 'string') {
        const m = match.criteria_index.match(/(\d+)/);
        if (m) {
          match.criteria_index = Number(m[1]);
        }
      }
      if (typeof match !== 'object' || 
          typeof match.criteria_index !== 'number' ||
          typeof match.status !== 'string') {
        console.warn("⚠️ Invalid match object structure:", match);
        return false;
      }
      
      // Validate quote based on status: grey should have null, others should have string
      if (match.status === 'grey') {
        if (match.quote !== null && match.quote !== undefined) {
          console.warn(`⚠️ Grey status should have null quote, got: ${match.quote}`);
          match.quote = null; // Fix it rather than reject
        }
        if (match.why === undefined) match.why = null;
      } else {
        if (typeof match.quote !== 'string' || match.quote.trim() === '') {
          console.warn(`⚠️ ${match.status} status must have non-empty string quote, got:`, match.quote);
          return false;
        }
        if (typeof match.why !== 'string' || match.why.trim() === '') {
          // Fill a concise default if missing
          match.why = 'Quote aligns with rubric terms for this objective.';
        }
        if (match.why.length > 180) {
          match.why = match.why.slice(0, 180);
        }
      }
      
      // Validate criteria_index is within valid range
      if (match.criteria_index < 0 || match.criteria_index >= criteria.length) {
        console.warn(`⚠️ Invalid criteria_index ${match.criteria_index}. Valid range: 0-${criteria.length - 1}`);
        return false;
      }
      
      // Validate status is one of the allowed values
      if (!['green', 'red', 'grey'].includes(match.status)) {
        console.warn(`⚠️ Invalid status "${match.status}". Must be green, red, or grey`);
        return false;
      }
      
      return true;
    });
    
    // Detect and fix duplicate or near-duplicate quotes across criteria
    const normalizeQuote = (q) => (q || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ') // strip punctuation
      .replace(/\s+/g, ' ') // collapse whitespace
      .trim();

    const nonGrey = result.matches.filter(m => m.status !== 'grey' && typeof m.quote === 'string');
    const seen = new Map(); // normQuote -> {index, score}
    const toGrey = new Set();

    // token overlap scorer reused later; define here for selection
    const scoreOverlapFast = (quote, idx) => {
      if (!quote) return 0;
      const qt = (quote || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
      const dict = new Set((`${criteria[idx]?.description || ''} ${criteria[idx]?.rubric || ''}`).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean));
      let s = 0; for (const t of qt) if (dict.has(t)) s++;
      return s;
    };

    for (const m of nonGrey) {
      const norm = normalizeQuote(m.quote);
      if (!norm) { continue; }
      // Consider substring duplicates too
      let duplicateKey = null;
      for (const key of seen.keys()) {
        if (key.includes(norm) || norm.includes(key)) { duplicateKey = key; break; }
      }
      const keyToUse = duplicateKey || norm;
      if (!seen.has(keyToUse)) {
        seen.set(keyToUse, { index: m.criteria_index, score: scoreOverlapFast(m.quote, m.criteria_index) });
      } else {
        const prev = seen.get(keyToUse);
        const currentScore = scoreOverlapFast(m.quote, m.criteria_index);
        // Keep the better-scoring mapping; grey out the other
        if (currentScore > prev.score) {
          // grey the previous winner
          toGrey.add(prev.index);
          seen.set(keyToUse, { index: m.criteria_index, score: currentScore });
        } else {
          toGrey.add(m.criteria_index);
        }
      }
    }

    if (toGrey.size > 0) {
      console.warn(`🔧 Resolving duplicate quotes across criteria. Greying: [${Array.from(toGrey).join(', ')}]`);
      result.matches.forEach(m => {
        if (toGrey.has(m.criteria_index)) {
          m.status = 'grey';
          m.quote = null;
        }
      });
    }
    
    // Dynamic rerouting based on rubric-driven token overlap (no hardcoded categories)
    const norm = (s) => (s || '').toLowerCase()
      .replace(/title volume/g, 'titre volume')
      .replace(/titer/g, 'titre')
      .replace(/cm\^?3|cubic\s*cent(imetre|imeter)s?|cm\s*cubed/g, 'cm3')
      .replace(/hcl/g, 'hydrochloric acid');

    const STOPWORDS = new Set(['the','and','for','that','this','with','will','must','have','has','are','was','were','can','could','should','would','to','of','in','on','at','by','from','or','as','be','is','a','an','it','we','you','they','between']);
    const tokenize = (s) => norm(s)
      .replace(/[^a-z0-9\.\s]/g,' ')
      .split(/\s+/)
      .filter(w => w && !STOPWORDS.has(w) && w.length > 2);

    const criterionTokens = criteria.map(c => new Set(tokenize(`${c.description} ${c.rubric}`)));

    const scoreOverlap = (quote, idx) => {
      if (!quote) return 0;
      const qt = tokenize(quote);
      const dict = criterionTokens[idx];
      let score = 0;
      for (const t of qt) if (dict.has(t)) score++;
      return score;
    };

    result.matches = result.matches.map(m => {
      if (!m.quote || m.status === 'grey') return m;
      const current = m.criteria_index;
      let bestIdx = current;
      let bestScore = scoreOverlap(m.quote, current);
      for (let i = 0; i < criteria.length; i++) {
        const sc = scoreOverlap(m.quote, i);
        if (sc > bestScore) { bestScore = sc; bestIdx = i; }
      }
      // Reroute only when there is a clear improvement and current match is weak
      if (bestIdx !== current && bestScore >= Math.max(2, bestScore - 0) && bestScore >= (scoreOverlap(m.quote, current) + 2)) {
        console.log(`🔀 Re-routing match from idx=${current} to idx=${bestIdx} based on token overlap (old=${scoreOverlap(m.quote, current)}, new=${bestScore})`);
        return { ...m, criteria_index: bestIdx };
      }
      return m;
    });

    // Cleanup duplicate quotes after rerouting
    (function cleanupDuplicates() {
      const seen = new Map();
      result.matches.forEach(m => {
        if (!m.quote || m.status === 'grey') return;
        const key = m.quote.trim();
        if (!seen.has(key)) { seen.set(key, m.criteria_index); return; }
        if (seen.get(key) !== m.criteria_index) {
          console.warn(`🔧 Removing duplicate quote after reroute from idx=${m.criteria_index}`);
          m.status = 'grey';
          m.quote = null;
        }
      });
    })();
    
    console.log(`✅ 3-state checkbox processing successful: ${result.matches.length} valid matches found`);
    console.log(`📊 Status breakdown:`, result.matches.reduce((acc, match) => {
      acc[match.status] = (acc[match.status] || 0) + 1;
      return acc;
    }, {}));
    
    // Build complete matches array for ALL criteria
    const allMatches = [];
    
    // Process each criterion to ensure we have a match for every one
    criteria.forEach((criterion, index) => {
      // Check if this criterion was in greenCriteria (preserved)
      const greenMatch = greenCriteria.find(m => m.criteria_index === index);
      if (greenMatch) {
        allMatches.push(greenMatch);
        return;
      }
      
      // Check if this criterion was in the AI evaluation results
      const aiMatch = result.matches.find(m => m.criteria_index === index);
      if (aiMatch) {
        allMatches.push(aiMatch);
        return;
      }
      
      // If not found in either, preserve the existing status or default to grey
      const existingProg = existingProgress[index];
      if (existingProg) {
        // Preserve existing RED or GREY status that wasn't re-evaluated
        allMatches.push({
          criteria_index: index,
          quote: existingProg.quote || null,
          status: existingProg.status || 'grey'
        });
      } else {
        // No existing progress, default to grey
        allMatches.push({
          criteria_index: index,
          quote: null,
          status: 'grey'
        });
      }
    });
    
    // Sort by criteria_index for consistent ordering
    allMatches.sort((a, b) => a.criteria_index - b.criteria_index);
    
    console.log(`📊 Complete results: ${allMatches.length} total matches for ${criteria.length} criteria`);
    console.log(`📊 Final status breakdown:`, allMatches.reduce((acc, match) => {
      acc[match.status] = (acc[match.status] || 0) + 1;
      return acc;
    }, {}));
    
    return { matches: allMatches };
  } catch (err) {
    console.error("❌ Checkbox processing error:", err);
    return { matches: [] };
  }
}

// Clean up on server shutdown
process.on('SIGINT', async () => {
  console.log('🛑 Server shutting down...');
  
  // Stop all auto-summary timers
  for (const [sessionCode, timer] of activeSummaryTimers) {
    clearInterval(timer);
    console.log(`⏰ Stopped timer for session ${sessionCode}`);
  }
  
  // Mark all sessions as inactive in database
  await db.collection("sessions").updateMany({}, { $set: { active: false } });
  console.log('💾 Marked all sessions as inactive');
  
  process.exit(0);
});

/* New 30-second chunk transcription endpoint */
app.post("/api/transcribe-chunk", upload.single('file'), async (req, res) => {
  try {
    console.log("📦 Received chunk for transcription");
    
    if (!req.file) {
      return res.status(400).json({ error: "No audio file provided", success: false });
    }
    
    const audioBuffer = req.file.buffer;
    const mimeType = req.file.mimetype;
    const { sessionCode, groupNumber } = req.body;
    
    if (!sessionCode || !groupNumber) {
      return res.status(400).json({ error: "Session code and group number are required", success: false });
    }
    
    console.log(`📁 Processing chunk: ${audioBuffer.length} bytes, mimetype: ${mimeType}, session: ${sessionCode}, group: ${groupNumber}`);
    
    // Enhanced chunk validation
    if (audioBuffer.length < 100) {
      console.log("⚠️ Chunk too small, skipping");
      return res.json({ 
        success: false, 
        message: "Chunk too small (< 100 bytes)",
        transcription: { text: "", words: [] }
      });
    }
    
    if (audioBuffer.length > 10 * 1024 * 1024) { // 10MB limit
      console.log("⚠️ Chunk too large, skipping");
      return res.status(400).json({ error: "Chunk too large (>10MB)", success: false });
    }
    
    // Validate audio format
    const header = audioBuffer.slice(0, 4).toString('hex');
    const validHeaders = {
      '1a45dfa3': 'WebM',
      '52494646': 'WAV/RIFF',
      '00000020': 'MP4',
      '4f676753': 'OGG'
    };
    
    if (!validHeaders[header]) {
      console.log(`⚠️ Unknown audio format, header: ${header}`);
      // Don't reject - ElevenLabs might still be able to process it
    } else {
      console.log(`✅ Detected ${validHeaders[header]} format`);
    }
    
    // Validate WebM containers more strictly
    if (mimeType.includes('webm') && header !== '1a45dfa3') {
      console.log(`❌ Invalid WebM container, header: ${header}`);
      return res.status(400).json({ 
        error: "Invalid WebM container - corrupted audio data", 
        success: false,
        details: `Expected WebM header 1a45dfa3, got ${header}`
      });
    }
    
    // Direct forward to ElevenLabs using form-data with retry logic
    const FormData = (await import('form-data')).default;
    const formData = new FormData();
    
    formData.append('model_id', 'scribe_v1');
    formData.append('file', audioBuffer, {
      filename: req.file.originalname || `chunk_${Date.now()}.webm`,
      contentType: mimeType
    });
    
    console.log("🌐 Forwarding to ElevenLabs Speech-to-Text API...");
    
    const startTime = Date.now();
    let response;
    let retryCount = 0;
    const maxRetries = 3;
    
    // Retry logic for ElevenLabs API
    while (retryCount < maxRetries) {
      try {
        response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
          method: 'POST',
          headers: {
            'xi-api-key': process.env.ELEVENLABS_KEY,
            ...formData.getHeaders()
          },
          body: formData,
          timeout: 30000 // 30 second timeout
        });
        
        if (response.ok) {
          break; // Success, exit retry loop
        } else if (response.status === 429) {
          // Rate limit - wait and retry
          console.log(`⏳ Rate limited, retrying in ${Math.pow(2, retryCount)} seconds...`);
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, retryCount) * 1000));
          retryCount++;
        } else if (response.status >= 500) {
          // Server error - retry
          console.log(`🔄 Server error ${response.status}, retrying...`);
          retryCount++;
          await new Promise(resolve => setTimeout(resolve, 1000));
        } else {
          // Client error - don't retry
          break;
        }
      } catch (fetchError) {
        console.error(`❌ Network error (attempt ${retryCount + 1}):`, fetchError);
        retryCount++;
        if (retryCount < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, retryCount) * 1000));
        }
      }
    }
    
    const processingTime = Date.now() - startTime;
    
    if (!response || !response.ok) {
      let errorText = 'Unknown error';
      try {
        errorText = await response.text();
      } catch (e) {
        // Ignore text parsing errors
      }
      
      console.error(`❌ ElevenLabs API error after ${retryCount} retries: ${response?.status} ${response?.statusText}`);
      console.error('Error response:', errorText);
      
      // Return more specific error messages
      let errorMessage = "Transcription service temporarily unavailable";
      if (response?.status === 400) {
        errorMessage = "Audio format not supported or corrupted";
      } else if (response?.status === 401) {
        errorMessage = "Transcription service authentication failed";
      } else if (response?.status === 429) {
        errorMessage = "Transcription service rate limit exceeded";
      } else if (response?.status >= 500) {
        errorMessage = "Transcription service server error";
      }
      
      return res.status(response?.status || 500).json({ 
        error: errorMessage,
        details: errorText,
        success: false,
        retryCount: retryCount
      });
    }
    
    const result = await response.json();
    console.log(`✅ ElevenLabs transcription successful (${processingTime}ms, ${retryCount} retries)`);
    
    // Use the raw transcription without cleaning
    let transcriptionText = result.text || "";
    
    // Skip empty transcriptions
    if (!transcriptionText.trim()) {
      console.log("⚠️ Empty transcription result, skipping database save");
      return res.json({
        success: true,
        message: "Empty transcription - no speech detected",
        transcription: {
          text: "",
          words: [],
          duration: 0,
          wordCount: 0
        },
        processingTime: `${processingTime}ms`,
        chunkSize: audioBuffer.length
      });
    }
    
    // Save to database and generate summary
    try {
      // Get session and group
      const session = await db.collection("sessions").findOne({ code: sessionCode });
      if (!session) {
        console.log(`⚠️  Session ${sessionCode} not found in database - session may not have started recording yet`);
        return res.json({
          success: true,
          message: "Session not yet persisted - transcription processed but not saved",
          transcription: {
            text: transcriptionText,
            words: result.words || [],
            duration: result.words && result.words.length > 0 ? 
              result.words[result.words.length - 1].end : 
              Math.max(5, Math.min(60, transcriptionText.split(' ').length * 0.5)),
            wordCount: result.words ? result.words.length : 
              transcriptionText.split(' ').filter(w => w.trim().length > 0).length
          },
          processingTime: `${processingTime}ms`,
          chunkSize: audioBuffer.length
        });
      }
      
      // Define the timestamp for this processing
      const now = Date.now();
      
      const group = await db.collection("groups").findOne({ 
        session_id: session._id, 
        number: parseInt(groupNumber) 
      });
      if (!group) {
        console.log(`⚠️  Group ${groupNumber} not found in database - creating new group`);
        
        // Create the group since it doesn't exist
        const newGroupId = uuid();
        await db.collection("groups").insertOne({
          _id: newGroupId,
          session_id: session._id,
          number: parseInt(groupNumber)
        });
        
        console.log(`📝 Created new group: Session ${sessionCode}, Group ${groupNumber}, ID: ${newGroupId}`);
        
        // Continue with the newly created group
        const newGroup = { _id: newGroupId, session_id: session._id, number: parseInt(groupNumber) };
        
        // Save transcription and continue processing with the new group
        await processTranscriptionForGroup(session, newGroup, transcriptionText, result, now, sessionCode, groupNumber);
      } else {
        // Process with existing group
        await processTranscriptionForGroup(session, group, transcriptionText, result, now, sessionCode, groupNumber);
      }
      
      console.log(`✅ Transcription and summary saved for session ${sessionCode}, group ${groupNumber}`);
      
    } catch (dbError) {
      console.error("❌ Database error:", dbError);
      // Still return success for transcription even if DB fails
      return res.json({
        success: true,
        message: "Transcription successful but database save failed",
        transcription: {
          text: transcriptionText,
          words: result.words || [],
          duration: result.words && result.words.length > 0 ? 
            result.words[result.words.length - 1].end : 
            Math.max(5, Math.min(60, transcriptionText.split(' ').length * 0.5)),
          wordCount: result.words ? result.words.length : 
            transcriptionText.split(' ').filter(w => w.trim().length > 0).length
        },
        processingTime: `${processingTime}ms`,
        chunkSize: audioBuffer.length,
        dbError: dbError.message
      });
    }
    
    const finalResult = {
      success: true,
      transcription: {
        text: transcriptionText,
        words: result.words || [],
        duration: result.words && result.words.length > 0 ? 
          result.words[result.words.length - 1].end : 
          Math.max(5, Math.min(60, transcriptionText.split(' ').length * 0.5)),
        wordCount: result.words ? result.words.length : 
          transcriptionText.split(' ').filter(w => w.trim().length > 0).length
      },
      processingTime: `${processingTime}ms`,
      chunkSize: audioBuffer.length,
      retryCount: retryCount
    };
    
    console.log("📝 Chunk transcription result:", {
      text: transcriptionText.substring(0, 100) + (transcriptionText.length > 100 ? "..." : ""),
      wordCount: finalResult.transcription.wordCount,
      duration: finalResult.transcription.duration,
      retries: retryCount
    });
    
    res.json(finalResult);
    
  } catch (err) {
    console.error("❌ Chunk transcription error:", err);
    res.status(500).json({ 
      error: "Internal server error during transcription", 
      details: err.message,
      success: false,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});

// Helper function to process transcription for a group
async function processTranscriptionForGroup(session, group, transcriptionText, result, now, sessionCode, groupNumber) {
  try {
    // Ensure 'now' is defined if not passed
    if (!now) {
      now = Date.now();
    }
    
    // Filter out background noise, music, and non-educational content
    const lowerText = transcriptionText.toLowerCase().trim();
    const noisePatterns = [
      /^\(.*music.*\)$/,
      /^\(.*background.*\)$/,
      /^\(.*noise.*\)$/,
      /^\(.*chattering.*\)$/,
      /^\(.*wind.*blowing.*\)$/,
      /^\(.*keyboard.*\)$/,
      /^\(.*clicking.*\)$/,
      /^\(.*typing.*\)$/,
      /^\(.*computer.*\)$/,
      /^testing,?\s*testing\.?$/,
      /^what the hell/,
      /^okay\.?\s*\(pauses?\)\s*okay/,
      /^cualquiera que sea/,
      /^배경 소음/,
      /^기계음 소리/,
      /^bis zum nächsten mal/,
      /^bis dann/,
      /^haus zu hause/,
      /^kształcenie/,
      /^klikanie/,
      /^geräusch vom tippen/,
      /^ronco de moto/,
      /^\(.*sounds?\)$/,
      /^\(.*audio.*\)$/,
      /^\(.*mechanical.*\)$/
    ];
    
    const isNoise = noisePatterns.some(pattern => pattern.test(lowerText)) ||
                   lowerText.length < 15 || // Increased from 10 to 15 - too short to be meaningful
                   /^[\(\)\s\.,!?]*$/.test(lowerText) || // Only punctuation/parentheses
                   /^\([^)]*\)\s*\([^)]*\)$/.test(lowerText); // Only parenthetical descriptions
    
    if (isNoise) {
      console.log(`🔇 Noise/background transcript (still logging to UI): "${transcriptionText.substring(0, 50)}..."`);
      // Log minimal transcript entry for timeline
      const transcriptId = uuid();
      const noiseRecord = createTranscriptRecord({
        id: transcriptId,
        sessionId: session._id,
        groupId: group._id,
        text: transcriptionText,
        wordCount: transcriptionText.split(' ').filter(w => w.trim().length > 0).length,
        durationSeconds: 0,
        createdAt: now,
        segmentNumber: Math.floor(now / (session.interval_ms || 30000)),
        isNoise: true
      });
      const appended = await appendTranscriptSegment({
        sessionId: noiseRecord.sessionId,
        groupId: noiseRecord.groupId,
        segment: noiseRecord.segment
      });
      await trimTranscriptSegments({
        sessionId: noiseRecord.sessionId,
        groupId: noiseRecord.groupId,
        record: appended.record,
        segments: appended.segments
      });
      // Emit to teacher so transcript list shows every update
      io.to(sessionCode).emit("admin_update", {
        group: groupNumber,
        latestTranscript: transcriptionText,
        checkboxUpdates: [],
        isActive: true
      });
      return; // Do not run AI processing for noise
    }
    
    // Save the transcription segment
    const transcriptId = uuid();
    
    const wordCount = result.words && result.words.length > 0 ? 
      result.words.length : 
      transcriptionText.split(' ').filter(w => w.trim().length > 0).length;
    
    const duration = result.words && result.words.length > 0 ? 
      result.words[result.words.length - 1].end : 
      Math.max(5, Math.min(60, transcriptionText.split(' ').length * 0.5));
    
    const transcriptRecord = createTranscriptRecord({
      id: transcriptId,
      sessionId: session._id,
      groupId: group._id,
      text: transcriptionText,
      wordCount,
      durationSeconds: duration,
      createdAt: now,
      segmentNumber: Math.floor(now / (session.interval_ms || 30000)),
      isNoise: false
    });

    const appendOutcome = await appendTranscriptSegment({
      sessionId: transcriptRecord.sessionId,
      groupId: transcriptRecord.groupId,
      segment: transcriptRecord.segment
    });
    
    // Check if this is a checkbox mode session
    if (session.mode === "checkbox") {
      console.log(`☑️ Processing checkbox mode transcript for session ${sessionCode}, group ${groupNumber}`);
      
      // Get checkbox session data and criteria
      const checkboxSession = await db.collection("checkbox_sessions").findOne({ session_id: session._id });
      const criteria = await db.collection("checkbox_criteria")
        .find({ session_id: session._id })
        .sort({ order_index: 1, created_at: 1 })
        .toArray();
      
      if (criteria.length > 0) {
        // Get the entire conversation so far for this group (full context)
        const allTranscriptsForGroup = appendOutcome.segments;
        
        // Join everything up to the current point
        const concatenatedText = allTranscriptsForGroup.map(t => t.text).join(' ').trim();
        
        console.log(`📋 Using FULL context for checkbox analysis: ${allTranscriptsForGroup.length} segments`);
        
        // Get existing progress for this group to avoid re-evaluating GREEN criteria
        const existingProgressRecords = await db.collection("checkbox_progress")
          .find({ 
            session_id: session._id,
            group_number: groupNumber 
          })
          .toArray();
        
        // Build existing progress array indexed by criteria position
        const existingProgress = [];
        criteria.forEach((c, idx) => {
          const progress = existingProgressRecords.find(p => p.criteria_id === c._id);
          if (progress) {
            existingProgress[idx] = {
              status: progress.status,
              quote: progress.quote,
              completed: progress.completed
            };
          } else {
            existingProgress[idx] = null;
          }
        });
        
        console.log(`📋 Found ${existingProgressRecords.length} existing progress records`);
        const greenCount = existingProgress.filter(p => p && p.status === 'green').length;
        if (greenCount > 0) {
          console.log(`📋 Preserving ${greenCount} GREEN criteria from previous evaluations`);
        }
        
        // Process through checkbox analysis with concatenated text
        const scenario = checkboxSession?.scenario || "";
        const strictness = session.strictness || 2; // Get strictness from session, default to moderate
        const checkboxResult = await processCheckboxTranscript(concatenatedText.trim(), criteria, scenario, strictness, existingProgress);
        
        // Log the checkbox processing result
        await db.collection("session_logs").insertOne({
          _id: uuid(),
          session_id: session._id,
          type: "checkbox_analysis",
          content: concatenatedText.trim(),
          ai_response: checkboxResult,
          created_at: now
        });
        
        // Update progress for matched criteria
        const progressUpdates = [];
        for (const match of checkboxResult.matches) {
          const criterion = criteria[match.criteria_index];
          if (criterion) {
            // Check existing progress to implement proper locking rules
            const existingProgress = await db.collection("checkbox_progress").findOne({
              session_id: session._id,
              criteria_id: criterion._id
            });
            
            // Implement locking rules:
            // 1. GREEN stays GREEN forever (locked)
            // 2. GREY has no quotes and can become RED or GREEN
            // 3. RED can become GREEN but not GREY
            let shouldUpdate = false;
            let newStatus = match.status;
            let newQuote = match.status === 'grey' ? null : match.quote; // Grey has no quotes
            
            if (!existingProgress) {
              // No existing progress - always update
              shouldUpdate = true;
            } else if (existingProgress.status === 'green') {
              // GREEN is locked - never update
              console.log(`📋 Criteria ${match.criteria_index} already GREEN (locked) with quote: "${existingProgress.quote}" - skipping update`);
              shouldUpdate = false;
            } else if (existingProgress.status === 'grey') {
              // GREY can become RED or GREEN
              if (match.status === 'red' || match.status === 'green') {
                shouldUpdate = true;
                console.log(`📋 Criteria ${match.criteria_index} upgrading from GREY to ${match.status.toUpperCase()}`);
              }
            } else if (existingProgress.status === 'red') {
              // RED can only become GREEN
              if (match.status === 'green') {
                shouldUpdate = true;
                console.log(`📋 Criteria ${match.criteria_index} upgrading from RED to GREEN`);
              } else {
                console.log(`📋 Criteria ${match.criteria_index} staying RED - cannot downgrade to ${match.status.toUpperCase()}`);
                shouldUpdate = false;
              }
            }
            
            if (shouldUpdate) {
              await db.collection("checkbox_progress").findOneAndUpdate(
                { 
                  session_id: session._id,
                  criteria_id: criterion._id,
                  group_number: groupNumber  // Add group_number to the query
                },
                {
                  $set: {
                    completed: newStatus === 'green', // Only mark as completed if green
                    quote: newQuote, // No quote for grey status
                    status: newStatus,
                    completed_at: now,
                    group_number: groupNumber  // Ensure group_number is set
                  }
                },
                { upsert: true }
              );
              
              // Emit using both stable DB criteria_id and display index to avoid off-by-one errors
              progressUpdates.push({
                criteriaId: match.criteria_index,
                criteriaDbId: criterion._id,
                description: criterion.description,
                completed: match.status === 'green',
                quote: match.quote,
                status: match.status
              });
              
              console.log(`📋 Checkbox update for criteria idx=${match.criteria_index} (_id=${criterion._id}): "${match.quote}" - STATUS: ${match.status}`);
            } else {
              console.log(`📋 Criteria ${match.criteria_index} already completed with quote: "${existingProgress.quote}" - skipping update`);
            }
          }
        }
        
        console.log(`📤 Sending ${progressUpdates.length} checkbox updates to admin for group ${groupNumber}`);
        
        // Send checkbox updates to admin
        io.to(sessionCode).emit("admin_update", {
          group: groupNumber,
          latestTranscript: transcriptionText,
          checkboxUpdates: progressUpdates,
          isActive: true
        });
        
        
        // NEW: Also emit full checklist state to both teachers and students
        // Get the current release state from database
        const checkboxSessionData = await db.collection("checkbox_sessions").findOne({ session_id: session._id });
        const isReleased = checkboxSessionData?.released_groups?.[groupNumber] || false;
        
        // Get all current progress for this group
        const allProgress = await db.collection("checkbox_progress").find({
          session_id: session._id,
          group_number: groupNumber
        }).toArray();
        
        // Build complete checklist state
        const checklistData = {
          groupNumber: groupNumber,
          criteria: criteria.map((c, idx) => {
            const progress = allProgress.find(p => p.criteria_id === c._id);
            return {
              id: idx, // stable index based on sorted order_index
              dbId: c._id,
              description: c.description,
              rubric: c.rubric || '',
              status: progress?.status || 'grey',
              completed: progress?.completed || false,
              quote: progress?.quote || null
            };
          }),
          scenario: checkboxSession?.scenario || "",
          timestamp: Date.now(),
          isReleased: isReleased,  // Controls student visibility
          sessionCode: sessionCode
        };
        
        console.log(`📨 Emitting checklist state to all (released: ${isReleased})`);
        
        // Emit to everyone in session
        io.to(sessionCode).emit('checklist_state', checklistData);
        io.to(`${sessionCode}-${groupNumber}`).emit('checklist_state', checklistData);
        // Cache latest state
        latestChecklistState.set(`${sessionCode}-${groupNumber}`, checklistData);
        
        // Send transcription to students in checkbox mode
        const roomName = `${sessionCode}-${groupNumber}`;
        io.to(roomName).emit("transcription_and_summary", {
          transcription: {
            text: transcriptionText, // Current chunk only
            cumulativeText: concatenatedText, // Full recent conversation
            words: result.words,
            duration: duration,
            wordCount: wordCount
          },
          summary: "Checkbox mode: Real-time discussion analysis", // Simple summary for checkbox mode
          isLatestSegment: true
        });
        
        console.log(`✅ Checkbox analysis complete: ${checkboxResult.matches.length} criteria matched for group ${groupNumber}`);
      }
      
    } else {
    // Regular summary mode processing
      console.log(`📝 Processing summary mode transcript for session ${sessionCode}, group ${groupNumber}`);
    
    // Get all transcripts for this group to create cumulative conversation
    const allTranscripts = appendOutcome.segments;
    
    // Create cumulative conversation text (chronological order)
    const cumulativeText = allTranscripts.map(t => t.text).join(' ');
    
    // Generate summary of the entire conversation so far
    console.log("🤖 Generating summary of full conversation...");
    
    // Get custom prompt for this session
    // Resolve the latest prompt: prefer memory cache, fall back to DB
    let customPrompt = activeSessions.get(sessionCode)?.customPrompt || null;
    if (!customPrompt && session) {
      const promptData = await db.collection("session_prompts").findOne({ session_id: session._id });
      customPrompt = promptData?.prompt || null;
    }
    
    const summary = await summarise(cumulativeText, customPrompt);
    
    // Save/update the summary
    await db.collection("summaries").findOneAndUpdate(
      { group_id: group._id },
      { $set: createSummaryUpdateFields({ sessionId: session._id, text: summary, timestamp: now }) },
      { upsert: true }
    );
    
    // Send both new transcription and updated summary to clients
    const roomName = `${sessionCode}-${groupNumber}`;
    io.to(roomName).emit("transcription_and_summary", {
      transcription: {
        text: transcriptionText, // Current chunk only
        cumulativeText: cumulativeText, // Full conversation so far
        words: result.words,
        duration: duration,
        wordCount: wordCount
      },
      summary,
      isLatestSegment: true
    });
    
    // Send update to admin console
    io.to(sessionCode).emit("admin_update", {
      group: groupNumber,
      latestTranscript: transcriptionText,
      cumulativeTranscript: cumulativeText, // Add full conversation for admin
      transcriptDuration: duration,
      transcriptWordCount: wordCount,
      summary,
      stats: {
        totalSegments: appendOutcome.stats.total_segments,
        totalWords: appendOutcome.stats.total_words,
        totalDuration: appendOutcome.stats.total_duration,
        lastUpdate: appendOutcome.stats.last_update || new Date(now).toISOString()
      }
    });
    }
    
    // Clean up old transcripts to prevent memory issues (keep last 100 per group)
    await trimTranscriptSegments({
      sessionId: transcriptRecord.sessionId,
      groupId: transcriptRecord.groupId,
      record: appendOutcome.record,
      segments: appendOutcome.segments
    });
    
  } catch (error) {
    console.error(`❌ Error processing transcription for group ${groupNumber}:`, error);
    throw error;
  }
}

/* Test mode detection endpoint */
app.post("/api/checkbox/test", express.json(), async (req, res) => {
  try {
    const { sessionCode, transcript } = req.body;
    
    console.log(`🧪 TEST MODE ACTIVATED for session ${sessionCode}`);
    console.log(`🧪 Test transcript length: ${transcript?.length || 0} characters`);
    console.log(`🧪 Test transcript preview: "${transcript?.substring(0, 100)}..."`);
    
    // Forward to regular checkbox processing but with test logging
    const result = await processTestTranscript(sessionCode, transcript);
    
    console.log(`🧪 TEST RESULT: ${result.matches?.length || 0} matches found`);
    if (result.matches?.length > 0) {
      result.matches.forEach((match, index) => {
        console.log(`🧪 Match ${index + 1}: Criteria ${match.criteria_index} - "${match.quote}"`);
      });
    }
    
    res.json(result);
  } catch (err) {
    console.error('🧪 TEST MODE ERROR:', err);
    res.status(500).json({ error: err.message, matches: [], reason: "Test mode error" });
  }
});

async function processTestTranscript(sessionCode, transcript) {
  // Get session info
  const session = await db.collection("sessions").findOne({ code: sessionCode });
  if (!session) {
    throw new Error("Session not found");
  }

  // Get criteria
  const criteria = await db.collection("checkbox_criteria")
    .find({ session_id: session._id })
    .sort({ order_index: 1, created_at: 1 })
    .toArray();

  if (criteria.length === 0) {
    throw new Error("No criteria found for session");
  }

  console.log(`🧪 Processing test transcript against ${criteria.length} criteria`);

  // Get scenario
  const checkboxSession = await db.collection("checkbox_sessions").findOne({ session_id: session._id });
  const scenario = checkboxSession?.scenario || "";

  // Process with AI
  return await processCheckboxTranscript(transcript, criteria, scenario);
}

/* New mindmap-specific chunk transcription endpoint */
app.post("/api/transcribe-mindmap-chunk", upload.single('file'), async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { sessionCode, mode } = req.body;
    const file = req.file;
    
    if (!file || !sessionCode) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing file or session code' 
      });
    }

    console.log(`📦 Received mindmap chunk for transcription`);
    console.log(`📁 Processing mindmap chunk: ${file.size} bytes, session: ${sessionCode}`);

    // Get session data
    const session = await db.collection("sessions").findOne({ code: sessionCode });
    if (!session) {
      return res.status(404).json({ 
        success: false, 
        error: 'Session not found' 
      });
    }

    // Transcribe the audio chunk
    console.log(`🎯 Transcribing audio chunk...`);
    const transcriptionResult = await transcribe(file.buffer, file.mimetype);
    
    // Extract transcript text properly
    let transcript = '';
    if (typeof transcriptionResult === 'string') {
      transcript = transcriptionResult;
    } else if (transcriptionResult && transcriptionResult.text) {
      transcript = transcriptionResult.text;
    } else if (transcriptionResult) {
      // Handle other possible formats
      transcript = String(transcriptionResult);
    }
    
    // Ensure we have a valid string
    transcript = String(transcript || '').trim();
    
    if (!transcript || transcript.length === 0) {
      return res.json({
        success: true,
        transcript: '',
        message: 'No speech detected in audio chunk',
        mindmapData: null
      });
    }

    console.log(`📝 Transcription successful: "${transcript}"`);
    
    // Add to transcript history for context
    addToTranscriptHistory(sessionCode, transcript);
    
    // Get contextual transcript (current + previous 2 chunks)
    const contextualTranscript = getContextualTranscript(sessionCode);

    // Get current mindmap state
    const currentMindmapData = await getMindmapData(sessionCode);
    
    let result;
    let mindmapData = null;

    if (!currentMindmapData || !currentMindmapData.children || currentMindmapData.children.length === 0) {
      // Generate initial mindmap with contextual transcript
      console.log(`🧠 Generating initial mindmap from transcript...`);
      mindmapData = await generateInitialMindmap(contextualTranscript, session.main_topic);
      
      if (mindmapData) {
        // Store the initial mindmap
        await db.collection("sessions").updateOne(
          { code: sessionCode },
          { 
            $set: { 
              mindmap_data: mindmapData,
              last_updated: new Date()
            }
          }
        );
        
        result = {
          success: true,
          transcript: transcript,
          mindmapData: mindmapData,
          message: `Initial mindmap created with contextual analysis`,
          rawAiResponse: `Generated from ${sessionTranscriptHistory.get(sessionCode)?.length || 1} chunks of context`
        };
      } else {
        // No meaningful content found
        result = {
          success: true,
          transcript: transcript,
          mindmapData: currentMindmapData,
          message: 'No academic content detected in speech',
          filtered: true
        };
      }
    } else {
      // Expand existing mindmap with contextual transcript
      console.log(`🧠 Expanding mindmap with contextual speech...`);
      const expansionResult = await expandMindmap(contextualTranscript, currentMindmapData, session.main_topic);
      
      if (!expansionResult.filtered) {
        // Update mindmap in database
        await db.collection("sessions").updateOne(
          { code: sessionCode },
          { 
            $set: { 
              mindmap_data: expansionResult.updatedMindmap,
              last_updated: new Date()
            }
          }
        );
        
        mindmapData = expansionResult.updatedMindmap;
      } else {
        mindmapData = currentMindmapData; // Keep existing mindmap unchanged
      }
      
      result = {
        success: true,
        transcript: transcript,
        mindmapData: mindmapData,
        message: expansionResult.explanation,
        rawAiResponse: expansionResult.rawResponse,
        filtered: expansionResult.filtered
      };
    }

    const processingTime = Date.now() - startTime;
    console.log(`✅ Mindmap chunk processed successfully in ${processingTime}ms`);
    
    res.json(result);

  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error(`❌ Error processing mindmap chunk (${processingTime}ms):`, error);
    
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to process mindmap chunk',
      transcript: '',
      mindmapData: null
    });
  }
});

// Cleanup function for inactive sessions (called on server shutdown)
async function markAllSessionsInactive() {
  try {
    const result = await db.collection("sessions").updateMany(
      { active: true },
      { 
        $set: { 
          active: false, 
          ended_at: new Date() 
        } 
      }
    );
    
    // Clear all transcript histories
    sessionTranscriptHistory.clear();
    console.log("🗑️ Cleared all transcript histories");
    
    console.log(`💾 Marked ${result.modifiedCount} sessions as inactive`);
  } catch (error) {
    console.error("❌ Error marking sessions inactive:", error);
  }
}

// ... existing code ...

// Enhanced session cleanup
app.delete("/api/sessions/:sessionCode", async (req, res) => {
  try {
    const { sessionCode } = req.params;
    
    // Stop auto-summary if running
    stopAutoSummary(sessionCode);
    
    // Clear transcript history
    clearTranscriptHistory(sessionCode);
    
    // Remove from active sessions
    activeSessions.delete(sessionCode);
    
    // Mark session as inactive in database
    await db.collection("sessions").updateOne(
      { code: sessionCode },
      { 
        $set: { 
          active: false,
          ended_at: new Date()
        }
      }
    );

    res.json({ success: true, message: "Session ended successfully" });
  } catch (error) {
    console.error("❌ Error ending session:", error);
    res.status(500).json({ success: false, error: "Failed to end session" });
  }
});

/* ---------- Comprehensive Data Access API ---------- */

/* Get all sessions with comprehensive data across all modes */
app.get("/api/data/sessions", async (req, res) => {
  try {
    const { limit = 20, offset = 0, mode = null } = req.query;
    
    console.log(`📊 Fetching comprehensive session data (limit: ${limit}, offset: ${offset}, mode: ${mode})`);
    
    // Build query filter
    const query = {};
    if (mode && ['summary', 'mindmap', 'checkbox'].includes(mode)) {
      query.mode = mode;
    }
    
    // Get sessions
    const sessions = await db.collection("sessions")
      .find(query)
      .sort({ created_at: -1 })
      .skip(parseInt(offset))
      .limit(parseInt(limit))
      .toArray();
    
    const enrichedSessions = [];
    
    for (const session of sessions) {
      let sessionData = {
        ...session,
        groups: [],
        totalTranscripts: 0,
        totalStudents: 0,
        duration: session.end_time ? session.end_time - session.start_time : null,
        modeSpecificData: null
      };
      
      // Get groups for this session
      const groups = await db.collection("groups")
        .find({ session_id: session._id })
        .sort({ number: 1 })
        .toArray();
      
      for (const group of groups) {
        const { segments, stats } = await getTranscriptBundle(session._id, group._id);
        const summary = await db.collection("summaries").findOne({ group_id: group._id });
        const latestSegment = segments.length > 0 ? segments[segments.length - 1] : null;

        sessionData.groups.push({
          ...group,
          transcriptCount: stats.total_segments,
          latestTranscript: latestSegment ? {
            ...segmentToTranscript(latestSegment),
            created_at: latestSegment.created_at
          } : null,
          summary: summary ? summary.text : null,
          summaryTimestamp: summary ? summary.updated_at : null
        });
        
        sessionData.totalTranscripts += stats.total_segments;
        sessionData.totalStudents += 1; // Each group represents student participation
      }
      
      // Add mode-specific data
      if (session.mode === 'mindmap') {
        const mindmapSession = await db.collection("mindmap_sessions")
          .findOne({ session_id: session._id });
        const mindmapArchive = await db.collection("mindmap_archives")
          .findOne({ session_id: session._id });
        
        sessionData.modeSpecificData = {
          mainTopic: mindmapSession?.main_topic || session.main_topic,
          nodeCount: mindmapArchive?.node_count || 0,
          chatHistory: mindmapSession?.chat_history || [],
          mindmapData: mindmapArchive?.mindmap_data || mindmapSession?.current_mindmap
        };
      } else if (session.mode === 'checkbox') {
        const checkboxSession = await db.collection("checkbox_sessions")
          .findOne({ session_id: session._id });
        const criteria = await db.collection("checkbox_criteria")
          .find({ session_id: session._id })
          .sort({ order_index: 1, created_at: 1 })
          .toArray();
        const progress = await db.collection("checkbox_progress")
          .find({ session_id: session._id })
          .toArray();
        
        const completedCount = progress.filter(p => p.completed).length;
        const totalCriteria = criteria.length;
        
        sessionData.modeSpecificData = {
          scenario: checkboxSession?.scenario || "",
          totalCriteria: totalCriteria,
          completedCriteria: completedCount,
          completionRate: totalCriteria > 0 ? Math.round((completedCount / totalCriteria) * 100) : 0,
          criteria: criteria.map(c => {
            const prog = progress.find(p => p.criteria_id === c._id);
            return {
              description: c.description,
              completed: prog?.completed || false,
              quote: prog?.quote || null,
              completedAt: prog?.completed_at || null
            };
          })
        };
      }
      
      enrichedSessions.push(sessionData);
    }
    
    // Get total count for pagination
    const totalCount = await db.collection("sessions").countDocuments(query);
    
    res.json({
      success: true,
      sessions: enrichedSessions,
      pagination: {
        total: totalCount,
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: parseInt(offset) + parseInt(limit) < totalCount
      },
      summary: {
        totalSessions: totalCount,
        modesAvailable: ['summary', 'mindmap', 'checkbox']
      }
    });
    
  } catch (err) {
    console.error("❌ Failed to fetch comprehensive session data:", err);
    res.status(500).json({ error: "Failed to fetch session data" });
  }
});

/* Get detailed data for a specific session */
app.get("/api/data/session/:sessionCode", async (req, res) => {
  try {
    const { sessionCode } = req.params;
    
    console.log(`📊 Fetching detailed data for session: ${sessionCode}`);
    
    // Get session
    const session = await db.collection("sessions").findOne({ code: sessionCode });
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }
    
    // Get groups with full transcript data
    const groups = await db.collection("groups")
      .find({ session_id: session._id })
      .sort({ number: 1 })
      .toArray();
    
    const detailedGroups = [];
    for (const group of groups) {
      const { segments, stats } = await getTranscriptBundle(session._id, group._id);
      const summary = await db.collection("summaries").findOne({ group_id: group._id });
      detailedGroups.push({
        ...group,
        transcripts: segments.map((segment) => ({
          ...segmentToTranscript(segment),
          created_at: segment.created_at ? new Date(segment.created_at).toISOString() : null
        })),
        transcriptStats: {
          totalSegments: stats.total_segments,
          totalWords: stats.total_words,
          totalDuration: stats.total_duration,
          lastUpdate: stats.last_update ? new Date(stats.last_update).toISOString() : null
        },
        summary: summary
      });
    }
    
    // Get mode-specific detailed data
    let modeSpecificData = null;
    if (session.mode === 'mindmap') {
      const mindmapSession = await db.collection("mindmap_sessions")
        .findOne({ session_id: session._id });
      const mindmapArchive = await db.collection("mindmap_archives")
        .findOne({ session_id: session._id });
      const logs = await db.collection("session_logs")
        .find({ session_id: session._id })
        .sort({ created_at: 1 })
        .toArray();
      
      modeSpecificData = {
        mindmapSession,
        mindmapArchive,
        processingLogs: logs
      };
    } else if (session.mode === 'checkbox') {
      const checkboxSession = await db.collection("checkbox_sessions")
        .findOne({ session_id: session._id });
      const criteria = await db.collection("checkbox_criteria")
        .find({ session_id: session._id })
        .sort({ order_index: 1, created_at: 1 })
        .toArray();
      const progress = await db.collection("checkbox_progress")
        .find({ session_id: session._id })
        .toArray();
      const logs = await db.collection("session_logs")
        .find({ session_id: session._id })
        .sort({ created_at: 1 })
        .toArray();
      
      modeSpecificData = {
        checkboxSession,
        criteria,
        progress,
        processingLogs: logs
      };
    }
    
    res.json({
      success: true,
      session: session,
      groups: detailedGroups,
      modeSpecificData: modeSpecificData,
      stats: {
        totalGroups: detailedGroups.length,
        totalTranscripts: detailedGroups.reduce((sum, g) => sum + g.transcripts.length, 0),
        duration: session.end_time ? session.end_time - session.start_time : null,
        durationFormatted: session.end_time ? 
          formatDuration(session.end_time - session.start_time) : "In progress"
      }
    });
    
  } catch (err) {
    console.error(`❌ Failed to fetch detailed session data for ${req.params.sessionCode}:`, err);
    res.status(500).json({ error: "Failed to fetch session details" });
  }
});

/* Helper function to format duration */
function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

// ... existing code ...

/* ---------- Teacher Prompt Management API ---------- */

/* Get all prompts with filtering and search */
app.get("/api/prompts", async (req, res) => {
  try {
    const { 
      search = "", 
      category = "", 
      mode = "", 
      limit = 50, 
      offset = 0,
      sortBy = "created_at",
      sortOrder = "desc"
    } = req.query;
    
    console.log(`📝 Fetching prompts (search: "${search}", category: "${category}", mode: "${mode}")`);
    
    const baseFilter = {};
    if (category) baseFilter.category = category;
    if (mode) baseFilter.mode = mode;
    
    // Load matching prompts (filtering by category/mode at the database level)
    const matchingPrompts = await db.collection("teacher_prompts")
      .find(baseFilter)
      .toArray();
    
    // Apply search filtering in application layer for portability
    const trimmedSearch = search.trim().toLowerCase();
    let filteredPrompts = matchingPrompts;
    if (trimmedSearch) {
      filteredPrompts = matchingPrompts.filter((prompt) => {
        const haystack = [
          prompt.title || "",
          prompt.description || "",
          prompt.content || "",
          prompt.authorName || "",
          ...(Array.isArray(prompt.tags) ? prompt.tags : [])
        ].join(" ").toLowerCase();
        return haystack.includes(trimmedSearch);
      });
    }
    
    // Sorting
    const allowedSortFields = new Set(["created_at", "updated_at", "usage_count", "views", "title"]);
    const sortField = allowedSortFields.has(sortBy) ? sortBy : "created_at";
    const sortMultiplier = sortOrder === "asc" ? 1 : -1;
    
    filteredPrompts.sort((a, b) => {
      const aVal = a?.[sortField];
      const bVal = b?.[sortField];
      
      if (typeof aVal === "string" && typeof bVal === "string") {
        return sortMultiplier * aVal.localeCompare(bVal);
      }
      return sortMultiplier * (((aVal ?? 0) > (bVal ?? 0)) - ((aVal ?? 0) < (bVal ?? 0)));
    });
    
    const totalCount = filteredPrompts.length;
    const start = parseInt(offset);
    const end = start + parseInt(limit);
    const paginatedPrompts = filteredPrompts.slice(start, end);
    
    // Get categories and modes for filtering
    const categories = await db.collection("teacher_prompts").distinct("category");
    const modes = await db.collection("teacher_prompts").distinct("mode");
    
    res.json({
      success: true,
      prompts: paginatedPrompts,
      pagination: {
        total: totalCount,
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: parseInt(offset) + parseInt(limit) < totalCount
      },
      filters: {
        categories: categories.sort(),
        modes: modes.sort()
      }
    });
    
  } catch (err) {
    console.error("❌ Failed to fetch prompts:", err);
    res.status(500).json({ error: "Failed to fetch prompts" });
  }
});

/* Get a specific prompt by ID */
app.get("/api/prompts/:id", async (req, res) => {
  try {
    const { id } = req.params;
    
    console.log(`📝 Fetching prompt: ${id}`);
    
    const prompt = await db.collection("teacher_prompts").findOne({ _id: id });
    if (!prompt) {
      return res.status(404).json({ error: "Prompt not found" });
    }
    
    // Increment view count
    await db.collection("teacher_prompts").updateOne(
      { _id: id },
      { 
        $inc: { views: 1 },
        $set: { last_viewed: Date.now() }
      }
    );
    
    res.json({
      success: true,
      prompt: prompt
    });
    
  } catch (err) {
    console.error(`❌ Failed to fetch prompt ${req.params.id}:`, err);
    res.status(500).json({ error: "Failed to fetch prompt" });
  }
});

/* Create a new prompt */
app.post("/api/prompts", express.json(), async (req, res) => {
  try {
    const { 
      title, 
      description, 
      content, 
      category, 
      mode, 
      tags = [], 
      isPublic = true,
      authorName = "Anonymous Teacher"
    } = req.body;
    
    if (!title || !content) {
      return res.status(400).json({ error: "Title and content are required" });
    }
    
    console.log(`📝 Creating new prompt: "${title}"`);
    
    const promptId = uuid();
    const now = Date.now();
    
    const newPrompt = {
      _id: promptId,
      title: title.trim(),
      description: description ? description.trim() : "",
      content: content.trim(),
      category: category || "General",
      mode: mode || "summary",
      tags: Array.isArray(tags) ? tags.map(tag => tag.trim()).filter(tag => tag.length > 0) : [],
      isPublic: Boolean(isPublic),
      authorName: authorName.trim(),
      created_at: now,
      updated_at: now,
      views: 0,
      last_viewed: null,
      usage_count: 0,
      last_used: null
    };
    
    await db.collection("teacher_prompts").insertOne(newPrompt);
    
    res.json({
      success: true,
      prompt: newPrompt,
      message: "Prompt created successfully"
    });
    
  } catch (err) {
    console.error("❌ Failed to create prompt:", err);
    res.status(500).json({ error: "Failed to create prompt" });
  }
});

/* Update an existing prompt */
app.put("/api/prompts/:id", express.json(), async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      title, 
      description, 
      content, 
      category, 
      mode, 
      tags = [], 
      isPublic,
      authorName
    } = req.body;
    
    if (!title || !content) {
      return res.status(400).json({ error: "Title and content are required" });
    }
    
    console.log(`📝 Updating prompt: ${id}`);
    
    const updateData = {
      title: title.trim(),
      description: description ? description.trim() : "",
      content: content.trim(),
      category: category || "General",
      mode: mode || "summary",
      tags: Array.isArray(tags) ? tags.map(tag => tag.trim()).filter(tag => tag.length > 0) : [],
      updated_at: Date.now()
    };
    
    if (typeof isPublic === 'boolean') updateData.isPublic = isPublic;
    if (authorName) updateData.authorName = authorName.trim();
    
    const result = await db.collection("teacher_prompts").updateOne(
      { _id: id },
      { $set: updateData }
    );
    
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "Prompt not found" });
    }
    
    const updatedPrompt = await db.collection("teacher_prompts").findOne({ _id: id });
    
    res.json({
      success: true,
      prompt: updatedPrompt,
      message: "Prompt updated successfully"
    });
    
  } catch (err) {
    console.error(`❌ Failed to update prompt ${req.params.id}:`, err);
    res.status(500).json({ error: "Failed to update prompt" });
  }
});

/* Delete a prompt */
app.delete("/api/prompts/:id", async (req, res) => {
  try {
    const { id } = req.params;
    
    console.log(`📝 Deleting prompt: ${id}`);
    
    const result = await db.collection("teacher_prompts").deleteOne({ _id: id });
    
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Prompt not found" });
    }
    
    res.json({
      success: true,
      message: "Prompt deleted successfully"
    });
    
  } catch (err) {
    console.error(`❌ Failed to delete prompt ${req.params.id}:`, err);
    res.status(500).json({ error: "Failed to delete prompt" });
  }
});

/* Use/apply a prompt (increments usage counter) */
app.post("/api/prompts/:id/use", express.json(), async (req, res) => {
  try {
    const { id } = req.params;
    const { sessionCode } = req.body;
    
    console.log(`📝 Using prompt ${id} for session ${sessionCode}`);
    
    const prompt = await db.collection("teacher_prompts").findOne({ _id: id });
    if (!prompt) {
      return res.status(404).json({ error: "Prompt not found" });
    }
    
    // Increment usage counter
    await db.collection("teacher_prompts").updateOne(
      { _id: id },
      { 
        $inc: { usage_count: 1 },
        $set: { last_used: Date.now() }
      }
    );
    
    res.json({
      success: true,
      prompt: prompt,
      message: "Prompt applied successfully"
    });
    
  } catch (err) {
    console.error(`❌ Failed to use prompt ${req.params.id}:`, err);
    res.status(500).json({ error: "Failed to use prompt" });
  }
});

/* Get prompt statistics */
app.get("/api/prompts/stats/overview", async (req, res) => {
  try {
    console.log("📊 Fetching prompt statistics");
    
    const totalPrompts = await db.collection("teacher_prompts").countDocuments();
    const publicPrompts = await db.collection("teacher_prompts").countDocuments({ isPublic: true });
    const privatePrompts = totalPrompts - publicPrompts;
    
    // Most popular prompts
    const popularPrompts = await db.collection("teacher_prompts")
      .find({ isPublic: true })
      .sort({ usage_count: -1, views: -1 })
      .limit(5)
      .toArray();
    
    // Recent prompts
    const recentPrompts = await db.collection("teacher_prompts")
      .find({ isPublic: true })
      .sort({ created_at: -1 })
      .limit(5)
      .toArray();
    
    const allPrompts = await db.collection("teacher_prompts").find({}).toArray();
    const categoryMap = new Map();
    const modeMap = new Map();
    allPrompts.forEach((prompt) => {
      const category = prompt.category || 'Uncategorized';
      const mode = prompt.mode || 'unknown';
      categoryMap.set(category, (categoryMap.get(category) || 0) + 1);
      modeMap.set(mode, (modeMap.get(mode) || 0) + 1);
    });
    const categoryStats = Array.from(categoryMap.entries())
      .map(([key, count]) => ({ _id: key, count }))
      .sort((a, b) => b.count - a.count);
    const modeStats = Array.from(modeMap.entries())
      .map(([key, count]) => ({ _id: key, count }))
      .sort((a, b) => b.count - a.count);
    
    res.json({
      success: true,
      stats: {
        totalPrompts,
        publicPrompts,
        privatePrompts,
        popularPrompts,
        recentPrompts,
        categoryDistribution: categoryStats,
        modeDistribution: modeStats
      }
    });
    
  } catch (err) {
    console.error("❌ Failed to fetch prompt statistics:", err);
    res.status(500).json({ error: "Failed to fetch statistics" });
  }
});

/* Duplicate/clone a prompt */
app.post("/api/prompts/:id/clone", express.json(), async (req, res) => {
  try {
    const { id } = req.params;
    const { authorName = "Anonymous Teacher" } = req.body;
    
    console.log(`📝 Cloning prompt: ${id}`);
    
    const originalPrompt = await db.collection("teacher_prompts").findOne({ _id: id });
    if (!originalPrompt) {
      return res.status(404).json({ error: "Prompt not found" });
    }
    
    const clonedPromptId = uuid();
    const now = Date.now();
    
    const clonedPrompt = {
      ...originalPrompt,
      _id: clonedPromptId,
      title: `${originalPrompt.title} (Copy)`,
      authorName: authorName.trim(),
      created_at: now,
      updated_at: now,
      views: 0,
      last_viewed: null,
      usage_count: 0,
      last_used: null,
      isPublic: false // Clones start as private
    };
    
    await db.collection("teacher_prompts").insertOne(clonedPrompt);
    
    res.json({
      success: true,
      prompt: clonedPrompt,
      message: "Prompt cloned successfully"
    });
    
  } catch (err) {
    console.error(`❌ Failed to clone prompt ${req.params.id}:`, err);
    res.status(500).json({ error: "Failed to clone prompt" });
  }
});

// ... existing code ...

/* Seed default prompts for teachers */
async function seedDefaultPrompts() {
  try {
    console.log('🌱 Checking for default prompts...');
    
    const existingPrompts = await db.collection("teacher_prompts").countDocuments();
    if (existingPrompts > 0) {
      console.log('🌱 Default prompts already exist, skipping seed');
      return;
    }
    
    console.log('🌱 Seeding default teacher prompts...');
    
    const defaultPrompts = [
      {
        _id: uuid(),
        title: "Science Discussion Summary",
        description: "Summarizes science classroom discussions with focus on key concepts, student understanding, and misconceptions",
        content: `Please analyze this classroom discussion transcript and create a comprehensive summary focusing on:

1. **Key Scientific Concepts Discussed**: What main scientific ideas, theories, or principles were covered?

2. **Student Understanding**: What evidence shows students are grasping the concepts? Quote specific student responses.

3. **Misconceptions Identified**: What incorrect ideas or misunderstandings did students express? How were they addressed?

4. **Questions & Inquiry**: What questions did students ask? What sparked their curiosity?

5. **Practical Applications**: Did students connect the science to real-world examples or applications?

6. **Next Steps**: Based on this discussion, what topics might need more explanation or what should be covered next?

Format your response clearly with these sections. Include specific quotes from students to support your analysis.

Transcript: {transcript}`,
        category: "Science",
        mode: "summary",
        tags: ["science", "discussion", "analysis", "misconceptions"],
        isPublic: true,
        authorName: "Smart Classroom Team",
        created_at: Date.now(),
        updated_at: Date.now(),
        views: 0,
        last_viewed: null,
        usage_count: 0,
        last_used: null
      },
      {
        _id: uuid(),
        title: "Mathematics Problem-Solving Analysis",
        description: "Analyzes math discussions focusing on problem-solving strategies, reasoning, and mathematical communication",
        content: `Analyze this mathematics classroom discussion and provide insights on:

1. **Problem-Solving Strategies**: What approaches did students use? Were they effective?

2. **Mathematical Reasoning**: How did students explain their thinking? What reasoning patterns emerged?

3. **Collaboration & Communication**: How well did students explain their ideas to peers? What mathematical vocabulary was used?

4. **Errors & Learning**: What mistakes were made and how were they corrected? What learning opportunities arose from errors?

5. **Conceptual Understanding**: Do students understand the underlying mathematical concepts or just procedures?

6. **Differentiation Needs**: Which students may need additional support or challenge?

Include specific examples from the transcript to illustrate your points.

Transcript: {transcript}`,
        category: "Mathematics",
        mode: "summary",
        tags: ["mathematics", "problem-solving", "reasoning", "communication"],
        isPublic: true,
        authorName: "Smart Classroom Team",
        created_at: Date.now(),
        updated_at: Date.now(),
        views: 0,
        last_viewed: null,
        usage_count: 0,
        last_used: null
      },
      {
        _id: uuid(),
        title: "Literature Discussion Mindmap",
        description: "Creates a mindmap of literature discussions showing themes, character analysis, and literary devices",
        content: `Create a structured mindmap from this literature discussion focusing on:

Main Topic: {topic}

Organize the discussion into these main branches:
- Character Analysis (motivations, development, relationships)
- Themes & Messages (central ideas, author's purpose)
- Literary Devices (symbolism, metaphors, imagery, etc.)
- Plot & Structure (events, conflicts, resolution)
- Student Interpretations (different viewpoints, personal connections)
- Questions & Wonderings (unresolved questions, areas for further discussion)

For each branch, identify 2-4 specific points from the discussion. Include brief quotes or paraphrases from students when relevant.

Create clear, concise nodes that capture the essence of student thinking and literary analysis.

Transcript: {transcript}`,
        category: "Language Arts",
        mode: "mindmap",
        tags: ["literature", "analysis", "themes", "characters"],
        isPublic: true,
        authorName: "Smart Classroom Team",
        created_at: Date.now(),
        updated_at: Date.now(),
        views: 0,
        last_viewed: null,
        usage_count: 0,
        last_used: null
      },
      {
        _id: uuid(),
        title: "Social Studies Debate Assessment",
        description: "Evaluates student participation in social studies debates using specific criteria",
        content: `Evaluate this social studies discussion/debate based on the following criteria. Mark each as completed when there is clear evidence in the transcript:

Students demonstrate understanding of historical context
Students use evidence from primary or secondary sources
Students present multiple perspectives on the issue
Students make connections to current events or modern parallels
Students use appropriate historical vocabulary
Students listen respectfully to opposing viewpoints
Students ask thoughtful follow-up questions
Students support their arguments with specific examples
Students acknowledge counterarguments
Students demonstrate critical thinking about sources and bias

For each completed criteria, provide a specific quote from the transcript that demonstrates the skill.

Focus on identifying clear evidence of these historical thinking skills in student responses.`,
        category: "Social Studies",
        mode: "checkbox",
        tags: ["debate", "historical thinking", "evidence", "perspectives"],
        isPublic: true,
        authorName: "Smart Classroom Team",
        created_at: Date.now(),
        updated_at: Date.now(),
        views: 0,
        last_viewed: null,
        usage_count: 0,
        last_used: null
      },
      {
        _id: uuid(),
        title: "General Discussion Facilitation",
        description: "Analyzes any classroom discussion for participation patterns, engagement, and facilitation opportunities",
        content: `Analyze this classroom discussion for facilitation insights:

**Participation Analysis:**
- Who contributed most/least to the discussion?
- What types of contributions were made (questions, answers, building on ideas, etc.)?
- Were there opportunities for more students to participate?

**Discussion Quality:**
- What evidence shows deep thinking vs. surface-level responses?
- How well did students build on each other's ideas?
- What questions or comments moved the discussion forward?

**Teacher Facilitation:**
- What teacher moves were effective in promoting discussion?
- Where could different questioning or facilitation strategies have been helpful?
- What opportunities for student-led discussion emerged?

**Engagement Indicators:**
- What showed students were actively listening and engaged?
- Were there moments of excitement, confusion, or breakthrough understanding?

**Next Steps:**
- What follow-up questions or activities would extend this discussion?
- Which students might benefit from individual check-ins?

Transcript: {transcript}`,
        category: "General",
        mode: "summary",
        tags: ["facilitation", "participation", "engagement", "discussion"],
        isPublic: true,
        authorName: "Smart Classroom Team",
        created_at: Date.now(),
        updated_at: Date.now(),
        views: 0,
        last_viewed: null,
        usage_count: 0,
        last_used: null
      },
      {
        _id: uuid(),
        title: "Project-Based Learning Assessment",
        description: "Evaluates collaborative project discussions for 21st-century skills and learning outcomes",
        content: `Assess this project-based learning discussion using these criteria. Mark completed when evidence is present:

Students identify and define the problem clearly
Students brainstorm multiple solution approaches
Students assign roles and responsibilities effectively
Students demonstrate research and information literacy skills
Students show creativity and innovation in their ideas
Students communicate ideas clearly to team members
Students listen actively and build on others' contributions
Students show persistence when facing challenges
Students reflect on their learning process
Students make connections to real-world applications
Students demonstrate digital literacy or technology integration
Students show cultural awareness or global perspective
Students exhibit leadership skills
Students practice time management and organization
Students engage in constructive peer feedback

Provide specific quotes that demonstrate each completed criterion.`,
        category: "Assessment",
        mode: "checkbox",
        tags: ["project-based", "collaboration", "21st-century-skills", "assessment"],
        isPublic: true,
        authorName: "Smart Classroom Team",
        created_at: Date.now(),
        updated_at: Date.now(),
        views: 0,
        last_viewed: null,
        usage_count: 0,
        last_used: null
      }
    ];
    
    await db.collection("teacher_prompts").insertMany(defaultPrompts);
    console.log(`🌱 Successfully seeded ${defaultPrompts.length} default prompts`);
    
  } catch (err) {
    console.error('❌ Failed to seed default prompts:', err);
  }
}

// ... existing code ...

// Clean up old session data to prevent contamination
async function cleanupOldSessionData(sessionCode) {
  try {
    console.log(`🧹 Cleaning up old data for session: ${sessionCode}`);
    
    // Get the session document
    const session = await db.collection("sessions").findOne({ code: sessionCode });
    if (!session) {
      console.log(`📋 No session found with code: ${sessionCode}`);
      return;
    }
    
    // Delete old checkbox progress
    const progressResult = await db.collection("checkbox_progress").deleteMany({ session_id: session._id });
    console.log(`🗑️ Deleted ${progressResult.deletedCount} old progress records`);
    
    // Delete old checkbox criteria
    const criteriaResult = await db.collection("checkbox_criteria").deleteMany({ session_id: session._id });
    console.log(`🗑️ Deleted ${criteriaResult.deletedCount} old criteria records`);
    
    // Delete old checkbox session
    const sessionResult = await db.collection("checkbox_sessions").deleteMany({ session_id: session._id });
    console.log(`🗑️ Deleted ${sessionResult.deletedCount} old checkbox session records`);
    
    console.log(`✅ Session ${sessionCode} cleaned up successfully`);
  } catch (err) {
    console.error(`❌ Error cleaning up session ${sessionCode}:`, err);
  }
}
