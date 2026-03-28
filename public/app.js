/* ═══════════════════════════════════════════════════════════════
   XCORD — Frontend App
   ═══════════════════════════════════════════════════════════════ */

// ── State ─────────────────────────────────────────────────────────
let currentUser      = null;
let currentChannel   = null;
let currentChannelPw = null;   // stored channel password for locked channels
let allChannels      = [];
let pollTimer        = null;
let dmPollTimer      = null;
let lastMsgId        = null;
let currentDMTarget  = null;
let lastDMId         = null;
let dmHistory        = [];     // [{username}] recently opened DMs
let editingMsgId     = null;

// ── Session ───────────────────────────────────────────────────────
function saveSession(u) { try { sessionStorage.setItem("xcord_user", JSON.stringify(u)); } catch {} }
function loadSession()  { try { return JSON.parse(sessionStorage.getItem("xcord_user")); } catch { return null; } }
function clearSession() { try { sessionStorage.removeItem("xcord_user"); } catch {} }

// ── API helper ────────────────────────────────────────────────────
async function api(path, opts = {}) {
  try {
    const res = await fetch(path, {
      ...opts,
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    });
    const data = await res.json().catch(() => ({ error: "Bad response" }));
    return { ok: res.ok, status: res.status, data };
  } catch { return { ok: false, status: 0, data: { error: "Network error" } }; }
}

