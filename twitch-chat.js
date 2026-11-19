// Twitch chat for Kick pages. Shown inside Kick's chat column (or a pop-out window) by the extension.
//
// Why this exists instead of Twitch's own chat embed: the embed only knows you by your twitch.tv browser session, and there is
// no supported way to hand it the login you already gave this extension. Twitch's chat is also available over a standard chat
// protocol (IRC over a WebSocket) that accepts an authorization token. So this page is a small chat client signed in with that
// same token (needs the optional "chat" permission, Settings > Connections). Without it, the chat is read-only (anonymous).
//
// Safety: every piece of chat text is put in with textContent / createTextNode, never innerHTML, so a message can't inject markup.
// The token is only ever sent to Twitch's chat server as the PASS line, and is never logged or shown.

// ==== chat-pure-start (no DOM, no network in here, so it can be tested)
const IRC_URL = "wss://irc-ws.chat.twitch.tv:443";
const CHAT_SCOPES = ["chat:read", "chat:edit"];
const MAX_MESSAGES = 300;   // oldest are dropped
const MAX_LENGTH = 500;     // Twitch's limit per message
const MIN_SEND_GAP = 1100;  // ms between your own messages (Twitch rate-limits ordinary users)

const unescapeTag = (v) => v.replace(/\\(.)/g, (_, c) => ({ s: " ", ":": ";", r: "\r", n: "\n", "\\": "\\" }[c] ?? c));

// One line of the chat protocol: "@tags :prefix COMMAND params :trailing"
function parseIrc(line) {
  let rest = String(line).replace(/\r?\n$/, "");
  const tags = {};
  if (rest.startsWith("@")) {
    const sp = rest.indexOf(" ");
    for (const part of rest.slice(1, sp).split(";")) {
      const eq = part.indexOf("=");
      tags[eq < 0 ? part : part.slice(0, eq)] = eq < 0 ? "" : unescapeTag(part.slice(eq + 1));
    }
    rest = rest.slice(sp + 1);
  }
  let prefix = "";
  if (rest.startsWith(":")) {
    const sp = rest.indexOf(" ");
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
  }
  let trailing = null;
  const t = rest.indexOf(" :");
  if (t >= 0) { trailing = rest.slice(t + 2); rest = rest.slice(0, t); }
  const [command, ...params] = rest.split(" ").filter((x) => x !== "");
  return { tags, prefix, command, params, trailing };
}
const nickOf = (prefix) => String(prefix || "").split("!")[0];

function parseBadges(tag) {
  return String(tag || "").split(",").filter(Boolean).map((b) => { const [set, version] = b.split("/"); return { set, version }; }).filter((b) => b.set);
}
// "25:0-4,12-16/1902:6-10" -> [{ id, start, end }] in order. (Positions count characters, not UTF-16 units.)
function parseEmotes(tag) {
  const out = [];
  for (const group of String(tag || "").split("/").filter(Boolean)) {
    const [id, ranges] = group.split(":");
    for (const r of String(ranges || "").split(",")) {
      const [a, b] = r.split("-").map(Number);
      if (id && Number.isInteger(a) && Number.isInteger(b)) out.push({ id, start: a, end: b });
    }
  }
  return out.sort((x, y) => x.start - y.start);
}
function messageParts(text, emotes) {
  const cps = Array.from(String(text));
  const parts = [];
  let at = 0;
  for (const e of emotes) {
    if (e.start < at || e.end < e.start || e.end >= cps.length) continue; // overlapping or out of range: skip it
    if (e.start > at) parts.push({ type: "text", text: cps.slice(at, e.start).join("") });
    parts.push({ type: "emote", id: e.id, name: cps.slice(e.start, e.end + 1).join("") });
    at = e.end + 1;
  }
  if (at < cps.length) parts.push({ type: "text", text: cps.slice(at).join("") });
  return parts;
}
// "/me waves" arrives as \x01ACTION waves\x01
function parseAction(text) {
  const m = /^\u0001ACTION ([\s\S]*?)\u0001?$/.exec(String(text));
  return m ? { action: true, text: m[1] } : { action: false, text: String(text) };
}

