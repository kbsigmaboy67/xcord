/* ═══════════════════════════════════════════════════════════════
   XCORD — Frontend App
   ═══════════════════════════════════════════════════════════════ */

const SUPERADMIN = "kbsigmaboy67";

let currentUser      = null;
let currentChannel   = null;
let currentChannelPw = null;
let allChannels      = [];
let pollTimer        = null;
let dmPollTimer      = null;
let presenceTimer    = null;
let onlineTimer      = null;
let lastMsgId        = null;
let currentDMTarget  = null;
let lastDMId         = null;
let dmHistory        = [];
let editingMsgId     = null;
let pendingChannel   = null;
let attachedImage    = null;
let dmAttachedImage  = null;
let ghostMode        = false;
let anonMode         = false;
let onlinePanelOpen  = true;

// ── Session ───────────────────────────────────────────────────────
function saveSession(u) { try { sessionStorage.setItem("xcord_u", JSON.stringify(u)); } catch {} }
function loadSession()  { try { return JSON.parse(sessionStorage.getItem("xcord_u")); } catch { return null; } }
function clearSession() { try { sessionStorage.removeItem("xcord_u"); } catch {} }

// ── API ───────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  try {
    const res = await fetch(path, { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } });
    const data = await res.json().catch(() => ({ error: "Bad response" }));
    return { ok: res.ok, status: res.status, data };
  } catch { return { ok: false, status: 0, data: { error: "Network error" } }; }
}

