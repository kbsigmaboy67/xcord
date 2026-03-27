/* ═══════════════════════════════════════════════════════════════
   XCORD — Frontend App
   All API calls go to /api/* on the same origin (the backend proxy).
   The GitHub token never touches this file.
   ═══════════════════════════════════════════════════════════════ */

const API = ""; // same origin — no hardcoded URLs needed

// ── State ─────────────────────────────────────────────────────────
let currentUser    = null;
let currentChannel = null;
let channels       = [];
let pollTimer      = null;
let lastMsgId      = null;

// ── Session persistence ───────────────────────────────────────────
function saveSession(user) {
  try { sessionStorage.setItem("xcord_user", JSON.stringify(user)); } catch {}
}
function loadSession() {
  try { return JSON.parse(sessionStorage.getItem("xcord_user")); } catch { return null; }
}
function clearSession() {
  try { sessionStorage.removeItem("xcord_user"); } catch {}
}

// ── Helpers ──────────────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  try {
    const res = await fetch(API + path, {
      ...opts,
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    });
    const data = await res.json();
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: "Network error" } };
  }
}

function showError(id, msg) {
  const el = document.getElementById(id);
  if (el) { el.textContent = msg; }
}
function clearError(id) { showError(id, ""); }

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function avatarEl(src, fallback) {
  if (src) {
    const img = document.createElement("img");
    img.src = src;
    img.alt = fallback;
    img.onerror = () => { img.replaceWith(document.createTextNode(fallback.charAt(0).toUpperCase())); };
    return img;
  }
  return document.createTextNode((fallback || "?").charAt(0).toUpperCase());
}

function setAvatarEl(containerEl, src, fallback) {
  containerEl.innerHTML = "";
  containerEl.appendChild(avatarEl(src, fallback));
}

// ── Auth tab switching ────────────────────────────────────────────
function switchTab(tab) {
  document.getElementById("form-login").classList.toggle("hidden", tab !== "login");
  document.getElementById("form-register").classList.toggle("hidden", tab !== "register");
  document.getElementById("tab-login").classList.toggle("active", tab === "login");
  document.getElementById("tab-register").classList.toggle("active", tab === "register");
  clearError("login-error");
  clearError("reg-error");
}

// ── Login ─────────────────────────────────────────────────────────
async function doLogin() {
  clearError("login-error");
  const username = document.getElementById("login-user").value.trim();
  const password = document.getElementById("login-pass").value;

  if (!username || !password) return showError("login-error", "All fields required.");

  const btn = document.querySelector("#form-login .btn-primary");
  btn.querySelector(".btn-text").textContent = "CONNECTING...";
  btn.disabled = true;

  const { ok, data } = await apiFetch("/api/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });

  btn.querySelector(".btn-text").textContent = "CONNECT";
  btn.disabled = false;

  if (!ok) return showError("login-error", data.error || "Login failed.");

  currentUser = data.user;
  saveSession(currentUser);
  enterApp();
}

// ── Register ──────────────────────────────────────────────────────
async function doRegister() {
  clearError("reg-error");
  const username    = document.getElementById("reg-user").value.trim();
  const displayname = document.getElementById("reg-display").value.trim();
  const password    = document.getElementById("reg-pass").value;

  if (!username || !displayname || !password)
    return showError("reg-error", "All fields required.");
  if (password.length < 6)
    return showError("reg-error", "Password must be 6+ characters.");

  const btn = document.querySelector("#form-register .btn-primary");
  btn.querySelector(".btn-text").textContent = "CREATING...";
  btn.disabled = true;

  const { ok, data } = await apiFetch("/api/register", {
    method: "POST",
    body: JSON.stringify({ username, displayname, password }),
  });

  btn.querySelector(".btn-text").textContent = "CREATE ACCOUNT";
  btn.disabled = false;

  if (!ok) return showError("reg-error", data.error || "Registration failed.");

  currentUser = data.user;
  saveSession(currentUser);
  enterApp();
}

// ── App entry ─────────────────────────────────────────────────────
async function enterApp() {
  document.getElementById("auth-screen").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");

  updateUserCard();
  await loadChannels();
}

function updateUserCard() {
  if (!currentUser) return;
  const display = currentUser.displayname || currentUser.username;
  document.getElementById("sidebar-display").textContent = display;
  document.getElementById("sidebar-username").textContent = "@" + currentUser.username;

  const avatarEl2 = document.getElementById("sidebar-avatar");
  setAvatarEl(avatarEl2, currentUser.avatar, display);

  const inputAv = document.getElementById("input-avatar");
  setAvatarEl(inputAv, currentUser.avatar, display);
}

// ── Channels ──────────────────────────────────────────────────────
async function loadChannels() {
  const { ok, data } = await apiFetch("/api/channels");
  if (!ok) return;

  channels = data.channels;
  const list = document.getElementById("channel-list");
  list.innerHTML = "";

  channels.forEach((ch) => {
    const item = document.createElement("div");
    item.className = "channel-item";
    item.dataset.id = ch.id;
    item.innerHTML = `<span class="channel-icon">${ch.icon}</span><span>${ch.name}</span>`;
    item.onclick = () => selectChannel(ch);
    list.appendChild(item);
  });

  if (channels.length) selectChannel(channels[0]);
}

function selectChannel(ch) {
  currentChannel = ch;
  lastMsgId = null;

  // Update active state
  document.querySelectorAll(".channel-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.id === String(ch.id));
  });

  // Update header
  document.getElementById("chat-icon").textContent = ch.icon;
  document.getElementById("chat-name").textContent = ch.name;

  // Clear messages
  document.getElementById("messages").innerHTML = `
    <div class="loading-msg">// loading transmissions...</div>`;

  // Stop old poll, start new
  clearInterval(pollTimer);
  fetchMessages();
  pollTimer = setInterval(fetchMessages, 5000);
}