function showErr(id, msg) { const e = document.getElementById(id); if (e) e.textContent = msg; }
function clearErr(id)     { showErr(id, ""); }
function fmt(ts)          { return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
function esc(s)           { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

function setAvatar(el, src, fallback) {
  el.innerHTML = "";
  if (src) {
    const img = document.createElement("img");
    img.src = src; img.alt = fallback;
    img.onerror = () => { el.innerHTML = ""; el.textContent = (fallback||"?")[0].toUpperCase(); };
    el.appendChild(img);
  } else {
    el.textContent = (fallback||"?")[0].toUpperCase();
  }
}

// ── Auth tab ──────────────────────────────────────────────────────
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
  const btn = document.querySelector("#form-login .btn-primary .btn-text");
  btn.textContent = "CONNECTING...";
  const { ok, data } = await api("/api/login", { method: "POST", body: JSON.stringify({ username, password }) });
  btn.textContent = "CONNECT";
  if (!ok) return showErr("login-error", data.error || "Login failed.");
  // Store password for authenticated requests
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
  const btn = document.querySelector("#form-register .btn-primary .btn-text");
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
}

function updateUserCard() {
  if (!currentUser) return;
  const d = currentUser.displayname || currentUser.username;
  document.getElementById("sidebar-display").textContent = d;
  document.getElementById("sidebar-username").textContent = "@" + currentUser.username;
  setAvatar(document.getElementById("sidebar-avatar"), currentUser.avatar, d);
  setAvatar(document.getElementById("input-avatar"), currentUser.avatar, d);
}

function doLogout() {
  clearInterval(pollTimer); clearInterval(dmPollTimer);
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
  if (allChannels.length) selectChannel(allChannels[0]);
}

function renderChannelList() {
  const list = document.getElementById("channel-list");
  list.innerHTML = "";
  allChannels.forEach(ch => {
    const item = document.createElement("div");
    item.className = "channel-item";
    item.dataset.id = ch.id;
    item.innerHTML = `
      <span class="channel-icon">${ch.icon}</span>
      <span class="channel-name-text">${esc(ch.name)}</span>
      ${ch.hasPassword ? '<span class="channel-lock">🔒</span>' : ""}
    `;
    item.onclick = () => selectChannel(ch);
    list.appendChild(item);
  });
}

function selectChannel(ch) {
  // If password-protected and we don't have it stored, prompt
  if (ch.hasPassword && currentChannelPw !== ch.id + ":ok") {
    pendingChannel = ch;
    document.getElementById("chan-pass-input").value = "";
    clearErr("chan-pass-error");
    document.getElementById("channel-pass-modal").classList.remove("hidden");
    return;
  }
  _activateChannel(ch);
}

let pendingChannel = null;
function submitChannelPass() {
  const pw = document.getElementById("chan-pass-input").value;
  if (!pw) return showErr("chan-pass-error", "Enter password.");
  // Store temporarily, will be confirmed on first message fetch
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
  document.getElementById("chat-badge").textContent = ch.mod === currentUser?.username ? "MOD" : "";
  // Show mod button if user is mod
  const modBtn = document.getElementById("btn-mod-panel");
  if (ch.mod === currentUser?.username) { modBtn.classList.remove("hidden"); }
  else { modBtn.classList.add("hidden"); }
  document.getElementById("messages").innerHTML = '<div class="loading-msg">// loading transmissions...</div>';
  clearInterval(pollTimer);
  fetchMessages();
  pollTimer = setInterval(fetchMessages, 5000);
}

// ── Messages ──────────────────────────────────────────────────────
async function fetchMessages() {
  if (!currentChannel) return;
  const params = new URLSearchParams({ username: currentUser.username });
  if (currentChannelPw?.id === currentChannel.id) params.set("channelPassword", currentChannelPw.pw);
  const { ok, data } = await api(`/api/channels/${currentChannel.id}/messages?${params}`);
  if (!ok) {
    if (data.error === "Wrong channel password") { showErr("chan-pass-error", "Wrong password."); }
    return;
  }
  renderMessages(data.messages, "messages");
}

function renderMessages(msgs, containerId) {
  const container = document.getElementById(containerId);
  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;

  if (!msgs || msgs.length === 0) {
    container.innerHTML = '<div class="msg-welcome"><div class="msg-welcome-glyph">⬡</div><div class="msg-welcome-text">Channel initialized. Begin transmission.</div></div>';
    return;
  }
  const topId = msgs[msgs.length - 1]?.id;
  if (topId === (containerId === "messages" ? lastMsgId : lastDMId)) return;
  if (containerId === "messages") lastMsgId = topId; else lastDMId = topId;

  container.innerHTML = "";
  msgs.forEach(msg => container.appendChild(buildMsg(msg, containerId === "messages")));
  if (nearBottom) container.scrollTop = container.scrollHeight;
}

function buildMsg(msg, isChannel) {
  const wrap = document.createElement("div");
  const isMine = msg.username === currentUser?.username || msg.from === currentUser?.username;
  const isMod  = currentChannel?.mod === currentUser?.username;
  const mention = msg.mention;
  const isMyMention = mention && mention.toLowerCase() === (currentUser?.displayname || currentUser?.username)?.toLowerCase();

  wrap.className = "msg" + (isMyMention ? " is-mention" : "");

  const av = document.createElement("div");
  av.className = "msg-avatar";
  const name = msg.displayname || msg.fromDisplay || msg.username || msg.from;
  setAvatar(av, msg.avatar, name);

  const body = document.createElement("div");
  body.className = "msg-body";

  const meta = document.createElement("div");
  meta.className = "msg-meta";

  const author = document.createElement("span");
  author.className = "msg-author";
  author.textContent = name;

  const time = document.createElement("span");
  time.className = "msg-time";
  time.textContent = fmt(msg.ts);

  meta.appendChild(author);
  meta.appendChild(time);
  if (msg.edited) { const ed = document.createElement("span"); ed.className = "msg-edited"; ed.textContent = "(edited)"; meta.appendChild(ed); }

  const content = document.createElement("div");
  content.className = "msg-content";

  // Render mention highlight
  let contentHTML = esc(msg.content);
  if (mention) {
    contentHTML = contentHTML.replace(
      new RegExp(`^(@${esc(mention)})(\\s)`, "i"),
      `<span class="msg-mention">$1</span>$2`
    );
  }
  content.innerHTML = contentHTML;

  body.appendChild(meta);
  body.appendChild(content);

  // Actions (edit/delete for own, delete for mod)
  if (isChannel && (isMine || isMod)) {
    const actions = document.createElement("div");
    actions.className = "msg-actions";
    if (isMine) {
      const editBtn = document.createElement("button");
      editBtn.className = "msg-action-btn";
      editBtn.textContent = "✎ edit";
      editBtn.onclick = (e) => { e.stopPropagation(); openEditMsg(msg.id, msg.content); };
      actions.appendChild(editBtn);
    }
    if (isMine || isMod) {
      const delBtn = document.createElement("button");
      delBtn.className = "msg-action-btn danger";
      delBtn.textContent = "✕ del";
      delBtn.onclick = (e) => { e.stopPropagation(); deleteMsg(msg.id); };
      actions.appendChild(delBtn);
    }
    wrap.appendChild(actions);
  }

  wrap.appendChild(av);
  wrap.appendChild(body);
  return wrap;
}

async function sendMessage() {
  if (!currentUser || !currentChannel) return;
  const input = document.getElementById("msg-input");
  const content = input.value.trim();
  if (!content) return;

  // @private@username intercept → open DM
  const dmMatch = content.match(/^@private@(\S+)\s*(.*)/i);
  if (dmMatch) {
    const target = dmMatch[1];
    const dmContent = dmMatch[2];
    input.value = "";
    await openDMTarget(target);
    if (dmContent) {
      document.getElementById("dm-input").value = dmContent;
      sendDM();
    }
    return;
  }

  input.value = "";
  const body = {
    username: currentUser.username,
    password: currentUser._pw,
    displayname: currentUser.displayname,
    avatar: currentUser.avatar || null,
    content,
  };
  if (currentChannelPw?.id === currentChannel.id) body.channelPassword = currentChannelPw.pw;

  const { ok, data } = await api(`/api/channels/${currentChannel.id}/messages`, { method: "POST", body: JSON.stringify(body) });
  if (ok && data.message) {
    const container = document.getElementById("messages");
    const welcome = container.querySelector(".msg-welcome, .loading-msg");
    if (welcome) welcome.remove();
    container.appendChild(buildMsg(data.message, true));
    container.scrollTop = container.scrollHeight;
    lastMsgId = data.message.id;
  } else if (!ok) {
    showErr("login-error", data.error || "Send failed.");
  }
}

// ── Edit message ──────────────────────────────────────────────────
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
    method: "PATCH",
    body: JSON.stringify({ username: currentUser.username, password: currentUser._pw, content }),
  });
  if (!ok) return showErr("edit-msg-error", data.error || "Failed.");
  closeModal("edit-msg-modal");
  lastMsgId = null; fetchMessages();
}