const emoteUrl = (id) => (/^[A-Za-z0-9_]+$/.test(String(id)) ? `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/1.0` : null);
const safeBadgeUrl = (u) => (typeof u === "string" && u.startsWith("https://static-cdn.jtvnw.net/") ? u : null);

const PALETTE = ["#ff4a4a", "#ff7a00", "#e8b800", "#2ecc71", "#00c8c8", "#4aa8ff", "#b57aff", "#ff6fb5"];
const hashColor = (login) => PALETTE[[...String(login)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % PALETTE.length];
// Twitch name colours can be nearly invisible on a dark background: blend dark ones toward white.
function readableColor(hex, login) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ""));
  if (!m) return hashColor(login);
  let rgb = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lum = (v) => 0.2126 * lin(v[0]) + 0.7152 * lin(v[1]) + 0.0722 * lin(v[2]);
  for (let i = 0; i < 6 && lum(rgb) < 0.25; i++) rgb = rgb.map((c) => Math.round(c + (255 - c) * 0.25));
  return "#" + rgb.map((c) => c.toString(16).padStart(2, "0")).join("");
}

const backoffMs = (attempt) => Math.min(30000, 1000 * 2 ** attempt);
const sanitizeOutgoing = (t) => Array.from(String(t).replace(/[\r\n]+/g, " ").trim()).slice(0, MAX_LENGTH).join("");
const canSendNow = (last, now) => now - last >= MIN_SEND_GAP;
const validChannel = (c) => /^[a-z0-9_]{1,25}$/.test(String(c));
const anonNick = (rand) => `justinfan${10000 + Math.floor(rand * 80000)}`;

const NOTICES = {
  msg_ratelimit: "You're sending messages too quickly.",
  msg_duplicate: "Twitch blocked that message as a duplicate.",
  msg_followersonly: "This chat is followers-only.",
  msg_subsonly: "This chat is subscribers-only.",
  msg_slowmode: "Slow mode is on: wait a bit before your next message.",
  msg_banned: "You're banned from this chat.",
  msg_timedout: "You're timed out in this chat.",
  msg_channel_suspended: "This channel is suspended.",
  msg_requires_verified_phone_number: "This chat requires a verified phone number.",
};
const noticeText = (msgId, text) => NOTICES[msgId] || String(text || "");

// Can we chat as you? Needs your Twitch login, not expired, with the chat permission. Otherwise read-only.
function chatLoginState(u, now) {
  if (!u || !u.token || !u.login) return { mode: "readonly", reason: "no-login" };
  if (!(u.exp > now + 60_000)) return { mode: "readonly", reason: "expired" };
  if (!CHAT_SCOPES.every((s) => u.scopes?.includes(s))) return { mode: "readonly", reason: "no-permission" };
  return { mode: "chat", login: String(u.login).toLowerCase(), token: u.token };
}
const LOGIN_PROMPTS = {
  "no-login": "Read-only. Connect your Twitch account to chat.",
  "expired": "Read-only. Your Twitch login expired: reconnect to chat.",
  "no-permission": "Read-only. Allow Twitch chat permission to chat.",
  "rejected": "Read-only. Twitch rejected the login: allow Twitch chat again.",
};
const loginPrompt = (reason) => LOGIN_PROMPTS[reason] || LOGIN_PROMPTS["no-login"];
// ==== chat-pure-end

// ==== chat-net-start
async function fetchBadges(fetchFn, clientId, token, roomId) {
  const headers = { Authorization: `Bearer ${token}`, "Client-Id": clientId };
  const map = new Map();
  for (const url of ["https://api.twitch.tv/helix/chat/badges/global", `https://api.twitch.tv/helix/chat/badges?broadcaster_id=${encodeURIComponent(roomId)}`]) {
    try { // channel badges come second, so they override the global ones
      const r = await fetchFn(url, { headers });
      if (!r.ok) continue;
      for (const set of (await r.json()).data || []) {
        for (const v of set.versions || []) {
          const u = safeBadgeUrl(v.image_url_1x);
          if (u) map.set(`${set.set_id}/${v.id}`, u);
        }
      }
    } catch (e) { /* badges are optional */ }
  }
  return map;
}

