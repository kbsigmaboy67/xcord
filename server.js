const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

const GH_TOKEN = process.env.GH_TOKEN;
const OWNER    = "kbsigmaboy67";

const REPO_USERS    = `${OWNER}/0`;
const REPO_CHANNELS = `${OWNER}/1`;

// ── GitHub API helper ─────────────────────────────────────────────
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

const b64enc = (s) => Buffer.from(s, "utf8").toString("base64");
const b64dec = (s) => Buffer.from(s, "base64").toString("utf8");

async function getFile(repo, filePath) {
  const r = await ghFetch(`/repos/${repo}/contents/${filePath}`);
  if (!r.ok) return null;
  try {
    const content = JSON.parse(b64dec(r.data.content.replace(/\n/g, "")));
    return { content, sha: r.data.sha };
  } catch { return null; }
}

async function putFile(repo, filePath, content, sha, message = "xcord") {
  const body = { message, content: b64enc(JSON.stringify(content, null, 2)), ...(sha ? { sha } : {}) };
  return ghFetch(`/repos/${repo}/contents/${filePath}`, { method: "PUT", body: JSON.stringify(body) });
}

// ── User helpers ──────────────────────────────────────────────────
const userPath = (u) => `_users/${u.toLowerCase()}.json`;
const pwHash   = (pass, slug) => Buffer.from(pass + "xcord_salt_" + slug).toString("base64");

async function getUser(username) {
  return getFile(REPO_USERS, userPath(username.toLowerCase()));
}

async function authUser(username, password) {
  const f = await getUser(username);
  if (!f) return null;
  if (f.content.pwHash !== pwHash(password, username.toLowerCase())) return null;
  return f;
}

// ── Channel registry ──────────────────────────────────────────────
const CHANNEL_REGISTRY = "_channels/registry.json";

const DEFAULT_CHANNELS = [
  { id: "default-0", name: "general",  icon: "💬", createdBy: "system", mod: "system", password: null, allowlist: null, filters: [], banned: {} },
  { id: "default-1", name: "gaming",   icon: "🎮", createdBy: "system", mod: "system", password: null, allowlist: null, filters: [], banned: {} },
  { id: "default-2", name: "hacking",  icon: "⚡", createdBy: "system", mod: "system", password: null, allowlist: null, filters: [], banned: {} },
];

async function getRegistry() {
  const f = await getFile(REPO_CHANNELS, CHANNEL_REGISTRY);
  if (!f) return { channels: [...DEFAULT_CHANNELS], sha: null };
  const existing = f.content.channels || [];
  const ids = existing.map(c => c.id);
  const merged = [
    ...DEFAULT_CHANNELS.filter(d => !ids.includes(d.id)),
    ...existing,
  ];
  return { channels: merged, sha: f.sha };
}

async function saveRegistry(channels, sha) {
  return putFile(REPO_CHANNELS, CHANNEL_REGISTRY, { channels }, sha, "registry update");
}

// ── Message helpers ───────────────────────────────────────────────
const todayStr = () => {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;
};
const msgPath = (channelId) => `channels/${channelId}/messages/${todayStr()}.json`;
const dmPath  = (a, b) => { const key = [a,b].sort().join("__"); return `dms/${key}/${todayStr()}.json`; };

async function getMsgs(repo, fp) {
  const f = await getFile(repo, fp);
  if (!f) return { messages: [], sha: null };
  return { messages: Array.isArray(f.content) ? f.content : [], sha: f.sha };
}

