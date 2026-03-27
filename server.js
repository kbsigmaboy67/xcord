const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

// ── token lives ONLY here, in an env var ──────────────────────────────────────
const GH_TOKEN = process.env.GH_TOKEN;
const OWNER    = "kbsigmaboy67";

// Repo → channel mapping (three Xcord channels)
const CHANNEL_REPOS = {
  "0": `${OWNER}/0`,
  "1": `${OWNER}/1`,
  "2": `${OWNER}/2`,
};

// ── helpers ───────────────────────────────────────────────────────────────────
async function ghFetch(url, opts = {}) {
  const res = await fetch(`https://api.github.com${url}`, {
    ...opts,
    headers: {
      Authorization: `token ${GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; }
  catch { return { ok: res.ok, status: res.status, data: text }; }
}

// Base64 helpers for GitHub file API
const b64enc = (s) => Buffer.from(s, "utf8").toString("base64");
const b64dec = (s) => Buffer.from(s, "base64").toString("utf8");

// ── user store (repo: kbsigmaboy67/0, path: _users/<username>.json) ───────────
const USERS_REPO   = `${OWNER}/0`;
const userPath     = (u) => `_users/${u.toLowerCase()}.json`;

async function getFileInfo(repo, filePath) {
  return ghFetch(`/repos/${repo}/contents/${filePath}`);
}

async function writeFile(repo, filePath, content, sha = null, message = "xcord") {
  const body = {
    message,
    content: b64enc(JSON.stringify(content, null, 2)),
    ...(sha ? { sha } : {}),
  };
  return ghFetch(`/repos/${repo}/contents/${filePath}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

// ── AUTH ROUTES ───────────────────────────────────────────────────────────────

// Register
app.post("/api/register", async (req, res) => {
  const { username, password, displayname } = req.body;
  if (!username || !password || !displayname)
    return res.status(400).json({ error: "Missing fields" });

  const slug = username.toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (!slug) return res.status(400).json({ error: "Invalid username" });

  // Check if user exists
  const existing = await getFileInfo(USERS_REPO, userPath(slug));
  if (existing.ok) return res.status(409).json({ error: "Username taken" });

  // Very simple hash (use bcrypt in production, but no native modules on Render free tier)
  const pwHash = Buffer.from(password + "xcord_salt_" + slug).toString("base64");

  const userRecord = {
    username: slug,
    displayname,
    pwHash,
    avatar: null,
    status: "online",
    createdAt: new Date().toISOString(),
  };

  const write = await writeFile(USERS_REPO, userPath(slug), userRecord, null, `register:${slug}`);
  if (!write.ok) return res.status(500).json({ error: "Could not create user", detail: write.data?.message || write.data });

  const { pwHash: _, ...safe } = userRecord;
  res.json({ user: safe });
});

// Login
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  const slug = (username || "").toLowerCase().replace(/[^a-z0-9_]/g, "");

  const info = await getFileInfo(USERS_REPO, userPath(slug));
  if (!info.ok) return res.status(401).json({ error: "Invalid credentials" });

  let record;
  try { record = JSON.parse(b64dec(info.data.content.replace(/\n/g, ""))); }
  catch { return res.status(500).json({ error: "Corrupted user record" }); }

  const pwHash = Buffer.from(password + "xcord_salt_" + slug).toString("base64");
  if (pwHash !== record.pwHash)
    return res.status(401).json({ error: "Invalid credentials" });

  const { pwHash: _, ...safe } = record;
  res.json({ user: safe });
});

// Update profile (displayname / avatar)
app.patch("/api/profile", async (req, res) => {
  const { username, password, displayname, avatar } = req.body;
  const slug = (username || "").toLowerCase();

  const info = await getFileInfo(USERS_REPO, userPath(slug));
  if (!info.ok) return res.status(404).json({ error: "User not found" });

  let record;
  try { record = JSON.parse(b64dec(info.data.content.replace(/\n/g, ""))); }
  catch { return res.status(500).json({ error: "Corrupted record" }); }

  const pwHash = Buffer.from(password + "xcord_salt_" + slug).toString("base64");
  if (pwHash !== record.pwHash)
    return res.status(401).json({ error: "Wrong password" });

  if (displayname) record.displayname = displayname;
  if (avatar !== undefined) record.avatar = avatar;

  const write = await writeFile(
    USERS_REPO, userPath(slug), record,
    info.data.sha, `profile:${slug}`
  );
  if (!write.ok) return res.status(500).json({ error: "Could not update profile" });

  const { pwHash: _, ...safe } = record;
  res.json({ user: safe });
});

// ── MESSAGE ROUTES ────────────────────────────────────────────────────────────

// Message file path per day
const msgPath = (channelId) => {
  const d = new Date();
  const day = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;
  return `messages/${day}.json`;
};

async function getMessages(repo, filePath) {
  const info = await getFileInfo(repo, filePath);
  if (!info.ok) return { messages: [], sha: null };
  try {
    const msgs = JSON.parse(b64dec(info.data.content.replace(/\n/g, "")));
    return { messages: Array.isArray(msgs) ? msgs : [], sha: info.data.sha };
  } catch { return { messages: [], sha: info.data.sha }; }
}

// GET messages
app.get("/api/channels/:id/messages", async (req, res) => {
  const repo = CHANNEL_REPOS[req.params.id];
  if (!repo) return res.status(404).json({ error: "Channel not found" });

  const fp = msgPath(req.params.id);
  const { messages } = await getMessages(repo, fp);
  // return last 80 messages
  res.json({ messages: messages.slice(-80) });
});

// POST message
app.post("/api/channels/:id/messages", async (req, res) => {
  const repo = CHANNEL_REPOS[req.params.id];
  if (!repo) return res.status(404).json({ error: "Channel not found" });

  const { username, displayname, content, avatar } = req.body;
  if (!username || !content) return res.status(400).json({ error: "Missing fields" });

  const fp = msgPath(req.params.id);
  const { messages, sha } = await getMessages(repo, fp);

  const msg = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
    username,
    displayname: displayname || username,
    avatar: avatar || null,
    content,
    ts: new Date().toISOString(),
  };

  messages.push(msg);
  // keep max 500 messages per file
  const trimmed = messages.slice(-500);

  const write = await writeFile(repo, fp, trimmed, sha, `msg:${username}`);
  if (!write.ok) return res.status(500).json({ error: "Could not send message" });

  res.json({ message: msg });
});

// GET channel list
app.get("/api/channels", (req, res) => {
  res.json({
    channels: [
      { id: "0", name: "general",  icon: "💬" },
      { id: "1", name: "gaming",   icon: "🎮" },
      { id: "2", name: "hacking",  icon: "⚡" },
    ],
  });
});

// ── fallback to index.html ────────────────────────────────────────────────────
app.get("*", (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Xcord server on :${PORT}`));
