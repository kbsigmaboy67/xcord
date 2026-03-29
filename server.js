const express = require("express");
const cors    = require("cors");
const path    = require("path");

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

const GH_TOKEN = process.env.GH_TOKEN;
const OWNER    = "kbsigmaboy67";

const REPO_USERS    = `${OWNER}/0`;
const REPO_CHANNELS = `${OWNER}/1`;
const REPO_FILES    = `${OWNER}/2`;   // open account file storage

// Hardcoded superadmin — cannot be banned, bypasses all restrictions
const SUPERADMIN = "kbsigmaboy67";

// ── GitHub helpers ────────────────────────────────────────────────
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

async function getFile(repo, fp) {
  const r = await ghFetch(`/repos/${repo}/contents/${fp}`);
  if (!r.ok) return null;
  try { return { content: JSON.parse(b64dec(r.data.content.replace(/\n/g,""))), sha: r.data.sha }; }
  catch { return null; }
}

async function putFile(repo, fp, content, sha, msg = "xcord") {
  return ghFetch(`/repos/${repo}/contents/${fp}`, {
    method: "PUT",
    body: JSON.stringify({ message: msg, content: b64enc(JSON.stringify(content, null, 2)), ...(sha ? { sha } : {}) }),
  });
}

// ── User helpers ──────────────────────────────────────────────────
const userPath = (u) => `_users/${u.toLowerCase()}.json`;
const pwHash   = (p, u) => Buffer.from(p + "xcord_salt_" + u).toString("base64");

async function getUser(u) { return getFile(REPO_USERS, userPath(u)); }

async function authUser(username, password) {
  const f = await getUser(username?.toLowerCase());
  if (!f) return null;
  if (f.content.pwHash !== pwHash(password, username.toLowerCase())) return null;
  return f;
}

function isDev(userRecord) {
  return userRecord?.username === SUPERADMIN || userRecord?.dev === true;
}

// ── Channel registry ──────────────────────────────────────────────
const REGISTRY = "_channels/registry.json";

const DEFAULT_CHANNELS = [
  { id:"default-0", name:"general",  icon:"💬", createdBy:"system", mod:"system", password:null, allowlist:null, filters:[], banned:{} },
  { id:"default-1", name:"gaming",   icon:"🎮", createdBy:"system", mod:"system", password:null, allowlist:null, filters:[], banned:{} },
  { id:"default-2", name:"hacking",  icon:"⚡", createdBy:"system", mod:"system", password:null, allowlist:null, filters:[], banned:{} },
];

async function getRegistry() {
  const f = await getFile(REPO_CHANNELS, REGISTRY);
  if (!f) return { channels: [...DEFAULT_CHANNELS], sha: null };
  const existing = f.content.channels || [];
  const ids = existing.map(c => c.id);
  return { channels: [...DEFAULT_CHANNELS.filter(d => !ids.includes(d.id)), ...existing], sha: f.sha };
}

async function saveRegistry(channels, sha) {
  return putFile(REPO_CHANNELS, REGISTRY, { channels }, sha, "registry");
}