function applyFilters(content, filters) {
  let out = content;
  for (const f of (filters || [])) {
    try {
      const re = new RegExp(f.match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      out = out.replace(re, f.replace);
    } catch {}
  }
  return out;
}

function isBanned(channel, username) {
  const ban = channel.banned?.[username];
  if (!ban) return false;
  if (ban.until === "permanent") return true;
  return Date.now() < ban.until;
}

// ══════════════════════════════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════════════════════════════

app.post("/api/register", async (req, res) => {
  const { username, password, displayname } = req.body;
  if (!username || !password || !displayname) return res.status(400).json({ error: "Missing fields" });
  const slug = username.toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (!slug) return res.status(400).json({ error: "Invalid username" });
  const existing = await getUser(slug);
  if (existing) return res.status(409).json({ error: "Username taken" });
  const record = { username: slug, displayname, pwHash: pwHash(password, slug), avatar: null, createdAt: new Date().toISOString() };
  const w = await putFile(REPO_USERS, userPath(slug), record, null, `register:${slug}`);
  if (!w.ok) return res.status(500).json({ error: "Could not create user", detail: w.data?.message });
  const { pwHash: _, ...safe } = record;
  res.json({ user: safe });
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Missing fields" });
  const slug = username.toLowerCase().replace(/[^a-z0-9_]/g, "");
  const f = await authUser(slug, password);
  if (!f) return res.status(401).json({ error: "Invalid credentials" });
  const { pwHash: _, ...safe } = f.content;
  res.json({ user: safe });
});

app.patch("/api/profile", async (req, res) => {
  const { username, password, displayname, avatar } = req.body;
  const slug = username?.toLowerCase();
  const f = await authUser(slug, password);
  if (!f) return res.status(401).json({ error: "Wrong password" });
  const record = f.content;
  if (displayname) record.displayname = displayname;
  if (avatar !== undefined) record.avatar = avatar;
  const w = await putFile(REPO_USERS, userPath(slug), record, f.sha, `profile:${slug}`);
  if (!w.ok) return res.status(500).json({ error: "Could not update profile" });
  const { pwHash: _, ...safe } = record;
  res.json({ user: safe });
});

// ══════════════════════════════════════════════════════════════════
//  CHANNELS
// ══════════════════════════════════════════════════════════════════

app.get("/api/channels", async (req, res) => {
  const { channels } = await getRegistry();
  const safe = channels.map(({ banned, allowlist, password, filters, ...c }) => ({
    ...c, hasPassword: !!password, hasAllowlist: !!allowlist, filterCount: (filters||[]).length,
  }));
  res.json({ channels: safe });
});

app.post("/api/channels", async (req, res) => {
  const { username, password: userPass, name, icon, channelPassword, allowlist } = req.body;
  if (!username || !userPass || !name) return res.status(400).json({ error: "Missing fields" });
  const slug = username.toLowerCase();
  const f = await authUser(slug, userPass);
  if (!f) return res.status(401).json({ error: "Unauthorized" });
  const { channels, sha } = await getRegistry();
  const chanSlug = name.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 32);
  if (channels.find(c => c.name === chanSlug)) return res.status(409).json({ error: "Channel name taken" });
  const newChan = {
    id: `${chanSlug}-${Date.now()}`,
    name: chanSlug, icon: icon || "📡",
    createdBy: slug, mod: slug,
    password: channelPassword || null,
    allowlist: allowlist || null,
    filters: [], banned: {},
    createdAt: new Date().toISOString(),
  };
  channels.push(newChan);
  const w = await saveRegistry(channels, sha);
  if (!w.ok) return res.status(500).json({ error: "Could not create channel" });
  const { banned, password: cp, filters, allowlist: al, ...safeC } = newChan;
  res.json({ channel: { ...safeC, hasPassword: !!cp, hasAllowlist: !!al, filterCount: 0 } });
});

app.delete("/api/channels/:id", async (req, res) => {
  const { username, password: userPass } = req.body;
  const slug = username?.toLowerCase();
  const f = await authUser(slug, userPass);
  if (!f) return res.status(401).json({ error: "Unauthorized" });
  const { channels, sha } = await getRegistry();
  const chan = channels.find(c => c.id === req.params.id);
  if (!chan) return res.status(404).json({ error: "Channel not found" });
  if (chan.mod !== slug) return res.status(403).json({ error: "Not moderator" });
  if (chan.createdBy === "system") return res.status(403).json({ error: "Cannot delete default channels" });
  const w = await saveRegistry(channels.filter(c => c.id !== req.params.id), sha);
  if (!w.ok) return res.status(500).json({ error: "Could not delete channel" });
  res.json({ ok: true });
});