async function deleteMsg(msgId) {
  if (!confirm("Delete this message?")) return;
  await api(`/api/channels/${currentChannel.id}/messages/${msgId}`, {
    method: "DELETE",
    body: JSON.stringify({ username: currentUser.username, password: currentUser._pw }),
  });
  lastMsgId = null; fetchMessages();
}

// ── Mention suggest ───────────────────────────────────────────────
function handleInputSuggest(val) {
  const suggest = document.getElementById("mention-suggest");
  const atMatch = val.match(/@([^@\s]*)$/);
  if (!atMatch) { suggest.classList.add("hidden"); return; }
  const q = atMatch[1].toLowerCase();
  if (!q) { suggest.classList.add("hidden"); return; }
  // suggest from known channel members (all channels users — approximate from msgs)
  const knownUsers = [...new Set(
    [...document.querySelectorAll(".msg-author")].map(e => e.textContent)
  )].filter(u => u.toLowerCase().includes(q)).slice(0, 5);
  if (!knownUsers.length) { suggest.classList.add("hidden"); return; }
  suggest.innerHTML = "";
  knownUsers.forEach(u => {
    const opt = document.createElement("div");
    opt.className = "mention-opt";
    opt.textContent = "@" + u;
    opt.onclick = () => {
      const input = document.getElementById("msg-input");
      input.value = input.value.replace(/@([^@\s]*)$/, "@" + u + " ");
      suggest.classList.add("hidden");
      input.focus();
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
  currentDMTarget = target.toLowerCase();
  lastDMId = null;

  // Add to DM history list
  if (!dmHistory.includes(currentDMTarget)) {
    dmHistory.push(currentDMTarget);
    renderDMList();
  }
  document.querySelectorAll(".dm-item").forEach(e => e.classList.toggle("active", e.dataset.user === currentDMTarget));

  document.getElementById("dm-panel-title").textContent = `// DM @${currentDMTarget}`;
  document.getElementById("dm-panel").classList.remove("hidden");
  document.getElementById("dm-messages").innerHTML = '<div class="loading-msg">// loading...</div>';

  clearInterval(dmPollTimer);
  await fetchDMs();
  dmPollTimer = setInterval(fetchDMs, 5000);
}

function renderDMList() {
  const list = document.getElementById("dm-list");
  list.innerHTML = "";
  dmHistory.forEach(u => {
    const item = document.createElement("div");
    item.className = "dm-item" + (u === currentDMTarget ? " active" : "");
    item.dataset.user = u;
    item.textContent = "@" + u;
    item.onclick = () => openDMTarget(u);
    list.appendChild(item);
  });
}

function closeDMPanel() {
  clearInterval(dmPollTimer);
  currentDMTarget = null;
  document.getElementById("dm-panel").classList.add("hidden");
  document.querySelectorAll(".dm-item").forEach(e => e.classList.remove("active"));
}

async function fetchDMs() {
  if (!currentDMTarget) return;
  const params = new URLSearchParams({ username: currentUser.username, password: currentUser._pw });
  const { ok, data } = await api(`/api/dm/${currentDMTarget}?${params}`);
  if (!ok) return;
  renderMessages(data.messages, "dm-messages");
}

async function sendDM() {
  if (!currentDMTarget) return;
  const input = document.getElementById("dm-input");
  const content = input.value.trim();
  if (!content) return;
  input.value = "";
  const { ok, data } = await api(`/api/dm/${currentDMTarget}`, {
    method: "POST",
    body: JSON.stringify({
      username: currentUser.username,
      password: currentUser._pw,
      displayname: currentUser.displayname,
      avatar: currentUser.avatar || null,
      content,
    }),
  });
  if (ok && data.message) {
    const container = document.getElementById("dm-messages");
    const welcome = container.querySelector(".loading-msg");
    if (welcome) welcome.remove();
    container.appendChild(buildMsg(data.message, false));
    container.scrollTop = container.scrollHeight;
    lastDMId = data.message.id;
  }
}

// ── Create channel ────────────────────────────────────────────────
function openCreateChannel() {
  document.getElementById("cc-name").value = "";
  document.getElementById("cc-icon").value = "";
  document.getElementById("cc-password").value = "";
  document.getElementById("cc-userpass").value = "";
  clearErr("cc-error");
  document.getElementById("create-channel-modal").classList.remove("hidden");
}

async function createChannel() {
  clearErr("cc-error");
  const name     = document.getElementById("cc-name").value.trim();
  const icon     = document.getElementById("cc-icon").value.trim() || "📡";
  const chanPw   = document.getElementById("cc-password").value;
  const userPass = document.getElementById("cc-userpass").value;
  if (!name) return showErr("cc-error", "Channel name required.");
  if (!userPass) return showErr("cc-error", "Your password is required.");
  const { ok, data } = await api("/api/channels", {
    method: "POST",
    body: JSON.stringify({
      username: currentUser.username, password: userPass,
      name, icon, channelPassword: chanPw || null,
    }),
  });
  if (!ok) return showErr("cc-error", data.error || "Could not create channel.");
  closeModal("create-channel-modal");
  await loadChannels();
  // select the new channel
  const newCh = allChannels.find(c => c.id === data.channel.id);
  if (newCh) selectChannel(newCh);
}

// ── Mod panel ─────────────────────────────────────────────────────
let modChannelFull = null;

async function openModPanel() {
  if (!currentChannel) return;
  clearErr("mod-error");
  document.getElementById("mod-channel-name").textContent = currentChannel.name;
  document.getElementById("mod-userpass").value = "";
  document.getElementById("mod-ban-user").value = "";
  document.getElementById("mod-filter-match").value = "";
  document.getElementById("mod-filter-replace").value = "";

  // Load full settings
  const params = new URLSearchParams({ username: currentUser.username, password: currentUser._pw });
  const { ok, data } = await api(`/api/channels/${currentChannel.id}/settings?${params}`);
  if (ok) {
    modChannelFull = data.channel;
    document.getElementById("mod-chan-pass").value = "";
    document.getElementById("mod-allowlist").value = (data.channel.allowlist || []).join(", ");
    renderModFilters(data.channel.filters || []);
  }
  document.getElementById("mod-panel-modal").classList.remove("hidden");
}

function renderModFilters(filters) {
  const list = document.getElementById("mod-filters-list");
  list.innerHTML = "";
  filters.forEach((f, i) => {
    const item = document.createElement("div");
    item.className = "filter-item";
    item.innerHTML = `<span>"${esc(f.match)}" → "${esc(f.replace)}"</span>`;
    const del = document.createElement("button");
    del.className = "filter-del";
    del.textContent = "✕";
    del.onclick = () => modRemoveFilter(i);
    item.appendChild(del);
    list.appendChild(item);
  });
}

async function modAction(body) {
  clearErr("mod-error");
  const pw = document.getElementById("mod-userpass").value;
  if (!pw) return showErr("mod-error", "Your password is required.");
  const { ok, data } = await api(`/api/channels/${currentChannel.id}/settings`, {
    method: "PATCH",
    body: JSON.stringify({ username: currentUser.username, password: pw, ...body }),
  });
  if (!ok) return showErr("mod-error", data.error || "Action failed.");
  await openModPanel();
}

function modSetPassword()   { modAction({ channelPassword: document.getElementById("mod-chan-pass").value || null }); }
function modClearPassword() { modAction({ channelPassword: null }); }
function modSetAllowlist()  {
  const val = document.getElementById("mod-allowlist").value.trim();
  const list = val ? val.split(",").map(s => s.trim().toLowerCase()).filter(Boolean) : null;
  modAction({ allowlist: list });
}
function modClearAllowlist() { modAction({ allowlist: null }); }
function modAddFilter() {
  const match   = document.getElementById("mod-filter-match").value.trim();
  const replace = document.getElementById("mod-filter-replace").value.trim();
  if (!match) return showErr("mod-error", "Enter a word/phrase to filter.");
  modAction({ addFilter: { match: match.toLowerCase(), replace } });
}
function modRemoveFilter(idx) { modAction({ removeFilter: idx }); }

async function modBanUser() {
  clearErr("mod-error");
  const pw       = document.getElementById("mod-userpass").value;
  const target   = document.getElementById("mod-ban-user").value.trim().toLowerCase();
  const duration = document.getElementById("mod-ban-duration").value;
  if (!pw) return showErr("mod-error", "Your password is required.");
  if (!target) return showErr("mod-error", "Enter a username to ban.");
  const { ok, data } = await api(`/api/channels/${currentChannel.id}/ban`, {
    method: "POST",
    body: JSON.stringify({ username: currentUser.username, password: pw, target, duration }),
  });
  if (!ok) return showErr("mod-error", data.error || "Ban failed.");
  showErr("mod-error", `${target} banned.`);
  document.getElementById("mod-error").style.color = "var(--rgb-green)";
}

async function modUnbanUser() {
  clearErr("mod-error");
  const pw     = document.getElementById("mod-userpass").value;
  const target = document.getElementById("mod-ban-user").value.trim().toLowerCase();
  if (!pw) return showErr("mod-error", "Your password is required.");
  if (!target) return showErr("mod-error", "Enter a username to unban.");
  const { ok, data } = await api(`/api/channels/${currentChannel.id}/ban`, {
    method: "POST",
    body: JSON.stringify({ username: currentUser.username, password: pw, target, unban: true }),
  });
  if (!ok) return showErr("mod-error", data.error || "Unban failed.");
  showErr("mod-error", `${target} unbanned.`);
  document.getElementById("mod-error").style.color = "var(--rgb-green)";
}

async function modDeleteChannel() {
  if (!confirm(`Delete channel "${currentChannel.name}"? This cannot be undone.`)) return;
  const pw = document.getElementById("mod-userpass").value;
  if (!pw) return showErr("mod-error", "Your password is required.");
  const { ok, data } = await api(`/api/channels/${currentChannel.id}`, {
    method: "DELETE",
    body: JSON.stringify({ username: currentUser.username, password: pw }),
  });
  if (!ok) return showErr("mod-error", data.error || "Delete failed.");
  closeModal("mod-panel-modal");
  clearInterval(pollTimer);
  currentChannel = null;
  await loadChannels();
}

// ── Profile ───────────────────────────────────────────────────────
function openProfile() {
  if (!currentUser) return;
  document.getElementById("prof-display").value = currentUser.displayname || "";
  document.getElementById("prof-avatar").value  = currentUser.avatar || "";
  document.getElementById("prof-pass").value    = "";
  clearErr("prof-error");
  const prev = document.getElementById("modal-avatar-preview");
  setAvatar(prev, currentUser.avatar, currentUser.displayname || currentUser.username);
  document.getElementById("profile-modal").classList.remove("hidden");
}

function previewAvatar(url) {
  setAvatar(document.getElementById("modal-avatar-preview"), url, currentUser?.displayname || "?");
}

async function saveProfile() {
  clearErr("prof-error");
  const displayname = document.getElementById("prof-display").value.trim();
  const avatar      = document.getElementById("prof-avatar").value.trim() || null;
  const password    = document.getElementById("prof-pass").value;
  if (!password) return showErr("prof-error", "Password required.");
  const { ok, data } = await api("/api/profile", {
    method: "PATCH",
    body: JSON.stringify({ username: currentUser.username, password, displayname, avatar }),
  });
  if (!ok) return showErr("prof-error", data.error || "Could not save.");
  currentUser = { ...data.user, _pw: password };
  saveSession(currentUser);
  updateUserCard();
  closeModal("profile-modal");
}

// ── Modal helpers ─────────────────────────────────────────────────
function closeModal(id, e) {
  if (e && e.target !== document.getElementById(id)) return;
  document.getElementById(id).classList.add("hidden");
}

// ── Boot ──────────────────────────────────────────────────────────
(function init() {
  const saved = loadSession();
  if (saved) { currentUser = saved; enterApp(); }
})();