// ── Message helpers ───────────────────────────────────────────────
const today = () => { const d = new Date(); return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`; };
const msgPath = (id) => `channels/${id}/messages/${today()}.json`;
const dmPath  = (a,b) => { const k=[a,b].sort().join("__"); return `dms/${k}/${today()}.json`; };

async function getMsgs(repo, fp) {
  const f = await getFile(repo, fp);
  if (!f) return { messages:[], sha:null };
  return { messages: Array.isArray(f.content) ? f.content : [], sha: f.sha };
}

function applyFilters(content, filters) {
  let out = content;
  for (const f of (filters||[])) {
    try { out = out.replace(new RegExp(f.match.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),"gi"), f.replace); }
    catch {}
  }
  return out;
}

function isBanned(chan, username) {
  if (username === SUPERADMIN) return false; // superadmin cannot be banned
  const ban = chan.banned?.[username];
  if (!ban) return false;
  if (ban.until === "permanent") return true;
  return Date.now() < ban.until;
}

// ══════════════════════════════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════════════════════════════

app.post("/api/register", async (req, res) => {
  const { username, password, displayname } = req.body;
  if (!username || !password || !displayname) return res.status(400).json({ error:"Missing fields" });
  const slug = username.toLowerCase().replace(/[^a-z0-9_]/g,"");
  if (!slug) return res.status(400).json({ error:"Invalid username" });
  if (await getUser(slug)) return res.status(409).json({ error:"Username taken" });
  const record = { username:slug, displayname, pwHash:pwHash(password,slug), avatar:null, dev:false, createdAt:new Date().toISOString() };
  const w = await putFile(REPO_USERS, userPath(slug), record, null, `register:${slug}`);
  if (!w.ok) return res.status(500).json({ error:"Could not create user", detail:w.data?.message });
  const { pwHash:_, ...safe } = record;
  res.json({ user: safe });
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error:"Missing fields" });
  const f = await authUser(username, password);
  if (!f) return res.status(401).json({ error:"Invalid credentials" });
  const { pwHash:_, ...safe } = f.content;
  res.json({ user: safe });
});

app.patch("/api/profile", async (req, res) => {
  const { username, password, displayname, avatar } = req.body;
  const f = await authUser(username, password);
  if (!f) return res.status(401).json({ error:"Wrong password" });
  const record = f.content;
  if (displayname) record.displayname = displayname;
  if (avatar !== undefined) record.avatar = avatar;
  const w = await putFile(REPO_USERS, userPath(username.toLowerCase()), record, f.sha, `profile:${username}`);
  if (!w.ok) return res.status(500).json({ error:"Could not update" });
  const { pwHash:_, ...safe } = record;
  res.json({ user: safe });
});

// ══════════════════════════════════════════════════════════════════
//  DEV CONTROLS
// ══════════════════════════════════════════════════════════════════

// Grant or revoke dev status
app.post("/api/dev/set", async (req, res) => {
  const { username, password, target, grant } = req.body;
  const f = await authUser(username, password);
  if (!f) return res.status(401).json({ error:"Unauthorized" });
  if (!isDev(f.content)) return res.status(403).json({ error:"Dev only" });
  if (target === SUPERADMIN) return res.status(400).json({ error:"Cannot change superadmin status" });
  const tf = await getUser(target.toLowerCase());
  if (!tf) return res.status(404).json({ error:"Target user not found" });
  tf.content.dev = !!grant;
  const w = await putFile(REPO_USERS, userPath(target.toLowerCase()), tf.content, tf.sha, `dev:${grant?"grant":"revoke"}:${target}`);
  if (!w.ok) return res.status(500).json({ error:"Could not update" });
  res.json({ ok:true, target, dev: !!grant });
});

// Get dev status of a user
app.get("/api/dev/status/:target", async (req, res) => {
  const { username, password } = req.query;
  const f = await authUser(username, password);
  if (!f) return res.status(401).json({ error:"Unauthorized" });
  if (!isDev(f.content)) return res.status(403).json({ error:"Dev only" });
  const tf = await getUser(req.params.target.toLowerCase());
  if (!tf) return res.status(404).json({ error:"Not found" });
  res.json({ username: tf.content.username, dev: isDev(tf.content) });
});

// ══════════════════════════════════════════════════════════════════
//  CHANNELS
// ══════════════════════════════════════════════════════════════════

app.get("/api/channels", async (req, res) => {
  const { channels } = await getRegistry();
  const safe = channels.map(({ banned, allowlist, password, filters, ...c }) => ({
    ...c, hasPassword:!!password, hasAllowlist:!!allowlist, filterCount:(filters||[]).length,
  }));
  res.json({ channels: safe });
});

app.post("/api/channels", async (req, res) => {
  const { username, password:userPass, name, icon, channelPassword, allowlist } = req.body;
  if (!username || !userPass || !name) return res.status(400).json({ error:"Missing fields" });
  const f = await authUser(username, userPass);
  if (!f) return res.status(401).json({ error:"Unauthorized" });
  const { channels, sha } = await getRegistry();
  const chanSlug = name.toLowerCase().replace(/[^a-z0-9_-]/g,"-").slice(0,32);
  if (channels.find(c => c.name === chanSlug)) return res.status(409).json({ error:"Channel name taken" });
  const newChan = {
    id:`${chanSlug}-${Date.now()}`, name:chanSlug, icon:icon||"📡",
    createdBy:username.toLowerCase(), mod:username.toLowerCase(),
    password:channelPassword||null, allowlist:allowlist||null,
    filters:[], banned:{}, createdAt:new Date().toISOString(),
  };
  channels.push(newChan);
  const w = await saveRegistry(channels, sha);
  if (!w.ok) return res.status(500).json({ error:"Could not create channel" });
  const { banned, password:cp, filters, allowlist:al, ...safeC } = newChan;
  res.json({ channel:{ ...safeC, hasPassword:!!cp, hasAllowlist:!!al, filterCount:0 } });
});

app.delete("/api/channels/:id", async (req, res) => {
  const { username, password:userPass } = req.body;
  const f = await authUser(username, userPass);
  if (!f) return res.status(401).json({ error:"Unauthorized" });
  const { channels, sha } = await getRegistry();
  const chan = channels.find(c => c.id === req.params.id);
  if (!chan) return res.status(404).json({ error:"Not found" });
  if (chan.createdBy === "system" && !isDev(f.content)) return res.status(403).json({ error:"Cannot delete default channels" });
  if (chan.mod !== username.toLowerCase() && !isDev(f.content)) return res.status(403).json({ error:"Not moderator" });
  const w = await saveRegistry(channels.filter(c => c.id !== req.params.id), sha);
  if (!w.ok) return res.status(500).json({ error:"Could not delete" });
  res.json({ ok:true });
});

app.patch("/api/channels/:id/settings", async (req, res) => {
  const { username, password:userPass, channelPassword, allowlist, addFilter, removeFilter } = req.body;
  const f = await authUser(username, userPass);
  if (!f) return res.status(401).json({ error:"Unauthorized" });
  const { channels, sha } = await getRegistry();
  const chan = channels.find(c => c.id === req.params.id);
  if (!chan) return res.status(404).json({ error:"Not found" });
  if (chan.mod !== username.toLowerCase() && !isDev(f.content)) return res.status(403).json({ error:"Not moderator" });
  if (channelPassword !== undefined) chan.password = channelPassword || null;
  if (allowlist !== undefined) chan.allowlist = allowlist;
  if (addFilter) chan.filters = [...(chan.filters||[]), addFilter];
  if (removeFilter !== undefined) chan.filters = (chan.filters||[]).filter((_,i) => i !== removeFilter);
  const w = await saveRegistry(channels, sha);
  if (!w.ok) return res.status(500).json({ error:"Could not update" });
  res.json({ ok:true });
});

app.post("/api/channels/:id/ban", async (req, res) => {
  const { username, password:userPass, target, duration, unban } = req.body;
  const f = await authUser(username, userPass);
  if (!f) return res.status(401).json({ error:"Unauthorized" });
  const { channels, sha } = await getRegistry();
  const chan = channels.find(c => c.id === req.params.id);
  if (!chan) return res.status(404).json({ error:"Not found" });
  if (chan.mod !== username.toLowerCase() && !isDev(f.content)) return res.status(403).json({ error:"Not moderator" });
  if (target === SUPERADMIN) return res.status(400).json({ error:"Cannot ban superadmin" });
  if (unban) { delete chan.banned[target]; }
  else { chan.banned[target.toLowerCase()] = { until: duration==="permanent" ? "permanent" : Date.now()+(Number(duration)*60000), bannedAt:new Date().toISOString() }; }
  const w = await saveRegistry(channels, sha);
  if (!w.ok) return res.status(500).json({ error:"Could not update" });
  res.json({ ok:true });
});

app.get("/api/channels/:id/settings", async (req, res) => {
  const { username, password:userPass } = req.query;
  const f = await authUser(username, userPass);
  if (!f) return res.status(401).json({ error:"Unauthorized" });
  const { channels } = await getRegistry();
  const chan = channels.find(c => c.id === req.params.id);
  if (!chan) return res.status(404).json({ error:"Not found" });
  if (chan.mod !== username.toLowerCase() && !isDev(f.content)) return res.status(403).json({ error:"Not moderator" });
  res.json({ channel: chan });
});

// Export channel history
app.get("/api/channels/:id/export", async (req, res) => {
  const { username, password:userPass } = req.query;
  const f = await authUser(username, userPass);
  if (!f) return res.status(401).json({ error:"Unauthorized" });
  const { channels } = await getRegistry();
  const chan = channels.find(c => c.id === req.params.id);
  if (!chan) return res.status(404).json({ error:"Not found" });
  // only mod or dev can export
  if (chan.mod !== username.toLowerCase() && !isDev(f.content)) return res.status(403).json({ error:"Not moderator" });
  const { messages } = await getMsgs(REPO_CHANNELS, msgPath(req.params.id));
  res.json({ channel: chan.name, exportedAt: new Date().toISOString(), messages });
});

// Import messages into channel (dev only)
app.post("/api/channels/:id/import", async (req, res) => {
  const { username, password:userPass, messages:importMsgs } = req.body;
  const f = await authUser(username, userPass);
  if (!f) return res.status(401).json({ error:"Unauthorized" });
  if (!isDev(f.content)) return res.status(403).json({ error:"Dev only" });
  const fp = msgPath(req.params.id);
  const { messages, sha } = await getMsgs(REPO_CHANNELS, fp);
  const merged = [...messages, ...importMsgs].slice(-500);
  const w = await putFile(REPO_CHANNELS, fp, merged, sha, `import:${username}`);
  if (!w.ok) return res.status(500).json({ error:"Could not import" });
  res.json({ ok:true, imported: importMsgs.length });
});

// ══════════════════════════════════════════════════════════════════
//  MESSAGES
// ══════════════════════════════════════════════════════════════════

app.get("/api/channels/:id/messages", async (req, res) => {
  const { username, channelPassword } = req.query;
  const { channels } = await getRegistry();
  const chan = channels.find(c => c.id === req.params.id);
  if (!chan) return res.status(404).json({ error:"Channel not found" });
  // Dev/superadmin bypass password + allowlist
  const userFile = username ? await getUser(username.toLowerCase()) : null;
  const devBypass = userFile && isDev(userFile.content);
  if (!devBypass) {
    if (chan.password && channelPassword !== chan.password) return res.status(403).json({ error:"Wrong channel password" });
    if (chan.allowlist && username && !chan.allowlist.includes(username.toLowerCase()) && chan.mod !== username?.toLowerCase())
      return res.status(403).json({ error:"Not on allowlist" });
  }
  if (username && isBanned(chan, username.toLowerCase())) return res.status(403).json({ error:"You are banned from this channel" });
  const { messages } = await getMsgs(REPO_CHANNELS, msgPath(req.params.id));
  res.json({ messages: messages.slice(-80) });
});

app.post("/api/channels/:id/messages", async (req, res) => {
  const { username, password:userPass, displayname, avatar, content, channelPassword, image } = req.body;
  if (!username || (!content && !image)) return res.status(400).json({ error:"Missing fields" });
  const f = await authUser(username, userPass);
  if (!f) return res.status(401).json({ error:"Unauthorized" });
  const devBypass = isDev(f.content);
  const { channels } = await getRegistry();
  const chan = channels.find(c => c.id === req.params.id);
  if (!chan) return res.status(404).json({ error:"Channel not found" });
  if (!devBypass) {
    if (chan.password && channelPassword !== chan.password) return res.status(403).json({ error:"Wrong channel password" });
    if (chan.allowlist && !chan.allowlist.includes(username.toLowerCase()) && chan.mod !== username.toLowerCase())
      return res.status(403).json({ error:"Not on allowlist" });
  }
  if (isBanned(chan, username.toLowerCase())) return res.status(403).json({ error:"You are banned" });
  const fp = msgPath(req.params.id);
  const { messages, sha } = await getMsgs(REPO_CHANNELS, fp);
  const mentionMatch = (content||"").match(/^@([^\s@]+)\s/);
  const msg = {
    id:`${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
    username:username.toLowerCase(), displayname:displayname||username,
    avatar:avatar||null,
    content: content ? applyFilters(content, chan.filters) : null,
    image: image || null,   // base64 data URL
    mention: mentionMatch ? mentionMatch[1] : null,
    ts:new Date().toISOString(), edited:false,
  };
  messages.push(msg);
  const w = await putFile(REPO_CHANNELS, fp, messages.slice(-500), sha, `msg:${username}`);
  if (!w.ok) return res.status(500).json({ error:"Could not send" });
  res.json({ message:msg });
});