app.patch("/api/channels/:id/settings", async (req, res) => {
  const { username, password: userPass, channelPassword, allowlist, addFilter, removeFilter } = req.body;
  const slug = username?.toLowerCase();
  const f = await authUser(slug, userPass);
  if (!f) return res.status(401).json({ error: "Unauthorized" });
  const { channels, sha } = await getRegistry();
  const chan = channels.find(c => c.id === req.params.id);
  if (!chan) return res.status(404).json({ error: "Not found" });
  if (chan.mod !== slug) return res.status(403).json({ error: "Not moderator" });
  if (channelPassword !== undefined) chan.password = channelPassword || null;
  if (allowlist !== undefined) chan.allowlist = allowlist;
  if (addFilter) chan.filters = [...(chan.filters||[]), addFilter];
  if (removeFilter !== undefined) chan.filters = (chan.filters||[]).filter((_,i) => i !== removeFilter);
  const w = await saveRegistry(channels, sha);
  if (!w.ok) return res.status(500).json({ error: "Could not update settings" });
  res.json({ ok: true });
});

app.post("/api/channels/:id/ban", async (req, res) => {
  const { username, password: userPass, target, duration, unban } = req.body;
  const slug = username?.toLowerCase();
  const f = await authUser(slug, userPass);
  if (!f) return res.status(401).json({ error: "Unauthorized" });
  const { channels, sha } = await getRegistry();
  const chan = channels.find(c => c.id === req.params.id);
  if (!chan) return res.status(404).json({ error: "Not found" });
  if (chan.mod !== slug) return res.status(403).json({ error: "Not moderator" });
  if (unban) { delete chan.banned[target]; }
  else {
    const until = duration === "permanent" ? "permanent" : Date.now() + (Number(duration) * 60 * 1000);
    chan.banned[target.toLowerCase()] = { until, bannedAt: new Date().toISOString() };
  }
  const w = await saveRegistry(channels, sha);
  if (!w.ok) return res.status(500).json({ error: "Could not update ban" });
  res.json({ ok: true });
});

app.get("/api/channels/:id/settings", async (req, res) => {
  const { username, password: userPass } = req.query;
  const slug = username?.toLowerCase();
  const f = await authUser(slug, userPass);
  if (!f) return res.status(401).json({ error: "Unauthorized" });
  const { channels } = await getRegistry();
  const chan = channels.find(c => c.id === req.params.id);
  if (!chan) return res.status(404).json({ error: "Not found" });
  if (chan.mod !== slug) return res.status(403).json({ error: "Not moderator" });
  res.json({ channel: chan });
});

// ══════════════════════════════════════════════════════════════════
//  MESSAGES
// ══════════════════════════════════════════════════════════════════

app.get("/api/channels/:id/messages", async (req, res) => {
  const { username, channelPassword } = req.query;
  const { channels } = await getRegistry();
  const chan = channels.find(c => c.id === req.params.id);
  if (!chan) return res.status(404).json({ error: "Channel not found" });
  if (chan.password && channelPassword !== chan.password) return res.status(403).json({ error: "Wrong channel password" });
  if (chan.allowlist && username && !chan.allowlist.includes(username.toLowerCase()) && chan.mod !== username?.toLowerCase())
    return res.status(403).json({ error: "Not on allowlist" });
  if (username && isBanned(chan, username.toLowerCase())) return res.status(403).json({ error: "You are banned from this channel" });
  const { messages } = await getMsgs(REPO_CHANNELS, msgPath(req.params.id));
  res.json({ messages: messages.slice(-80) });
});

app.post("/api/channels/:id/messages", async (req, res) => {
  const { username, password: userPass, displayname, avatar, content, channelPassword } = req.body;
  if (!username || !content) return res.status(400).json({ error: "Missing fields" });
  const slug = username.toLowerCase();
  const f = await authUser(slug, userPass);
  if (!f) return res.status(401).json({ error: "Unauthorized" });
  const { channels } = await getRegistry();
  const chan = channels.find(c => c.id === req.params.id);
  if (!chan) return res.status(404).json({ error: "Channel not found" });
  if (chan.password && channelPassword !== chan.password) return res.status(403).json({ error: "Wrong channel password" });
  if (chan.allowlist && !chan.allowlist.includes(slug) && chan.mod !== slug) return res.status(403).json({ error: "Not on allowlist" });
  if (isBanned(chan, slug)) return res.status(403).json({ error: "You are banned from this channel" });
  const fp = msgPath(req.params.id);
  const { messages, sha } = await getMsgs(REPO_CHANNELS, fp);
  const mentionMatch = content.match(/^@([^\s@]+)\s/);
  const mention = mentionMatch ? mentionMatch[1] : null;
  const msg = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
    username: slug, displayname: displayname || slug,
    avatar: avatar || null,
    content: applyFilters(content, chan.filters),
    mention, ts: new Date().toISOString(), edited: false,
  };
  messages.push(msg);
  const w = await putFile(REPO_CHANNELS, fp, messages.slice(-500), sha, `msg:${slug}`);
  if (!w.ok) return res.status(500).json({ error: "Could not send message" });
  res.json({ message: msg });
});