class IrcClient {
  constructor({ channel, creds, onEvent, WS = WebSocket, setT = setTimeout, clearT = clearTimeout, rand = Math.random, now = Date.now }) {
    // Wrapped, not stored bare: browsers refuse setTimeout/clearTimeout/Date.now when called as methods of another object
    // ("Illegal invocation"), which would silently break reconnecting.
    Object.assign(this, { channel, creds, onEvent, WS, rand, now: () => now(), setT: (fn, ms) => setT(fn, ms), clearT: (t) => clearT(t) });
    this.authed = Boolean(creds);
    this.ws = null; this.timer = null; this.attempt = 0; this.closed = false;
    this.joined = false; this.lastSent = 0; this.userstate = {};
  }
  emit(type, data = {}) { this.onEvent(type, data); }
  connect() { this.closed = false; this._open(); }

  _open() {
    this.emit("status", { state: "connecting" });
    const ws = new this.WS(IRC_URL);
    this.ws = ws;
    ws.onopen = () => {
      ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
      if (this.authed) { ws.send(`PASS oauth:${this.creds.token}`); ws.send(`NICK ${this.creds.login}`); }
      else ws.send(`NICK ${anonNick(this.rand())}`); // anonymous, read-only: no password
      ws.send(`JOIN #${this.channel}`);
    };
    ws.onmessage = (ev) => String(ev.data).split("\r\n").filter(Boolean).forEach((l) => this._line(l));
    ws.onerror = () => {}; // a close follows
    ws.onclose = () => {
      if (ws !== this.ws) return; // an old connection we already replaced
      this.ws = null; this.joined = false;
      if (this.closed) return;
      this.emit("status", { state: "reconnecting" });
      this.timer = this.setT(() => this._open(), backoffMs(this.attempt++));
    };
  }

  _line(line) {
    const m = parseIrc(line);
    switch (m.command) {
      case "PING": this.ws && this.ws.send("PONG :tmi.twitch.tv"); break;
      case "001": this.attempt = 0; this.joined = true; this.emit("status", { state: "connected", authed: this.authed }); break;
      case "RECONNECT": this.ws && this.ws.close(); break;
      case "NOTICE":
        if (/^(Login (authentication )?(failed|unsuccessful)|Improperly formatted auth|Invalid NICK)/i.test(m.trailing || "")) {
          this.authed = false; // fall back to anonymous, read-only
          this.emit("authfailed");
          this.ws && this.ws.close();
        } else this.emit("notice", { msgId: m.tags["msg-id"], text: m.trailing });
        break;
      case "PRIVMSG": this.emit("message", { tags: m.tags, login: nickOf(m.prefix), text: m.trailing || "" }); break;
      case "USERNOTICE": this.emit("usernotice", { tags: m.tags, text: m.trailing || "" }); break;
      case "CLEARCHAT": this.emit("clearchat", { user: m.trailing || null, tags: m.tags }); break;
      case "CLEARMSG": this.emit("clearmsg", { id: m.tags["target-msg-id"] }); break;
      case "ROOMSTATE": this.emit("roomstate", { tags: m.tags }); break;
      case "USERSTATE": this.userstate = m.tags; this.emit("userstate", { tags: m.tags }); break;
    }
  }

  // Your own message. Twitch doesn't echo it back, so the caller shows it locally when this says ok.
  send(raw) {
    if (!this.authed) return { ok: false, reason: "readonly" };
    if (!this.ws || this.ws.readyState !== 1 || !this.joined) return { ok: false, reason: "offline" };
    const text = sanitizeOutgoing(raw);
    if (!text) return { ok: false, reason: "empty" };
    let wire = text;
    if (/^\/me\s+/i.test(text)) wire = `\u0001ACTION ${text.replace(/^\/me\s+/i, "")}\u0001`;
    else if (text.startsWith("/")) return { ok: false, reason: "command" };
    const t = this.now();
    if (!canSendNow(this.lastSent, t)) return { ok: false, reason: "slow" };
    this.lastSent = t;
    this.ws.send(`PRIVMSG #${this.channel} :${wire}`);
    return { ok: true, text: wire };
  }