app.patch("/api/channels/:id/messages/:msgId", async (req, res) => {
  const { username, password:userPass, content } = req.body;
  const f = await authUser(username, userPass);
  if (!f) return res.status(401).json({ error:"Unauthorized" });
  const fp = msgPath(req.params.id);
  const { messages, sha } = await getMsgs(REPO_CHANNELS, fp);
  const idx = messages.findIndex(m => m.id === req.params.msgId);
  if (idx === -1) return res.status(404).json({ error:"Not found" });
  if (messages[idx].username !== username.toLowerCase() && !isDev(f.content)) return res.status(403).json({ error:"Not your message" });
  const { channels } = await getRegistry();
  const chan = channels.find(c => c.id === req.params.id);
  messages[idx].content = applyFilters(content, chan?.filters||[]);
  messages[idx].edited  = true;
  const w = await putFile(REPO_CHANNELS, fp, messages, sha, `edit:${username}`);
  if (!w.ok) return res.status(500).json({ error:"Could not edit" });
  res.json({ message:messages[idx] });
});

app.delete("/api/channels/:id/messages/:msgId", async (req, res) => {
  const { username, password:userPass } = req.body;
  const f = await authUser(username, userPass);
  if (!f) return res.status(401).json({ error:"Unauthorized" });
  const { channels } = await getRegistry();
  const chan = channels.find(c => c.id === req.params.id);
  const fp = msgPath(req.params.id);
  const { messages, sha } = await getMsgs(REPO_CHANNELS, fp);
  const idx = messages.findIndex(m => m.id === req.params.msgId);
  if (idx === -1) return res.status(404).json({ error:"Not found" });
  const isMod = chan?.mod === username.toLowerCase();
  const isAuthor = messages[idx].username === username.toLowerCase();
  if (!isMod && !isAuthor && !isDev(f.content)) return res.status(403).json({ error:"Cannot delete" });
  messages.splice(idx, 1);
  const w = await putFile(REPO_CHANNELS, fp, messages, sha, `del:${username}`);
  if (!w.ok) return res.status(500).json({ error:"Could not delete" });
  res.json({ ok:true });
});