app.patch("/api/channels/:id/messages/:msgId", async (req, res) => {
  const { username, password: userPass, content } = req.body;
  const slug = username?.toLowerCase();
  const f = await authUser(slug, userPass);
  if (!f) return res.status(401).json({ error: "Unauthorized" });
  const fp = msgPath(req.params.id);
  const { messages, sha } = await getMsgs(REPO_CHANNELS, fp);
  const idx = messages.findIndex(m => m.id === req.params.msgId);
  if (idx === -1) return res.status(404).json({ error: "Message not found" });
  if (messages[idx].username !== slug) return res.status(403).json({ error: "Not your message" });
  const { channels } = await getRegistry();
  const chan = channels.find(c => c.id === req.params.id);
  messages[idx].content = applyFilters(content, chan?.filters || []);
  messages[idx].edited = true;
  const w = await putFile(REPO_CHANNELS, fp, messages, sha, `edit:${slug}`);
  if (!w.ok) return res.status(500).json({ error: "Could not edit" });
  res.json({ message: messages[idx] });
});

app.delete("/api/channels/:id/messages/:msgId", async (req, res) => {
  const { username, password: userPass } = req.body;
  const slug = username?.toLowerCase();
  const f = await authUser(slug, userPass);
  if (!f) return res.status(401).json({ error: "Unauthorized" });
  const { channels } = await getRegistry();
  const chan = channels.find(c => c.id === req.params.id);
  const fp = msgPath(req.params.id);
  const { messages, sha } = await getMsgs(REPO_CHANNELS, fp);
  const idx = messages.findIndex(m => m.id === req.params.msgId);
  if (idx === -1) return res.status(404).json({ error: "Message not found" });
  if (chan?.mod !== slug && messages[idx].username !== slug) return res.status(403).json({ error: "Cannot delete this message" });
  messages.splice(idx, 1);
  const w = await putFile(REPO_CHANNELS, fp, messages, sha, `del:${slug}`);
  if (!w.ok) return res.status(500).json({ error: "Could not delete" });
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════
//  PRIVATE MESSAGES
// ══════════════════════════════════════════════════════════════════

app.get("/api/dm/:target", async (req, res) => {
  const { username, password: userPass } = req.query;
  const slug = username?.toLowerCase();
  const f = await authUser(slug, userPass);
  if (!f) return res.status(401).json({ error: "Unauthorized" });
  const { messages } = await getMsgs(REPO_CHANNELS, dmPath(slug, req.params.target.toLowerCase()));
  res.json({ messages: messages.slice(-80) });
});

app.post("/api/dm/:target", async (req, res) => {
  const { username, password: userPass, displayname, avatar, content } = req.body;
  const slug = username?.toLowerCase();
  const f = await authUser(slug, userPass);
  if (!f) return res.status(401).json({ error: "Unauthorized" });
  const target = req.params.target.toLowerCase();
  const targetUser = await getUser(target);
  if (!targetUser) return res.status(404).json({ error: "User not found" });
  const fp = dmPath(slug, target);
  const { messages, sha } = await getMsgs(REPO_CHANNELS, fp);
  const msg = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
    from: slug, fromDisplay: displayname || slug,
    avatar: avatar || null, content,
    ts: new Date().toISOString(),
  };
  messages.push(msg);
  const w = await putFile(REPO_CHANNELS, fp, messages.slice(-500), sha, `dm:${slug}->${target}`);
  if (!w.ok) return res.status(500).json({ error: "Could not send DM" });
  res.json({ message: msg });
});

app.get("*", (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Xcord server on :${PORT}`));