function showErr(id, msg, color) { const e = document.getElementById(id); if (!e) return; e.textContent = msg; e.style.color = color || ""; }
function clearErr(id) { showErr(id, ""); }
function fmt(ts) { return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function fmtBytes(b) { if (b < 1024) return b+"B"; if (b < 1048576) return (b/1024).toFixed(1)+"KB"; return (b/1048576).toFixed(1)+"MB"; }

function setAvatar(el, src, fallback) {
  el.innerHTML = "";
  if (src) {
    const img = document.createElement("img");
    img.src = src; img.alt = fallback;
    img.onerror = () => { el.innerHTML = ""; el.textContent = (fallback || "?")[0].toUpperCase(); };
    el.appendChild(img);
  } else { el.textContent = (fallback || "?")[0].toUpperCase(); }
}

function isDev(user) { return user && (user.username === SUPERADMIN || user.dev === true); }

// ── Auth ──────────────────────────────────────────────────────────
function switchTab(tab) {
  document.getElementById("form-login").classList.toggle("hidden", tab !== "login");
  document.getElementById("form-register").classList.toggle("hidden", tab !== "register");
  document.getElementById("tab-login").classList.toggle("active", tab === "login");
  document.getElementById("tab-register").classList.toggle("active", tab === "register");
}

async function doLogin() {
  clearErr("login-error");
  const username = document.getElementById("login-user").value.trim();
  const password = document.getElementById("login-pass").value;
  if (!username || !password) return showErr("login-error", "All fields required.");
  const btn = document.querySelector("#form-login .btn-text");
  btn.textContent = "CONNECTING...";
  const { ok, data } = await api("/api/login", { method: "POST", body: JSON.stringify({ username, password }) });
  btn.textContent = "CONNECT";
  if (!ok) return showErr("login-error", data.error || "Login failed.");
  currentUser = { ...data.user, _pw: password };
  saveSession(currentUser);
  enterApp();
}

async function doRegister() {
  clearErr("reg-error");
  const username    = document.getElementById("reg-user").value.trim();
  const displayname = document.getElementById("reg-display").value.trim();
  const password    = document.getElementById("reg-pass").value;
  if (!username || !displayname || !password) return showErr("reg-error", "All fields required.");
  if (password.length < 6) return showErr("reg-error", "Password must be 6+ characters.");
  const btn = document.querySelector("#form-register .btn-text");
  btn.textContent = "CREATING...";
  const { ok, data } = await api("/api/register", { method: "POST", body: JSON.stringify({ username, displayname, password }) });
  btn.textContent = "CREATE ACCOUNT";
  if (!ok) return showErr("reg-error", data.error || "Registration failed.");
  currentUser = { ...data.user, _pw: password };
  saveSession(currentUser);
  enterApp();
}

async function enterApp() {
  document.getElementById("auth-screen").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  updateUserCard();
  await loadChannels();
  startPresenceHeartbeat();
  startOnlinePolling();
}

function updateUserCard() {
  if (!currentUser) return;
  const d = currentUser.displayname || currentUser.username;
  document.getElementById("sidebar-display").textContent = d;
  document.getElementById("sidebar-username").textContent = "@" + currentUser.username;
  setAvatar(document.getElementById("sidebar-avatar"), currentUser.avatar, d);
  setAvatar(document.getElementById("input-avatar"), currentUser.avatar, d);
  const devBtn = document.getElementById("btn-dev-panel");
  if (isDev(currentUser)) { devBtn.classList.remove("hidden"); devBtn.classList.add("visible"); }
  else devBtn.classList.add("hidden");
}

async function doLogout() {
  clearInterval(pollTimer); clearInterval(dmPollTimer);
  clearInterval(presenceTimer); clearInterval(onlineTimer);
  // clear presence
  await api("/api/presence", { method: "DELETE", body: JSON.stringify({ username: currentUser.username, password: currentUser._pw }) });
  currentUser = null; currentChannel = null; currentDMTarget = null;
  clearSession();
  document.getElementById("app").classList.add("hidden");
  document.getElementById("auth-screen").classList.remove("hidden");
  document.getElementById("login-user").value = "";
  document.getElementById("login-pass").value = "";
  switchTab("login");
}

// ── Channels ──────────────────────────────────────────────────────
async function loadChannels() {
  const { ok, data } = await api("/api/channels");
  if (!ok) return;
  allChannels = data.channels;
  renderChannelList();
  if (allChannels.length && !currentChannel) selectChannel(allChannels[0]);
}

function renderChannelList() {
  const list = document.getElementById("channel-list");
  list.innerHTML = "";
  allChannels.forEach(ch => {
    const item = document.createElement("div");
    item.className = "channel-item" + (currentChannel?.id === ch.id ? " active" : "");
    item.dataset.id = ch.id;
    item.innerHTML = `<span class="channel-icon">${ch.icon}</span><span class="channel-name-text">${esc(ch.name)}</span>${ch.hasPassword && !isDev(currentUser) ? '<span class="channel-lock">🔒</span>' : ""}`;
    item.onclick = () => selectChannel(ch);
    list.appendChild(item);
  });
}

function selectChannel(ch) {
  if (ch.hasPassword && !isDev(currentUser) && currentChannelPw?.id !== ch.id) {
    pendingChannel = ch;
    document.getElementById("chan-pass-input").value = "";
    clearErr("chan-pass-error");
    document.getElementById("channel-pass-modal").classList.remove("hidden");
    return;
  }
  _activateChannel(ch);
}

function submitChannelPass() {
  const pw = document.getElementById("chan-pass-input").value;
  if (!pw) return showErr("chan-pass-error", "Enter password.");
  currentChannelPw = { id: pendingChannel.id, pw };
  closeModal("channel-pass-modal");
  _activateChannel(pendingChannel);
}

function _activateChannel(ch) {
  currentChannel = ch;
  lastMsgId = null;
  document.querySelectorAll(".channel-item").forEach(el => el.classList.toggle("active", el.dataset.id === ch.id));
  document.getElementById("chat-icon").textContent = ch.icon;
  document.getElementById("chat-name").textContent = ch.name;
  const isMod = ch.mod === currentUser?.username || isDev(currentUser);
  document.getElementById("chat-badge").textContent =
    currentUser?.username === SUPERADMIN ? "SUPERADMIN" :
    isDev(currentUser) ? "DEV" :
    ch.mod === currentUser?.username ? "MOD" : "";
  document.getElementById("btn-mod-panel").classList.toggle("hidden", !isMod);
  document.getElementById("btn-export").classList.toggle("hidden", !isMod);

  // Show password check row for password-protected channels (all users)
  const checkRow = document.getElementById("chan-pass-check-row");
  if (ch.hasPassword) {
    checkRow.classList.remove("hidden");
    document.getElementById("chan-pass-check-input").value = "";
    clearErr("chan-pass-check-result");
  } else {
    checkRow.classList.add("hidden");
  }

  document.getElementById("messages").innerHTML = '<div class="loading-msg">// loading transmissions...</div>';
  clearInterval(pollTimer);
  fetchMessages();
  pollTimer = setInterval(fetchMessages, 5000);

  // Update presence channel immediately
  sendPresenceHeartbeat();
  // Refresh online list for new channel
  fetchOnlineUsers();
}

// ── Channel password check ────────────────────────────────────────
async function checkChannelPassword() {
  const input = document.getElementById("chan-pass-check-input");
  const pw = input.value.trim();
  clearErr("chan-pass-check-result");
  if (!pw) return showErr("chan-pass-check-result", "Enter a password to check.");

  // Try fetching messages with that password — if ok, it's correct
  const params = new URLSearchParams({ username: currentUser.username, channelPassword: pw });
  const { ok, status } = await api(`/api/channels/${currentChannel.id}/messages?${params}`);

  if (ok) {
    showErr("chan-pass-check-result", "✓ CORRECT", "var(--rgb-green)");
    // Also update stored password if it wasn't set
    if (currentChannelPw?.id !== currentChannel.id) {
      currentChannelPw = { id: currentChannel.id, pw };
    }
  } else if (status === 403) {
    showErr("chan-pass-check-result", "✗ WRONG", "var(--rgb-pink)");
  } else {
    showErr("chan-pass-check-result", "Error checking.");
  }
}

// ── Presence heartbeat ────────────────────────────────────────────
async function sendPresenceHeartbeat() {
  if (!currentUser) return;
  await api("/api/presence", {
    method: "POST",
    body: JSON.stringify({
      username: currentUser.username,
      password: currentUser._pw,
      channel: currentChannel?.id || null,
      ghost: ghostMode,
      anon: anonMode,
    }),
  });
}

function startPresenceHeartbeat() {
  sendPresenceHeartbeat();
  clearInterval(presenceTimer);
  presenceTimer = setInterval(sendPresenceHeartbeat, 45000); // every 45s
}

// ── Online users ──────────────────────────────────────────────────
function startOnlinePolling() {
  fetchOnlineUsers();
  clearInterval(onlineTimer);
  onlineTimer = setInterval(fetchOnlineUsers, 30000);
}

async function fetchOnlineUsers() {
  const params = new URLSearchParams({ channel: currentChannel?.id || "" });
  const { ok, data } = await api(`/api/presence?${params}`);
  if (!ok) return;
  renderOnlinePanel(data.channel, data.global, data.globalCount);
}

function renderOnlinePanel(channelUsers, globalUsers, globalCount) {
  // Update count badge
  document.getElementById("global-online-count").textContent = globalCount;

  // Update toggle button
  const toggleBtn = document.getElementById("btn-online-toggle");
  if (toggleBtn) toggleBtn.textContent = `👥 ${globalCount}`;

  // Channel list
  renderOnlineList("channel-online-list", channelUsers, false);
  // Global list
  renderOnlineList("global-online-list", globalUsers, true);
}

function renderOnlineList(containerId, users, showChannel) {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (!users || users.length === 0) {
    container.innerHTML = '<div class="loading-msg" style="font-size:.7rem;padding:8px 4px">No one here</div>';
    return;
  }
  container.innerHTML = "";
  users.forEach(u => {
    const item = document.createElement("div");
    item.className = "online-user";

    const av = document.createElement("div");
    av.className = "online-user-avatar";
    setAvatar(av, u.avatar, u.displayname || u.username);

    const info = document.createElement("div");
    info.className = "online-user-info";

    const name = document.createElement("div");
    name.className = "online-user-name";
    name.textContent = u.displayname || u.username;
    if (u.dev && !u.anon) {
      const badge = document.createElement("span");
      badge.className = "badge-dev";
      badge.textContent = "DEV";
      name.appendChild(badge);
    }
    info.appendChild(name);

    if (showChannel && u.channel) {
      const chanName = allChannels.find(c => c.id === u.channel)?.name || u.channel;
      const sub = document.createElement("div");
      sub.className = "online-user-channel";
      sub.textContent = "#" + chanName;
      info.appendChild(sub);
    }

    const dot = document.createElement("div");
    dot.className = "online-dot";

    item.appendChild(av);
    item.appendChild(info);
    item.appendChild(dot);
    container.appendChild(item);
  });
}

// Global online modal
async function openGlobalOnlineModal() {
  document.getElementById("global-online-modal").classList.remove("hidden");
  const params = new URLSearchParams({ channel: "" });
  const { ok, data } = await api(`/api/presence?${params}`);
  if (!ok) return;
  renderOnlineList("global-online-modal-list", data.global, true);
}

function toggleOnlinePanel() {
  const panel = document.getElementById("online-panel");
  onlinePanelOpen = !onlinePanelOpen;
  panel.classList.toggle("collapsed", !onlinePanelOpen);
}

// ── Ghost / Anon toggles (dev only) ──────────────────────────────
function toggleGhost() {
  ghostMode = !ghostMode;
  const btn = document.getElementById("btn-ghost-toggle");
  if (btn) {
    btn.textContent = `👻 GHOST: ${ghostMode ? "ON" : "OFF"}`;
    btn.classList.toggle("btn-ghost-active", ghostMode);
  }
  sendPresenceHeartbeat();
}

function toggleAnon() {
  anonMode = !anonMode;
  const btn = document.getElementById("btn-anon-toggle");
  if (btn) {
    btn.textContent = `🎭 ANON: ${anonMode ? "ON" : "OFF"}`;
    btn.classList.toggle("btn-anon-active", anonMode);
  }
  sendPresenceHeartbeat();
}

// ── Messages ──────────────────────────────────────────────────────
async function fetchMessages() {
  if (!currentChannel) return;
  const params = new URLSearchParams({ username: currentUser.username });
  if (currentChannelPw?.id === currentChannel.id) params.set("channelPassword", currentChannelPw.pw);
  const { ok, data } = await api(`/api/channels/${currentChannel.id}/messages?${params}`);
  if (!ok) return;
  renderMessages(data.messages, "messages", true);
}

function renderMessages(msgs, containerId, isChannel) {
  const container = document.getElementById(containerId);
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 120;
  if (!msgs || msgs.length === 0) {
    container.innerHTML = '<div class="msg-welcome"><div class="msg-welcome-glyph">⬡</div><div class="msg-welcome-text">Channel initialized. Begin transmission.</div></div>';
    return;
  }
  const topId = msgs[msgs.length - 1]?.id;
  if (topId === (isChannel ? lastMsgId : lastDMId)) return;
  if (isChannel) lastMsgId = topId; else lastDMId = topId;
  container.innerHTML = "";
  msgs.forEach(msg => container.appendChild(buildMsg(msg, isChannel)));
  if (atBottom) container.scrollTop = container.scrollHeight;
}

function buildMsg(msg, isChannel) {
  const wrap       = document.createElement("div");
  const isMine     = (msg.username || msg.from) === currentUser?.username;
  const isMod      = currentChannel?.mod === currentUser?.username || isDev(currentUser);
  const name       = msg.displayname || msg.fromDisplay || msg.username || msg.from || "?";
  const isMyMention = msg.mention && msg.mention.toLowerCase() === (currentUser?.displayname || currentUser?.username)?.toLowerCase();
  wrap.className   = "msg" + (isMyMention ? " is-mention" : "");

  const av = document.createElement("div"); av.className = "msg-avatar";
  setAvatar(av, msg.avatar, name);

  const body = document.createElement("div"); body.className = "msg-body";
  const meta = document.createElement("div"); meta.className = "msg-meta";
  const author = document.createElement("span"); author.className = "msg-author"; author.textContent = name;

  if ((msg.username === SUPERADMIN || msg.from === SUPERADMIN) && name !== "Anonymous") {
    const badge = document.createElement("span"); badge.className = "badge-dev"; badge.textContent = "DEV"; author.appendChild(badge);
  }
  const time = document.createElement("span"); time.className = "msg-time"; time.textContent = fmt(msg.ts);
  meta.appendChild(author); meta.appendChild(time);
  if (msg.edited) { const ed = document.createElement("span"); ed.className = "msg-edited"; ed.textContent = "(edited)"; meta.appendChild(ed); }
  body.appendChild(meta);

  if (msg.content) {
    const content = document.createElement("div"); content.className = "msg-content";
    let html = esc(msg.content);
    if (msg.mention) html = html.replace(new RegExp(`^(@${esc(msg.mention)})(\\s)`, "i"), '<span class="msg-mention">$1</span>$2');
    content.innerHTML = html;
    body.appendChild(content);
  }

  if (msg.image) {
    const img = document.createElement("img");
    img.className = "msg-image"; img.src = msg.image; img.alt = "image";
    img.onclick = () => openLightbox(msg.image);
    body.appendChild(img);
  }

  if (isChannel && (isMine || isMod)) {
    const actions = document.createElement("div"); actions.className = "msg-actions";
    if (isMine && msg.content) {
      const editBtn = document.createElement("button"); editBtn.className = "msg-action-btn";
      editBtn.textContent = "✎ edit";
      editBtn.onclick = (e) => { e.stopPropagation(); openEditMsg(msg.id, msg.content); };
      actions.appendChild(editBtn);
    }
    const delBtn = document.createElement("button"); delBtn.className = "msg-action-btn danger";
    delBtn.textContent = "✕ del";
    delBtn.onclick = (e) => { e.stopPropagation(); deleteMsg(msg.id); };
    actions.appendChild(delBtn);
    wrap.appendChild(actions);
  }

  wrap.appendChild(av); wrap.appendChild(body);
  return wrap;
}

// ── Image attach ──────────────────────────────────────────────────
function handleImageAttach(input) {
  const file = input.files[0]; if (!file) return;
  if (file.size > 3 * 1024 * 1024) { alert("Image must be under 3MB"); input.value = ""; return; }
  const reader = new FileReader();
  reader.onload = (e) => {
    attachedImage = e.target.result;
    document.getElementById("img-preview").src = attachedImage;
    document.getElementById("img-preview-row").classList.remove("hidden");
  };
  reader.readAsDataURL(file);
}

function clearImageAttach() {
  attachedImage = null;
  document.getElementById("img-preview").src = "";
  document.getElementById("img-preview-row").classList.add("hidden");
  document.getElementById("img-file-input").value = "";
}

function handleDMImageAttach(input) {
  const file = input.files[0]; if (!file) return;
  if (file.size > 3 * 1024 * 1024) { alert("Image must be under 3MB"); input.value = ""; return; }
  const reader = new FileReader();
  reader.onload = (e) => {
    dmAttachedImage = e.target.result;
    document.getElementById("dm-img-preview").src = dmAttachedImage;
    document.getElementById("dm-img-preview-row").classList.remove("hidden");
  };
  reader.readAsDataURL(file);
}

function clearDMImageAttach() {
  dmAttachedImage = null;
  document.getElementById("dm-img-preview").src = "";
  document.getElementById("dm-img-preview-row").classList.add("hidden");
  document.getElementById("dm-img-file-input").value = "";
}

function openLightbox(src) {
  const lb = document.createElement("div"); lb.className = "lightbox";
  const img = document.createElement("img"); img.src = src;
  lb.appendChild(img); lb.onclick = () => document.body.removeChild(lb);
  document.body.appendChild(lb);
}

// ── Send message ──────────────────────────────────────────────────
async function sendMessage() {
  if (!currentUser || !currentChannel) return;
  const input   = document.getElementById("msg-input");
  const content = input.value.trim();
  if (!content && !attachedImage) return;

  const dmMatch = content.match(/^@private@(\S+)\s*(.*)/i);
  if (dmMatch) {
    const target = dmMatch[1], dmContent = dmMatch[2];
    input.value = "";
    await openDMTarget(target);
    if (dmContent) { document.getElementById("dm-input").value = dmContent; sendDM(); }
    return;
  }

  input.value = "";
  const image = attachedImage;
  clearImageAttach();

  // Use anon display/avatar if anon mode
  const displayname = anonMode ? "Anonymous" : currentUser.displayname;
  const avatar      = anonMode ? null : (currentUser.avatar || null);

  const body = {
    username: currentUser.username, password: currentUser._pw,
    displayname, avatar, content: content || null, image: image || null,
  };
  if (currentChannelPw?.id === currentChannel.id) body.channelPassword = currentChannelPw.pw;

  const { ok, data } = await api(`/api/channels/${currentChannel.id}/messages`, { method: "POST", body: JSON.stringify(body) });
  if (ok && data.message) {
    const container = document.getElementById("messages");
    const welcome = container.querySelector(".msg-welcome, .loading-msg"); if (welcome) welcome.remove();
    container.appendChild(buildMsg(data.message, true));
    container.scrollTop = container.scrollHeight;
    lastMsgId = data.message.id;
  }
}

// ── Edit / Delete ─────────────────────────────────────────────────
function openEditMsg(id, content) {
  editingMsgId = id;
  document.getElementById("edit-msg-content").value = content;
  clearErr("edit-msg-error");
  document.getElementById("edit-msg-modal").classList.remove("hidden");
}

async function submitEditMsg() {
  const content = document.getElementById("edit-msg-content").value.trim();
  if (!content) return showErr("edit-msg-error", "Cannot be empty.");
  const { ok, data } = await api(`/api/channels/${currentChannel.id}/messages/${editingMsgId}`, {
    method: "PATCH", body: JSON.stringify({ username: currentUser.username, password: currentUser._pw, content }),
  });
  if (!ok) return showErr("edit-msg-error", data.error || "Failed.");
  closeModal("edit-msg-modal"); lastMsgId = null; fetchMessages();
}

async function deleteMsg(msgId) {
  if (!confirm("Delete this message?")) return;
  await api(`/api/channels/${currentChannel.id}/messages/${msgId}`, {
    method: "DELETE", body: JSON.stringify({ username: currentUser.username, password: currentUser._pw }),
  });
  lastMsgId = null; fetchMessages();
}

// ── Export ────────────────────────────────────────────────────────
async function exportHistory() {
  if (!currentChannel) return;
  const params = new URLSearchParams({ username: currentUser.username, password: currentUser._pw });
  const { ok, data } = await api(`/api/channels/${currentChannel.id}/export?${params}`);
  if (!ok) return alert("Export failed: " + (data.error || "unknown"));
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url;
  a.download = `xcord-${currentChannel.name}-${new Date().toISOString().slice(0,10)}.json`;
  a.click(); URL.revokeObjectURL(url);
}

// ── Mention suggest ───────────────────────────────────────────────
function handleInputSuggest(val) {
  const suggest = document.getElementById("mention-suggest");
  const atMatch = val.match(/@([^@\s]*)$/);
  if (!atMatch || !atMatch[1]) { suggest.classList.add("hidden"); return; }
  const q = atMatch[1].toLowerCase();
  const known = [...new Set([...document.querySelectorAll(".msg-author")].map(e => e.childNodes[0]?.textContent || e.textContent).filter(u => u.toLowerCase().includes(q)))].slice(0, 5);
  if (!known.length) { suggest.classList.add("hidden"); return; }
  suggest.innerHTML = "";
  known.forEach(u => {
    const opt = document.createElement("div"); opt.className = "mention-opt"; opt.textContent = "@" + u;
    opt.onclick = () => {
      const inp = document.getElementById("msg-input");
      inp.value = inp.value.replace(/@([^@\s]*)$/, "@" + u + " ");
      suggest.classList.add("hidden"); inp.focus();
    };
    suggest.appendChild(opt);
  });
  suggest.classList.remove("hidden");
}

// ── DMs ───────────────────────────────────────────────────────────
function openDM() {
  const val = document.getElementById("dm-target-input").value.trim().replace(/^@/, "");
  if (!val) return;
  openDMTarget(val);
  document.getElementById("dm-target-input").value = "";
}

async function openDMTarget(target) {
  currentDMTarget = target.toLowerCase(); lastDMId = null;
  if (!dmHistory.includes(currentDMTarget)) { dmHistory.push(currentDMTarget); renderDMList(); }
  document.querySelectorAll(".dm-item").forEach(e => e.classList.toggle("active", e.dataset.user === currentDMTarget));
  document.getElementById("dm-panel-title").textContent = `// DM @${currentDMTarget}`;
  document.getElementById("dm-panel").classList.remove("hidden");
  document.getElementById("dm-messages").innerHTML = '<div class="loading-msg">// loading...</div>';
  clearInterval(dmPollTimer);
  await fetchDMs();
  dmPollTimer = setInterval(fetchDMs, 5000);
}

function renderDMList() {
  const list = document.getElementById("dm-list"); list.innerHTML = "";
  dmHistory.forEach(u => {
    const item = document.createElement("div");
    item.className = "dm-item" + (u === currentDMTarget ? " active" : "");
    item.dataset.user = u; item.textContent = "@" + u;
    item.onclick = () => openDMTarget(u);
    list.appendChild(item);
  });
}

function closeDMPanel() {
  clearInterval(dmPollTimer); currentDMTarget = null;
  document.getElementById("dm-panel").classList.add("hidden");
}

async function fetchDMs() {
  if (!currentDMTarget) return;
  const params = new URLSearchParams({ username: currentUser.username, password: currentUser._pw });
  const { ok, data } = await api(`/api/dm/${currentDMTarget}?${params}`);
  if (!ok) return;
  renderMessages(data.messages, "dm-messages", false);
}

async function sendDM() {
  if (!currentDMTarget) return;
  const input = document.getElementById("dm-input");
  const content = input.value.trim();
  const image   = dmAttachedImage;
  if (!content && !image) return;
  input.value = ""; clearDMImageAttach();
  const displayname = anonMode ? "Anonymous" : currentUser.displayname;
  const avatar      = anonMode ? null : (currentUser.avatar || null);
  const { ok, data } = await api(`/api/dm/${currentDMTarget}`, {
    method: "POST",
    body: JSON.stringify({ username: currentUser.username, password: currentUser._pw, displayname, avatar, content: content || null, image: image || null }),
  });
  if (ok && data.message) {
    const container = document.getElementById("dm-messages");
    const welcome = container.querySelector(".loading-msg"); if (welcome) welcome.remove();
    container.appendChild(buildMsg(data.message, false));
    container.scrollTop = container.scrollHeight; lastDMId = data.message.id;
  }
}

// ── Create channel ────────────────────────────────────────────────
function openCreateChannel() {
  ["cc-name","cc-icon","cc-password","cc-userpass"].forEach(id => document.getElementById(id).value = "");
  clearErr("cc-error");
  document.getElementById("create-channel-modal").classList.remove("hidden");
}

async function createChannel() {
  clearErr("cc-error");
  const name     = document.getElementById("cc-name").value.trim();
  const icon     = document.getElementById("cc-icon").value.trim() || "📡";
  const chanPw   = document.getElementById("cc-password").value;
  const userPass = document.getElementById("cc-userpass").value;
  if (!name || !userPass) return showErr("cc-error", "Name and password required.");
  const { ok, data } = await api("/api/channels", { method: "POST", body: JSON.stringify({ username: currentUser.username, password: userPass, name, icon, channelPassword: chanPw || null }) });
  if (!ok) return showErr("cc-error", data.error || "Failed.");
  closeModal("create-channel-modal");
  await loadChannels();
  const newCh = allChannels.find(c => c.id === data.channel.id);
  if (newCh) selectChannel(newCh);
}

// ── Mod panel ─────────────────────────────────────────────────────
async function openModPanel() {
  if (!currentChannel) return;
  clearErr("mod-error");
  document.getElementById("mod-channel-name").textContent = currentChannel.name;
  ["mod-userpass","mod-ban-user","mod-filter-match","mod-filter-replace","mod-chan-pass"].forEach(id => document.getElementById(id).value = "");
  const params = new URLSearchParams({ username: currentUser.username, password: currentUser._pw });
  const { ok, data } = await api(`/api/channels/${currentChannel.id}/settings?${params}`);
  if (ok) {
    document.getElementById("mod-allowlist").value = (data.channel.allowlist || []).join(", ");
    renderModFilters(data.channel.filters || []);
  }
  document.getElementById("mod-panel-modal").classList.remove("hidden");
}

function renderModFilters(filters) {
  const list = document.getElementById("mod-filters-list"); list.innerHTML = "";
  filters.forEach((f, i) => {
    const item = document.createElement("div"); item.className = "filter-item";
    item.innerHTML = `<span>"${esc(f.match)}" → "${esc(f.replace)}"</span>`;
    const del = document.createElement("button"); del.className = "filter-del"; del.textContent = "✕";
    del.onclick = () => modRemoveFilter(i); item.appendChild(del); list.appendChild(item);
  });
}

async function modApiCall(body) {
  clearErr("mod-error");
  const pw = document.getElementById("mod-userpass").value;
  if (!pw) return showErr("mod-error", "Your password is required.");
  const { ok, data } = await api(`/api/channels/${currentChannel.id}/settings`, { method: "PATCH", body: JSON.stringify({ username: currentUser.username, password: pw, ...body }) });
  if (!ok) return showErr("mod-error", data.error || "Failed.");
  await openModPanel();
}

function modSetPassword()    { modApiCall({ channelPassword: document.getElementById("mod-chan-pass").value || null }); }
function modClearPassword()  { modApiCall({ channelPassword: null }); }
function modSetAllowlist()   { const v = document.getElementById("mod-allowlist").value.trim(); modApiCall({ allowlist: v ? v.split(",").map(s => s.trim().toLowerCase()).filter(Boolean) : null }); }
function modClearAllowlist() { modApiCall({ allowlist: null }); }
function modAddFilter()      { const m = document.getElementById("mod-filter-match").value.trim(), r = document.getElementById("mod-filter-replace").value.trim(); if (!m) return showErr("mod-error","Enter a word/phrase."); modApiCall({ addFilter: { match: m.toLowerCase(), replace: r } }); }
function modRemoveFilter(i)  { modApiCall({ removeFilter: i }); }

async function modBanUser() {
  clearErr("mod-error");
  const pw = document.getElementById("mod-userpass").value, target = document.getElementById("mod-ban-user").value.trim().toLowerCase(), duration = document.getElementById("mod-ban-duration").value;
  if (!pw || !target) return showErr("mod-error", "Password and username required.");
  const { ok, data } = await api(`/api/channels/${currentChannel.id}/ban`, { method: "POST", body: JSON.stringify({ username: currentUser.username, password: pw, target, duration }) });
  if (!ok) return showErr("mod-error", data.error || "Failed.");
  showErr("mod-error", `${target} banned.`, "var(--rgb-green)");
}

async function modUnbanUser() {
  clearErr("mod-error");
  const pw = document.getElementById("mod-userpass").value, target = document.getElementById("mod-ban-user").value.trim().toLowerCase();
  if (!pw || !target) return showErr("mod-error", "Password and username required.");
  const { ok, data } = await api(`/api/channels/${currentChannel.id}/ban`, { method: "POST", body: JSON.stringify({ username: currentUser.username, password: pw, target, unban: true }) });
  if (!ok) return showErr("mod-error", data.error || "Failed.");
  showErr("mod-error", `${target} unbanned.`, "var(--rgb-green)");
}

async function modDeleteChannel() {
  if (!confirm(`Delete channel "${currentChannel.name}"? Cannot be undone.`)) return;
  const pw = document.getElementById("mod-userpass").value;
  if (!pw) return showErr("mod-error", "Password required.");
  const { ok, data } = await api(`/api/channels/${currentChannel.id}`, { method: "DELETE", body: JSON.stringify({ username: currentUser.username, password: pw }) });
  if (!ok) return showErr("mod-error", data.error || "Failed.");
  closeModal("mod-panel-modal"); clearInterval(pollTimer); currentChannel = null;
  await loadChannels();
}

// ── Profile ───────────────────────────────────────────────────────
function openProfile() {
  if (!currentUser) return;
  document.getElementById("prof-display").value = currentUser.displayname || "";
  document.getElementById("prof-avatar").value  = currentUser.avatar || "";
  document.getElementById("prof-pass").value    = "";
  clearErr("prof-error");
  setAvatar(document.getElementById("modal-avatar-preview"), currentUser.avatar, currentUser.displayname || currentUser.username);
  document.getElementById("profile-modal").classList.remove("hidden");
}

function previewAvatar(url) { setAvatar(document.getElementById("modal-avatar-preview"), url, currentUser?.displayname || "?"); }

async function saveProfile() {
  clearErr("prof-error");
  const displayname = document.getElementById("prof-display").value.trim();
  const avatar      = document.getElementById("prof-avatar").value.trim() || null;
  const password    = document.getElementById("prof-pass").value;
  if (!password) return showErr("prof-error", "Password required.");
  const { ok, data } = await api("/api/profile", { method: "PATCH", body: JSON.stringify({ username: currentUser.username, password, displayname, avatar }) });
  if (!ok) return showErr("prof-error", data.error || "Failed.");
  currentUser = { ...data.user, _pw: password }; saveSession(currentUser); updateUserCard(); closeModal("profile-modal");
}

// ── File storage ──────────────────────────────────────────────────
async function openFiles() {
  document.getElementById("files-modal").classList.remove("hidden");
  await loadFiles();
}

async function loadFiles() {
  const list = document.getElementById("files-list");
  list.innerHTML = '<div class="loading-msg">// loading files...</div>';
  const params = new URLSearchParams({ username: currentUser.username, password: currentUser._pw });
  const { ok, data } = await api(`/api/files?${params}`);
  if (!ok) { list.innerHTML = '<div class="loading-msg">Could not load files.</div>'; return; }
  if (!data.files.length) { list.innerHTML = '<div class="loading-msg">No files stored yet.</div>'; return; }
  list.innerHTML = "";
  data.files.forEach(f => {
    const item = document.createElement("div"); item.className = "file-item";
    item.innerHTML = `<span class="file-item-name" title="${esc(f.name)}">${esc(f.name)}</span><span class="file-item-size">${fmtBytes(f.size)}</span><div class="file-item-actions"><a class="btn-file-action" href="${f.downloadUrl}" target="_blank" download="${esc(f.name)}">⬇</a><button class="btn-file-action danger" onclick="deleteFile('${esc(f.name)}')">✕</button></div>`;
    list.appendChild(item);
  });
}

async function uploadFile(input) {
  const file = input.files[0]; if (!file) return;
  if (file.size > 5 * 1024 * 1024) { alert("Max 5MB"); input.value = ""; return; }
  const reader = new FileReader();
  reader.onload = async (e) => {
    const base64 = e.target.result.split(",")[1];
    const { ok, data } = await api("/api/files", { method: "POST", body: JSON.stringify({ username: currentUser.username, password: currentUser._pw, filename: file.name, content: base64 }) });
    input.value = "";
    if (!ok) return alert("Upload failed: " + (data.error || "unknown"));
    await loadFiles();
  };
  reader.readAsDataURL(file);
}

async function deleteFile(filename) {
  if (!confirm(`Delete "${filename}"?`)) return;
  const { ok, data } = await api(`/api/files/${encodeURIComponent(filename)}`, { method: "DELETE", body: JSON.stringify({ username: currentUser.username, password: currentUser._pw }) });
  if (!ok) return alert("Delete failed: " + (data.error || "unknown"));
  await loadFiles();
}

// ── Dev panel ─────────────────────────────────────────────────────
function openDevPanel() {
  clearErr("dev-error"); clearErr("dev-status-msg");
  ["dev-target-user","dev-userpass","dev-import-channel"].forEach(id => document.getElementById(id).value = "");
  // Sync ghost/anon button states
  const gb = document.getElementById("btn-ghost-toggle");
  const ab = document.getElementById("btn-anon-toggle");
  if (gb) { gb.textContent = `👻 GHOST: ${ghostMode ? "ON" : "OFF"}`; gb.classList.toggle("btn-ghost-active", ghostMode); }
  if (ab) { ab.textContent = `🎭 ANON: ${anonMode ? "ON" : "OFF"}`; ab.classList.toggle("btn-anon-active", anonMode); }
  document.getElementById("dev-panel-modal").classList.remove("hidden");
}

async function devSetStatus(grant) {
  clearErr("dev-error");
  const target = document.getElementById("dev-target-user").value.trim().toLowerCase();
  const pw     = document.getElementById("dev-userpass").value;
  if (!target || !pw) return showErr("dev-error", "Target and password required.");
  const { ok, data } = await api("/api/dev/set", { method: "POST", body: JSON.stringify({ username: currentUser.username, password: pw, target, grant }) });
  if (!ok) return showErr("dev-error", data.error || "Failed.");
  showErr("dev-error", `${target}: dev ${grant ? "GRANTED" : "REVOKED"}`, "var(--rgb-green)");
}

async function devGrant()  { devSetStatus(true); }
async function devRevoke() { devSetStatus(false); }

async function devCheckStatus() {
  clearErr("dev-status-msg");
  const target = document.getElementById("dev-target-user").value.trim().toLowerCase();
  const pw     = document.getElementById("dev-userpass").value;
  if (!target || !pw) return showErr("dev-status-msg", "Enter target and password.");
  const params = new URLSearchParams({ username: currentUser.username, password: pw });
  const { ok, data } = await api(`/api/dev/status/${target}?${params}`);
  if (!ok) return showErr("dev-status-msg", data.error || "Failed.");
  showErr("dev-status-msg", `${data.username}: dev=${data.dev}`, data.dev ? "var(--rgb-green)" : "var(--text-dim)");
}

async function devImport(input) {
  const file = input.files[0]; if (!file) return;
  const channelId = document.getElementById("dev-import-channel").value.trim();
  const pw        = document.getElementById("dev-userpass").value;
  if (!channelId || !pw) { alert("Enter channel ID and password first."); input.value = ""; return; }
  try {
    const parsed = JSON.parse(await file.text());
    const messages = Array.isArray(parsed) ? parsed : parsed.messages;
    if (!Array.isArray(messages)) throw new Error("bad format");
    const { ok, data } = await api(`/api/channels/${channelId}/import`, { method: "POST", body: JSON.stringify({ username: currentUser.username, password: pw, messages }) });
    input.value = "";
    if (!ok) return showErr("dev-error", data.error || "Import failed.");
    showErr("dev-error", `Imported ${data.imported} messages.`, "var(--rgb-green)");
  } catch { showErr("dev-error", "Invalid JSON file."); input.value = ""; }
}

// ── Modal helper ──────────────────────────────────────────────────
function closeModal(id, e) {
  if (e && e.target !== document.getElementById(id)) return;
  document.getElementById(id).classList.add("hidden");
}

// ── Boot ──────────────────────────────────────────────────────────
(function init() {
  const saved = loadSession();
  if (saved) { currentUser = saved; enterApp(); }
})();