  // Signed in or out while open: reconnect with the new credentials.
  reconfigure(creds) {
    this.creds = creds; this.authed = Boolean(creds);
    this.attempt = 0; this.clearT(this.timer);
    const old = this.ws; this.ws = null; this.joined = false;
    if (old) old.close();
    if (!this.closed) this._open();
  }
  close() { this.closed = true; this.clearT(this.timer); const w = this.ws; this.ws = null; if (w) w.close(); }
}
// ==== chat-net-end

function main() {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const channel = (params.get("channel") || "").toLowerCase();
  const log = $("log"), statusEl = $("status"), input = $("input"), form = $("form"), send = $("send");
  const jump = $("jump"), loginBar = $("login"), loginText = $("loginText"), loginBtn = $("loginBtn");

  const setStatus = (text, warn = false) => { statusEl.textContent = text; statusEl.className = warn ? "status warn" : "status"; };
  document.title = `Twitch chat · ${channel || "?"}`;
  if (params.get("view") === "popup") { $("title").hidden = false; $("title").textContent = `Twitch chat · ${channel}`; }
  if (!validChannel(channel)) {
    setStatus("That isn't a valid Twitch channel name.", true);
    input.disabled = true; send.disabled = true;
    return;
  }

  let client = null, creds = null, token = null, clientId = null, badges = new Map(), roomId = null;
  let badgesFor = null; // the login the current badge list was fetched with
  let rejected = false; // Twitch refused the login: keep saying so (the reconnect that follows must not overwrite the reason)

  const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.addEventListener("scroll", () => { if (atBottom()) jump.hidden = true; });
  jump.addEventListener("click", () => { log.scrollTop = log.scrollHeight; jump.hidden = true; });
  function addRow(node) {
    const stick = atBottom();
    log.appendChild(node);
    while (log.children.length > MAX_MESSAGES) log.children[0].remove();
    if (stick) log.scrollTop = log.scrollHeight; else jump.hidden = false; // reading older messages: don't yank the view
  }
  function notice(text, cls = "") {
    const d = document.createElement("div");
    d.className = `notice ${cls}`.trim();
    d.textContent = text;
    addRow(d);
  }

  function renderMessage({ tags, login, text, mine }) {
    const a = parseAction(text);
    const row = document.createElement("div");
    row.className = "msg" + (a.action ? " act" : "") + (mine ? " mine" : "");
    if (tags.id) row.dataset.id = tags.id;
    row.dataset.login = login;
    for (const b of parseBadges(tags.badges)) {
      const url = badges.get(`${b.set}/${b.version}`);
      if (!url) continue;
      const img = document.createElement("img");
      img.className = "badge"; img.alt = b.set; img.title = b.set; img.src = url;
      row.appendChild(img);
    }
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = tags["display-name"] || login;
    name.style.color = readableColor(tags.color, login);
    row.appendChild(name);
    const sep = document.createElement("span");
    sep.textContent = a.action ? " " : ": ";
    row.appendChild(sep);
    const body = document.createElement("span");
    body.className = "text";
    if (a.action) body.style.color = name.style.color;
    for (const part of messageParts(a.text, parseEmotes(tags.emotes))) {
      const url = part.type === "emote" ? emoteUrl(part.id) : null;
      if (url) {
        const img = document.createElement("img");
        img.className = "emote"; img.alt = part.name; img.title = part.name; img.src = url;
        body.appendChild(img);
      } else {
        body.appendChild(document.createTextNode(part.type === "emote" ? part.name : part.text));
      }
    }
    row.appendChild(body);
    addRow(row);
  }

  // Badge images need a valid login and the channel's id. Either can arrive after the other (e.g. you sign in once the chat is open).
  function loadBadges() {
    if (!roomId || !token || !clientId || badgesFor === token) return;
    badgesFor = token;
    fetchBadges((u, o) => fetch(u, o), clientId, token, roomId).then((m) => { badges = m; });
  }

  const rows = () => Array.from(log.children);
  function onEvent(type, d) {
    if (type === "status") {
      if (rejected) {
        if (d.state === "connected") setStatus("Twitch rejected your login, so this is read-only. Allow Twitch chat again in Settings → Connections.", true);
        return;
      }
      if (d.state === "connecting") setStatus("Connecting to Twitch chat…");
      else if (d.state === "reconnecting") setStatus("Connection lost. Reconnecting…", true);
      else setStatus("");
    } else if (type === "message") renderMessage({ tags: d.tags, login: d.login, text: d.text, mine: false });
    else if (type === "usernotice") {
      if (d.tags["system-msg"]) notice(d.tags["system-msg"], "sys");
      if (d.text) renderMessage({ tags: d.tags, login: d.tags.login || "", text: d.text, mine: false });
    } else if (type === "notice") notice(noticeText(d.msgId, d.text));
    else if (type === "clearmsg") { for (const r of rows()) if (d.id && r.dataset && r.dataset.id === d.id) r.className += " deleted"; }
    else if (type === "clearchat") {
      if (d.user) { for (const r of rows()) if (r.dataset && r.dataset.login === d.user) r.className += " deleted"; notice(`${d.user} was timed out or banned.`); }
      else { for (const r of rows()) r.remove(); notice("Chat was cleared by a moderator."); }
    } else if (type === "roomstate") {
      if (d.tags["room-id"]) { roomId = d.tags["room-id"]; loadBadges(); }
    } else if (type === "authfailed") {
      rejected = true;
      setStatus("Twitch rejected your login. Allow Twitch chat again in Settings → Connections.", true);
      lock("rejected");
    }
  }

  function lock(reason) { // read-only: no typing, show how to enable chat
    input.disabled = true; send.disabled = true; input.placeholder = "Read-only";
    loginBar.hidden = false; loginText.textContent = loginPrompt(reason);
  }
  function applyAuth(u) {
    const st = chatLoginState(u, Date.now());
    const next = st.mode === "chat" ? { login: st.login, token: st.token } : null;
    const changed = Boolean(next) !== Boolean(creds) || (next && creds && (next.login !== creds.login || next.token !== creds.token));
    creds = next;
    if (changed && next) rejected = false; // a fresh login gets a fresh start
    token = u && u.token && u.exp > Date.now() + 60_000 ? u.token : null; // any valid login can fetch badges
    loadBadges();
    if (next) { input.disabled = false; send.disabled = false; input.placeholder = "Send a message"; loginBar.hidden = true; }
    else lock(st.reason);
    if (!client) { client = new IrcClient({ channel, creds, onEvent }); client.connect(); }
    else if (changed) client.reconfigure(creds);
  }

  loginBtn.addEventListener("click", async () => {
    loginBtn.disabled = true;
    try {
      const r = await chrome.runtime.sendMessage({ type: "TWITCH_LOGIN", chat: true });
      if (r && r.error) setStatus(r.error, true);
    } catch (e) {
      setStatus("Couldn't open the Twitch login.", true);
    }
    loginBtn.disabled = false;
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const r = client ? client.send(input.value) : { ok: false, reason: "offline" };
    if (r.ok) {
      renderMessage({ tags: { ...client.userstate, id: "" }, login: creds.login, text: r.text, mine: true });
      input.value = "";
    } else if (r.reason === "slow") notice("You're sending messages too quickly.");
    else if (r.reason === "command") notice("Chat commands aren't supported here. Only /me.");
    else if (r.reason === "offline") notice("Not connected to chat yet.");
  });

  chrome.storage.local.get(["twitchUser", "twitchId"]).then((s) => { clientId = s.twitchId || null; applyAuth(s.twitchUser); });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local") return;
    if (ch.twitchId) { clientId = ch.twitchId.newValue || null; loadBadges(); }
    if (ch.twitchUser) applyAuth(ch.twitchUser.newValue);
  });
  window.addEventListener("pagehide", () => client && client.close());
}

if (typeof document !== "undefined" && document.getElementById && document.getElementById("log")) main();