// ── Messages ──────────────────────────────────────────────────────
async function fetchMessages() {
  if (!currentChannel) return;
  const { ok, data } = await apiFetch(`/api/channels/${currentChannel.id}/messages`);
  if (!ok) return;

  renderMessages(data.messages);
}

function renderMessages(msgs) {
  const container = document.getElementById("messages");

  // Check if we're near the bottom before re-rendering
  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;

  if (!msgs || msgs.length === 0) {
    container.innerHTML = `
      <div class="msg-welcome">
        <div class="msg-welcome-glyph">⬡</div>
        <div class="msg-welcome-text">Channel initialized. Begin transmission.</div>
      </div>`;
    return;
  }

  // Only re-render if something changed
  const topId = msgs[msgs.length - 1]?.id;
  if (topId === lastMsgId) return;
  lastMsgId = topId;

  container.innerHTML = "";
  msgs.forEach((msg) => {
    container.appendChild(buildMsgEl(msg));
  });

  if (nearBottom || container.children.length <= msgs.length) {
    container.scrollTop = container.scrollHeight;
  }
}

function buildMsgEl(msg) {
  const wrap = document.createElement("div");
  wrap.className = "msg";

  const av = document.createElement("div");
  av.className = "msg-avatar";
  setAvatarEl(av, msg.avatar, msg.displayname || msg.username);

  const body = document.createElement("div");
  body.className = "msg-body";

  const meta = document.createElement("div");
  meta.className = "msg-meta";
  meta.innerHTML = `
    <span class="msg-author">${esc(msg.displayname || msg.username)}</span>
    <span class="msg-time">${formatTime(msg.ts)}</span>`;

  const content = document.createElement("div");
  content.className = "msg-content";
  content.textContent = msg.content;

  body.appendChild(meta);
  body.appendChild(content);
  wrap.appendChild(av);
  wrap.appendChild(body);
  return wrap;
}

async function sendMessage() {
  if (!currentUser || !currentChannel) return;
  const input = document.getElementById("msg-input");
  const content = input.value.trim();
  if (!content) return;

  input.value = "";

  const { ok, data } = await apiFetch(`/api/channels/${currentChannel.id}/messages`, {
    method: "POST",
    body: JSON.stringify({
      username:    currentUser.username,
      displayname: currentUser.displayname,
      avatar:      currentUser.avatar || null,
      content,
    }),
  });

  if (ok && data.message) {
    // Immediately append
    const container = document.getElementById("messages");
    // Remove welcome msg if present
    const welcome = container.querySelector(".msg-welcome, .loading-msg");
    if (welcome) welcome.remove();

    container.appendChild(buildMsgEl(data.message));
    container.scrollTop = container.scrollHeight;
    lastMsgId = data.message.id;
  }
}

// ── Profile modal ─────────────────────────────────────────────────
function openProfile() {
  if (!currentUser) return;
  document.getElementById("prof-display").value = currentUser.displayname || "";
  document.getElementById("prof-avatar").value  = currentUser.avatar || "";
  document.getElementById("prof-pass").value    = "";
  clearError("prof-error");

  const prev = document.getElementById("modal-avatar-preview");
  setAvatarEl(prev, currentUser.avatar, currentUser.displayname || currentUser.username);

  document.getElementById("profile-modal").classList.remove("hidden");
}

function closeProfile(e) {
  if (!e || e.target === document.getElementById("profile-modal")) {
    document.getElementById("profile-modal").classList.add("hidden");
  }
}

function previewAvatar(url) {
  const prev = document.getElementById("modal-avatar-preview");
  setAvatarEl(prev, url, currentUser?.displayname || "?");
}

async function saveProfile() {
  clearError("prof-error");
  const displayname = document.getElementById("prof-display").value.trim();
  const avatar      = document.getElementById("prof-avatar").value.trim() || null;
  const password    = document.getElementById("prof-pass").value;

  if (!password) return showError("prof-error", "Password required to save.");

  const { ok, data } = await apiFetch("/api/profile", {
    method: "PATCH",
    body: JSON.stringify({
      username: currentUser.username,
      password,
      displayname,
      avatar,
    }),
  });

  if (!ok) return showError("prof-error", data.error || "Could not save.");

  currentUser = data.user;
  saveSession(currentUser);
  updateUserCard();
  closeProfile();
}

// ── Logout ────────────────────────────────────────────────────────
function doLogout() {
  clearInterval(pollTimer);
  currentUser    = null;
  currentChannel = null;
  clearSession();

  document.getElementById("app").classList.add("hidden");
  document.getElementById("auth-screen").classList.remove("hidden");
  document.getElementById("login-user").value = "";
  document.getElementById("login-pass").value = "";
  switchTab("login");
}

// ── XSS helper ────────────────────────────────────────────────────
function esc(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Boot ──────────────────────────────────────────────────────────
(function init() {
  const saved = loadSession();
  if (saved) {
    currentUser = saved;
    enterApp();
  }
})();