// ══════════════════════════════════════════════════════════════════
//  DIRECT MESSAGES
// ══════════════════════════════════════════════════════════════════

app.get("/api/dm/:target", async (req, res) => {
  const { username, password:userPass } = req.query;
  const f = await authUser(username, userPass);
  if (!f) return res.status(401).json({ error:"Unauthorized" });
  const { messages } = await getMsgs(REPO_CHANNELS, dmPath(username.toLowerCase(), req.params.target.toLowerCase()));
  res.json({ messages: messages.slice(-80) });
});

app.post("/api/dm/:target", async (req, res) => {
  const { username, password:userPass, displayname, avatar, content, image } = req.body;
  const f = await authUser(username, userPass);
  if (!f) return res.status(401).json({ error:"Unauthorized" });
  const target = req.params.target.toLowerCase();
  if (!await getUser(target)) return res.status(404).json({ error:"User not found" });
  const fp = dmPath(username.toLowerCase(), target);
  const { messages, sha } = await getMsgs(REPO_CHANNELS, fp);
  const msg = {
    id:`${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
    from:username.toLowerCase(), fromDisplay:displayname||username,
    avatar:avatar||null, content:content||null, image:image||null,
    ts:new Date().toISOString(),
  };
  messages.push(msg);
  const w = await putFile(REPO_CHANNELS, fp, messages.slice(-500), sha, `dm:${username}->${target}`);
  if (!w.ok) return res.status(500).json({ error:"Could not send" });
  res.json({ message:msg });
});

// ══════════════════════════════════════════════════════════════════
//  FILE STORAGE (repo 2) — open per-account storage
// ══════════════════════════════════════════════════════════════════

// List user's stored files
app.get("/api/files", async (req, res) => {
  const { username, password:userPass } = req.query;
  const f = await authUser(username, userPass);
  if (!f) return res.status(401).json({ error:"Unauthorized" });
  const slug = username.toLowerCase();
  const r = await ghFetch(`/repos/${REPO_FILES}/contents/files/${slug}`);
  if (!r.ok) return res.json({ files:[] });
  const files = (Array.isArray(r.data) ? r.data : []).map(item => ({
    name: item.name, path: item.path, size: item.size, sha: item.sha,
    downloadUrl: item.download_url,
  }));
  res.json({ files });
});

// Upload / save a file (stores base64 content)
app.post("/api/files", async (req, res) => {
  const { username, password:userPass, filename, content:fileContent } = req.body;
  if (!filename || !fileContent) return res.status(400).json({ error:"Missing filename or content" });
  const f = await authUser(username, userPass);
  if (!f) return res.status(401).json({ error:"Unauthorized" });
  const slug = username.toLowerCase();
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g,"_").slice(0,100);
  const fp = `files/${slug}/${safeName}`;
  // Check for existing sha
  const existing = await ghFetch(`/repos/${REPO_FILES}/contents/${fp}`);
  const sha = existing.ok ? existing.data.sha : null;
  // fileContent should already be base64
  const body = { message:`upload:${slug}/${safeName}`, content: fileContent.replace(/^data:[^;]+;base64,/,""), ...(sha ? { sha } : {}) };
  const w = await ghFetch(`/repos/${REPO_FILES}/contents/${fp}`, { method:"PUT", body:JSON.stringify(body) });
  if (!w.ok) return res.status(500).json({ error:"Could not upload file", detail:w.data?.message });
  res.json({ ok:true, path:fp, name:safeName });
});

// Delete a stored file
app.delete("/api/files/:filename", async (req, res) => {
  const { username, password:userPass } = req.body;
  const f = await authUser(username, userPass);
  if (!f) return res.status(401).json({ error:"Unauthorized" });
  const slug = username.toLowerCase();
  const fp = `files/${slug}/${req.params.filename}`;
  const existing = await ghFetch(`/repos/${REPO_FILES}/contents/${fp}`);
  if (!existing.ok) return res.status(404).json({ error:"File not found" });
  const w = await ghFetch(`/repos/${REPO_FILES}/contents/${fp}`, {
    method:"DELETE",
    body:JSON.stringify({ message:`delete:${slug}/${req.params.filename}`, sha:existing.data.sha }),
  });
  if (!w.ok) return res.status(500).json({ error:"Could not delete" });
  res.json({ ok:true });
});

app.get("*", (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Xcord on :${PORT}`));
