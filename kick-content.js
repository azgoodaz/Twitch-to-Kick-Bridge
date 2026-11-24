// Content script for kick.com: the optional "Twitch chat" switch.
//
// Off unless Settings > General > Display > "Show Twitch Chat" is on. On the Kick channel of a streamer you follow on
// Twitch (matched by the extension, and not a possible impersonator) a "Kick | Twitch" switch appears over Kick's chat.
// Pick Twitch and that streamer's Twitch chat takes the place of Kick's chat (Kick's chat keeps running underneath).
//
// - Two styles (Settings, or the button at the top of the chat):
//     Basic ("builtin"): the extension's own small chat client (twitch-chat.html), signed in with the Twitch login you already gave the
//               extension. No emote picker, bits, polls or predictions.
//     Full ("official"): Twitch's own chat, the real page (twitch.tv/embed/.../chat) in a frame, with all of Twitch's features. It signs in with
//               your twitch.tv login in this browser; nothing can hand it the extension's login.
// - Nothing connects to Twitch until you open the Twitch tab.
// - Kick's page is never changed. To sit on top of Kick's chat the script looks at where its chat column is on screen
//   (found by the chat container's id, or from the message box; never from Kick's styling classes) and places its own overlay
//   there. It doesn't read chat messages. It also looks at the layer of Kick's notification banners so it sits just below them.
// - If the chat column can't be found (Kick changed its layout), a floating panel you can drag and resize is used instead.
// - If Kick's page policy blocks the frame, or it doesn't load, the panel offers "Pop out" (a separate window).

// ==== kick-pure-start (no DOM in here, so it can be tested)
// Pages on kick.com that are not channels. (The real filter is the index: only channels you follow on Twitch are in it.)
const KICK_RESERVED = new Set([
  "categories", "category", "browse", "following", "search", "dashboard", "settings", "login", "signup", "register",
  "video", "videos", "clip", "clips", "stream", "api", "help", "support", "terms-of-service", "privacy-policy",
  "community-guidelines", "subscriptions", "creator", "creators", "kicks", "gifts",
]);

function channelSlug(pathname) {
  const first = String(pathname || "").split("/").filter(Boolean)[0];
  if (!first) return null;
  const slug = first.toLowerCase();
  return KICK_RESERVED.has(slug) ? null : slug;
}

// The extension's own chat page, loaded in a frame (pageUrl = chrome.runtime.getURL("twitch-chat.html")).
function chatPageUrl(pageUrl, login, view) {
  return `${pageUrl}?channel=${encodeURIComponent(login)}&view=${encodeURIComponent(view)}`;
}
// Twitch's own chat page. `parent` must be the host of the page that embeds it, or Twitch refuses to load it.
function officialChatUrl(login, host) {
  return `https://www.twitch.tv/embed/${encodeURIComponent(login)}/chat?parent=${encodeURIComponent(host)}&darkpopout`;
}
// What to tell the user when Twitch's own chat frame fails (the background worker watches how Twitch answers it).
function embedProblemText(verdict, status) {
  switch (verdict) {
    case "blocked-by-extension": return "A browser extension (such as an ad or privacy blocker) blocked Twitch's chat. Allow www.twitch.tv in it, or use Pop out or Basic chat.";
    case "refused-xfo":
    case "refused-ancestors": return "Twitch is refusing to show its chat on this site. Use Pop out or Basic chat.";
    case "blocked-by-coep": return "Kick's page tells Chrome to refuse frames from sites that don't opt in to its security policy, and Twitch's chat frame couldn't be adjusted. Use Pop out or Basic chat.";
    case "http-error": return `Twitch answered with an error (HTTP ${status}). Try again in a moment, or use Pop out or Basic chat.`;
    case "blocked-by-response": return "The browser blocked Twitch's chat frame because of a security setting. Use Pop out or Basic chat.";
    case "offline": return "Couldn't reach Twitch. Check your connection, or use Basic chat.";
    case "failed": return "Twitch's chat frame failed to load. Use Pop out or Basic chat.";
    default: return "";
  }
}
// Shown BEHIND Twitch's chat frame: if the frame draws nothing (a blank, see-through page), this is what you see instead of nothing.
const BLANK_HINT = "Waiting for Twitch's chat. If this stays empty, Twitch's chat isn't being allowed to draw here: a browser extension or the browser's cookie settings can cause that. Pop out opens it in its own window, or switch to Basic chat. Settings → Diagnostics shows what Twitch answered.";
const validStyle = (v) => (v === "official" ? "official" : "builtin");
const styleButtonText = (style) => (style === "official" ? "Basic chat" : "Full chat"); // names the style you would switch TO
const styleButtonTitle = (style) => (style === "official"
  ? "Switch to the basic chat built into this extension (signs in with this extension's login)"
  : "Switch to the full chat: Twitch's own chat, with the emote picker and all of Twitch's features (signs in with your twitch.tv login)");

// Which ancestor of Kick's message box is the chat column? `chain` = its ancestors' rectangles, nearest first. The column is
// the HIGHEST ancestor that is still column-shaped: 240-560 px wide, most of the window tall, against the right edge, near the
// top. (Anything wider is the page itself, with the video.) Returns an index into chain, or -1.
function pickChatColumn(chain, vw, vh) {
  let best = -1;
  for (let i = 0; i < chain.length; i++) {
    const r = chain[i];
    if (r.width > 560) break;
    if (r.width >= 240 && r.height >= 0.55 * vh && r.right >= vw - 48 && r.top <= 240 && r.top >= -4) best = i;
  }
  return best;
}
const FLOAT_AFTER = 3000; // ms to look for Kick's chat column before using the floating panel

// Kick shows "x is live" banners (a toaster library whose layer is very high). Our panel must sit just BELOW them, so a banner
// is never hidden by it. toasterZ = the banner container's computed z-index, if it's on the page.
const DEFAULT_TOAST_Z = 999999999;
function overlayLayer(toasterZ) {
  const t = Number.isFinite(toasterZ) && toasterZ > 1 ? toasterZ : DEFAULT_TOAST_Z;
  return Math.max(1, Math.min(t - 1, 2147483000));
}

const MIN_W = 260, MIN_H = 240;
// Floating panel: keeps it fully on screen, whatever size the window is now.
function clampBox(box, vw, vh) {
  const w = Math.min(Math.max(Math.round(box.w), MIN_W), Math.max(MIN_W, vw - 16));
  const h = Math.min(Math.max(Math.round(box.h), MIN_H), Math.max(MIN_H, vh - 16));
  const x = Math.min(Math.max(Math.round(box.x), 8), Math.max(8, vw - w - 8));
  const y = Math.min(Math.max(Math.round(box.y), 8), Math.max(8, vh - h - 8));
  return { x, y, w, h };
}
// Bottom left: clear of the video and of Kick's own chat on the right.
function defaultBox(vw, vh) {
  const h = Math.min(480, Math.max(MIN_H, vh - 96));
  return clampBox({ x: 16, y: vh - h - 16, w: 340, h }, vw, vh);
}
const validBox = (b) => b && [b.x, b.y, b.w, b.h].every((n) => Number.isFinite(n));

function tierNote(tier) {
  return tier === "unconfirmed" ? "Same username, not verified" : tier === "likely" ? "Likely the same person" : "";
}
// ==== kick-pure-end

if (window.top === window) { // not inside Kick's own frames
  const state = { enabled: false, index: {}, tab: "kick", style: "builtin", open: false, box: null, login: null, name: "", tier: "" };
  let host = null;
  let shadow = null;    // the host's shadow root (what attachShadow returns)
  let mode = null;      // "docked" (over Kick's chat column) | "floating" | null
  let view = null;      // the UI of the current mode: { body, frame, msg, frameLogin, frameStyle, ... }
  let column = null;    // Kick's chat column element (read-only: we only measure it)
  let since = 0, sinceSlug = null;
  let loadTimer = null, saveTimer = null, trackTimer = null, waitTimer = null, renderTimer = null;
  let drag = null;

  // z-index comes from --layer (set from Kick's banner layer), so Kick's "x is live" banners show OVER the panel.
  const CSS = `
    :host { all: initial; }
    .pill { position: fixed; left: 16px; bottom: 16px; z-index: var(--layer, 999999000); display: inline-flex; align-items: center; gap: 8px;
      padding: 9px 15px; background: #9146ff; color: #fff; border: 0; border-radius: 999px; font: 600 13px/1 system-ui, sans-serif;
      cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,.45); }
    .pill:hover { filter: brightness(1.1); }
    .win { position: fixed; z-index: var(--layer, 999999000); display: flex; flex-direction: column; box-sizing: border-box; min-width: ${MIN_W}px;
      min-height: ${MIN_H}px; resize: both; overflow: hidden; background: #0e0e10; color: #efeff1; border: 1px solid #2f2f35;
      border-top: 2px solid #9146ff; border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,.55); font: 13px/1.3 system-ui, sans-serif; }
    .pill[hidden], .win[hidden], .msg[hidden], iframe[hidden], .dock[hidden], .tw[hidden] { display: none; }
    .bar { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: #18181b; cursor: grab; user-select: none;
      border-bottom: 1px solid #2f2f35; }
    .bar:active { cursor: grabbing; }
    .title { flex: 1; min-width: 0; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .note { font-size: 11px; color: #adadb8; white-space: nowrap; }
    .bar button, .msg button, .tw .pop, .tw .style { font: inherit; border: 0; border-radius: 6px; padding: 4px 9px; background: #26262c; color: #efeff1; cursor: pointer; }
    .bar button:hover, .tw .pop:hover, .tw .style:hover { background: #34343c; }
    .body { position: relative; flex: 1; min-height: 0; }
    iframe { position: relative; z-index: 1; display: block; width: 100%; height: 100%; border: 0; }
    .hint { position: absolute; inset: 0; z-index: 0; padding: 16px; color: #adadb8; }
    .hint[hidden] { display: none; }
    .msg { padding: 16px; color: #adadb8; }
    .foot { display: flex; justify-content: space-between; gap: 8px; padding: 3px 10px; background: #0e0e10; border-top: 1px solid #26262c; font-size: 11px; }
    .foot[hidden] { display: none; }
    .foot button { background: none; border: 0; padding: 2px 4px; color: #bf94ff; font: inherit; cursor: pointer; }
    .foot button:hover { text-decoration: underline; background: none; }
    .msg button { margin: 10px 8px 0 0; background: #9146ff; color: #fff; padding: 7px 12px; font-weight: 600; }
    .msg button.alt { background: #26262c; color: #efeff1; }
    /* docked: sits exactly over Kick's chat column */
    .dock { position: fixed; z-index: var(--layer, 999999000); pointer-events: none; font: 13px/1.3 system-ui, sans-serif; }
    .tabs { position: absolute; top: 8px; left: 50%; transform: translateX(-50%); z-index: 4; display: flex; gap: 2px; padding: 3px;
      pointer-events: auto; background: #18181b; border: 1px solid #2f2f35; border-radius: 999px; box-shadow: 0 3px 10px rgba(0,0,0,.45); }
    .tabs button { border: 0; background: none; color: #adadb8; font: 600 12px/1 system-ui, sans-serif; padding: 6px 15px; border-radius: 999px; cursor: pointer; }
    .tabs button:hover { color: #efeff1; }
    .tabs .t-kick[aria-pressed="true"] { background: #53fc18; color: #0b0e0f; }
    .tabs .t-twitch[aria-pressed="true"] { background: #9146ff; color: #fff; }
    .tw { position: absolute; inset: 0; display: flex; flex-direction: column; pointer-events: auto; background: #0e0e10; color: #efeff1; padding-top: 46px; }
    /* the two buttons take the room beside the switch (never under it) and shrink in a narrow column */
    .tw .pop, .tw .style { position: absolute; top: 9px; z-index: 3; max-width: calc(50% - 83px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tw .pop { right: 9px; }
    .tw .style { left: 9px; }
  `;

  const make = (tag, props = {}, attrs = {}) => {
    const e = document.createElement(tag);
    Object.assign(e, props);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  };

  const saveSoon = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (state.box) chrome.storage.local.set({ twitchChatPanel: { open: state.open, ...state.box } });
    }, 400);
  };

  // Under Twitch's own chat: always there, even when the frame is blocked and shows Chrome's own error page, which we can't write on.
  function makeFoot() {
    const foot = make("div", { className: "foot", hidden: true });
    const why = make("button", { type: "button", className: "f-why", textContent: "Not loading? See why", title: "Opens Settings → Diagnostics: what Twitch and Kick answered" });
    const pop = make("button", { type: "button", className: "f-pop", textContent: "Pop out" });
    why.addEventListener("click", () => { try { chrome.runtime.sendMessage({ type: "OPEN_DIAGNOSTICS" }).catch(() => {}); } catch (e) { /* extension reloaded: reload the page */ } });
    pop.addEventListener("click", () => popOut());
    foot.append(why, pop);
    return foot;
  }
  function popOut() {
    try {
      chrome.runtime.sendMessage({ type: "OPEN_CHAT_WINDOW", login: state.login, style: state.style }).catch(() => {});
    } catch (e) { /* the extension was reloaded under this page: reload the page */ }
  }

  // The banner layer, so Kick's "x is live" banners are never hidden by the panel.
  function applyLayer() {
    if (!host) return;
    const t = document.querySelector("[data-sonner-toaster]");
    const z = t ? parseInt(getComputedStyle(t).zIndex, 10) : NaN;
    host.style.setProperty("--layer", String(overlayLayer(z)));
  }

  // ---------- the chat frame ----------
  function refreshLabels() {
    if (view && view.foot) view.foot.hidden = state.style !== "official"; // the footer is only for Twitch's own chat, whose frame can be blocked by things we can't see
    if (!view || !view.styleBtn) return;
    view.styleBtn.textContent = styleButtonText(state.style);
    view.styleBtn.title = styleButtonTitle(state.style);
  }
  function showBlocked(why) {
    if (!view) return;
    if (view.frame) view.frame.hidden = true;
    if (view.hint) view.hint.hidden = true;
    if (view.msg) view.msg.remove();
    view.msg = make("div", { className: "msg" });
    const official = state.style === "official";
    view.msg.append(why || (official
      ? "Twitch's chat couldn't load inside this page. Kick may not allow it, or Twitch needs you logged in here. Pop out opens it in its own window, where login always works."
      : "Twitch chat couldn't load inside this page. You can still chat from its own window."));
    const b = make("button", { type: "button", className: "b-pop2", textContent: "Pop out Twitch chat" });
    b.addEventListener("click", popOut);
    view.msg.append(make("br"), b);
    if (official) {
      const alt = make("button", { type: "button", className: "b-builtin alt", textContent: "Use basic chat" });
      alt.addEventListener("click", () => setStyle("builtin"));
      view.msg.append(alt);
    }
    view.body.append(view.msg);
  }
  // Close the chat frame (and with it the connection to Twitch's chat).
  function dropFrame() {
    clearTimeout(loadTimer);
    if (view.frame) view.frame.remove();
    if (view.hint) view.hint.remove();
    if (view.msg) view.msg.remove();
    view.frame = null;
    view.hint = null;
    view.msg = null;
    view.frameLogin = null;
    view.frameStyle = null;
  }
  function frameUrl() {
    return state.style === "official"
      ? officialChatUrl(state.login, location.hostname)
      : chatPageUrl(chrome.runtime.getURL("twitch-chat.html"), state.login, mode === "docked" ? "docked" : "floating");
  }
  // The chat is loaded only when its tab/panel is opened, and kept (connected) while hidden.
  function ensureFrame() {
    if (view.frame && view.frameLogin === state.login && view.frameStyle === state.style) return;
    dropFrame();
    view.frameLogin = state.login;
    view.frameStyle = state.style;
    view.frame = make("iframe", { title: `Twitch chat: ${state.name}` }, { allow: "clipboard-write" });
    view.frame.addEventListener("load", () => clearTimeout(loadTimer));
    if (state.style === "official") { // behind the frame: only visible if the frame draws nothing
      view.hint = make("div", { className: "hint", textContent: BLANK_HINT });
      view.body.append(view.hint);
    }
    view.body.append(view.frame);
    clearTimeout(loadTimer);
    loadTimer = setTimeout(showBlocked, 10000);
    view.frame.src = frameUrl(); // last: nothing is requested before this
  }
  function refreshFrame() { // the style (or streamer) changed: load the right chat now if it's showing, else on next open
    if (!view) return;
    dropFrame();
    refreshLabels();
    if (mode === "docked") applyTab(); else applyOpen();
  }
  function setStyle(next) {
    state.style = validStyle(next);
    refreshFrame();
    chrome.storage.local.set({ twitchChatStyle: state.style });
  }

  // ---------- docked: over Kick's chat column ----------
  const COLUMN_INPUTS = 'textarea, input[type="text"], input:not([type]), [contenteditable="true"], [contenteditable=""], [role="textbox"]';

  // 1) Kick's chat container has its own id. 2) If that ever changes: from the message box, which on Kick is a rich-text editor
  //    (contenteditable, data-testid="chat-input", no placeholder attribute: "Send a message" is a separate label). Neither uses
  //    Kick's styling classes, so a restyle doesn't break it.
  function findChatColumn() {
    const direct = document.getElementById("channel-chatroom");
    if (direct) return direct;
    for (const el of document.querySelectorAll(COLUMN_INPUTS)) {
      const hint = ["placeholder", "aria-label", "data-placeholder", "data-testid"].map((a) => el.getAttribute(a) || "").join(" ");
      if (!/message|chat/i.test(hint)) continue;
      const chain = [], els = [];
      for (let n = el.parentElement; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
        const r = n.getBoundingClientRect();
        chain.push({ width: r.width, height: r.height, right: r.right, top: r.top });
        els.push(n);
      }
      const i = pickChatColumn(chain, window.innerWidth, window.innerHeight);
      if (i >= 0) return els[i];
    }
    return null;
  }

  function track() { // keep the overlay exactly over the column (it moves when Kick's layout does)
    if (mode !== "docked" || !view) return;
    applyLayer();
    if (!column || !column.isConnected) { column = findChatColumn(); if (!column) { view.root.hidden = true; return; } }
    const r = column.getBoundingClientRect();
    if (r.width < 200 || r.height < 200) { view.root.hidden = true; return; } // chat collapsed
    view.root.hidden = false;
    view.root.style.left = `${Math.round(r.left)}px`;
    view.root.style.top = `${Math.round(r.top)}px`;
    view.root.style.width = `${Math.round(r.width)}px`;
    view.root.style.height = `${Math.round(r.height)}px`;
  }

  function applyTab() {
    const tw = state.tab === "twitch";
    view.kickBtn.setAttribute("aria-pressed", String(!tw));
    view.twBtn.setAttribute("aria-pressed", String(tw));
    view.tw.hidden = !tw;
    if (tw) ensureFrame();
  }

  function buildDock() {
    const root = make("div", { className: "dock" });
    const tabs = make("div", { className: "tabs" }, { role: "tablist", "aria-label": "Chat" });
    const kickBtn = make("button", { type: "button", className: "t-kick", textContent: "Kick" }, { role: "tab" });
    const twBtn = make("button", { type: "button", className: "t-twitch", textContent: "Twitch", title: `Twitch chat for ${state.name || "this streamer"}` }, { role: "tab" });
    tabs.append(kickBtn, twBtn);
    const tw = make("div", { className: "tw" });
    const styleBtn = make("button", { type: "button", className: "style" });
    const pop = make("button", { type: "button", className: "pop", textContent: "Pop out", title: "Open Twitch chat in its own window" });
    const body = make("div", { className: "body" });
    const foot = makeFoot();
    tw.append(styleBtn, pop, body, foot);
    root.append(tw, tabs);
    shadow.append(root);
    view = { root, tabs, kickBtn, twBtn, tw, styleBtn, pop, body, foot, frame: null, msg: null, frameLogin: null, frameStyle: null };
    const pick = (tab) => { state.tab = tab; applyTab(); chrome.storage.local.set({ twitchChatTab: tab }); };
    kickBtn.addEventListener("click", () => pick("kick"));
    twBtn.addEventListener("click", () => pick("twitch"));
    styleBtn.addEventListener("click", () => setStyle(state.style === "official" ? "builtin" : "official"));
    pop.addEventListener("click", popOut);
    refreshLabels();
    trackTimer = setInterval(track, 500);
    track();
    applyTab();
  }

  // ---------- floating: used when Kick's chat column can't be found ----------
  function applyBox() {
    const b = state.box;
    view.win.style.left = `${b.x}px`;
    view.win.style.top = `${b.y}px`;
    view.win.style.width = `${b.w}px`;
    view.win.style.height = `${b.h}px`;
  }
  function applyOpen() {
    view.pill.hidden = state.open;
    view.win.hidden = !state.open;
    if (!state.open) return;
    if (!state.box) state.box = defaultBox(window.innerWidth, window.innerHeight);
    applyBox();
    ensureFrame();
  }

  function buildFloating() {
    const pill = make("button", { type: "button", className: "pill", textContent: "Twitch chat", title: "Open Twitch's chat for this streamer" });
    const win = make("div", { className: "win" }, { role: "complementary", "aria-label": "Twitch chat" });
    const bar = make("div", { className: "bar" });
    const title = make("span", { className: "title" });
    const note = make("span", { className: "note" });
    const styleBtn = make("button", { type: "button", className: "b-style" });
    const pop = make("button", { type: "button", className: "b-pop", textContent: "Pop out", title: "Open Twitch chat in its own window" });
    const min = make("button", { type: "button", className: "b-min", textContent: "–", title: "Collapse" }, { "aria-label": "Collapse Twitch chat" });
    const body = make("div", { className: "body" });
    bar.append(title, note, styleBtn, pop, min);
    const foot = makeFoot();
    win.append(bar, body, foot);
    shadow.append(pill, win);
    view = { pill, win, bar, title, note, styleBtn, pop, min, body, foot, frame: null, msg: null, frameLogin: null, frameStyle: null };
    refreshLabels();

    pill.addEventListener("click", () => { state.open = true; applyOpen(); saveSoon(); });
    min.addEventListener("click", () => { state.open = false; applyOpen(); saveSoon(); });
    pop.addEventListener("click", popOut);
    styleBtn.addEventListener("click", () => setStyle(state.style === "official" ? "builtin" : "official"));

    // drag by the title bar (not by its buttons)
    bar.addEventListener("pointerdown", (e) => {
      if (e.target !== bar && e.target !== title && e.target !== note) return;
      drag = { dx: e.clientX - state.box.x, dy: e.clientY - state.box.y };
      if (bar.setPointerCapture) bar.setPointerCapture(e.pointerId);
      if (view.frame) view.frame.style.pointerEvents = "none"; // the frame would swallow the drag
    });
    bar.addEventListener("pointermove", (e) => {
      if (!drag) return;
      state.box = clampBox({ ...state.box, x: e.clientX - drag.dx, y: e.clientY - drag.dy }, window.innerWidth, window.innerHeight);
      applyBox();
    });
    const endDrag = () => {
      if (!drag) return;
      drag = null;
      if (view.frame) view.frame.style.pointerEvents = "";
      saveSoon();
    };
    bar.addEventListener("pointerup", endDrag);
    bar.addEventListener("pointercancel", endDrag);

    // resize (the CSS handle in the corner): remember the new size
    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(() => {
        if (!state.open || !state.box) return;
        const w = win.offsetWidth, h = win.offsetHeight;
        if (w && h && (w !== state.box.w || h !== state.box.h)) {
          state.box = clampBox({ ...state.box, w, h }, window.innerWidth, window.innerHeight);
          saveSoon();
        }
      }).observe(win);
    }
  }

  // What the last Kick channel page looked like to us, for Settings > Diagnostics (so "it doesn't appear" is explainable).
  let lastReport = "";
  function report() {
    const slug = channelSlug(location.pathname);
    if (!state.enabled || !slug) return;
    const inIndex = Boolean(state.index[slug]);
    const sig = `${slug}|${inIndex}|${mode || ""}`;
    if (sig === lastReport) return;
    lastReport = sig;
    chrome.storage.local.set({ kickChatDetect: { slug, inIndex, mode: inIndex ? mode : null, at: Date.now() } });
  }

  // ---------- switching modes, tearing down ----------
  function clearUi() {
    clearTimeout(loadTimer);
    clearInterval(trackTimer);
    trackTimer = null;
    if (host) host.remove();
    host = null;
    shadow = null;
    view = null;
    column = null;
    drag = null;
  }
  function teardown() {
    clearUi();
    clearTimeout(waitTimer);
    mode = null;
    since = 0;
    sinceSlug = null;
    state.login = null;
  }
  function setMode(m) {
    if (mode === m && host) return;
    clearUi();
    mode = m;
    host = make("div", { id: "kick-bridge-chat" });
    shadow = host.attachShadow({ mode: "open" });
    shadow.append(make("style", { textContent: CSS }));
    document.body.appendChild(host);
    if (m === "docked") buildDock(); else buildFloating();
    applyLayer();
    report();
  }

  // Idempotent: called on load, on setting/index changes, on every page change and on a steady beat while Kick's page changes.
  function render() {
    clearTimeout(waitTimer);
    if (host && !host.isConnected) { clearUi(); mode = null; } // Kick's page dropped our element: rebuild it
    const slug = channelSlug(location.pathname);
    const entry = state.enabled && slug ? state.index[slug] : null;
    report();
    if (!entry) return teardown();
    if (state.login && state.login !== entry.l && view) dropFrame(); // another streamer: the old chat closes at once, whichever tab you're on
    state.login = entry.l;
    state.name = entry.n || entry.l;
    state.tier = entry.t;
    if (slug !== sinceSlug) { sinceSlug = slug; since = Date.now(); } // each channel gets its own 3 s to find Kick's chat

    if (!column || !column.isConnected) column = findChatColumn();
    if (column) {
      setMode("docked");
      view.twBtn.title = `Twitch chat for ${state.name}`;
      applyTab();
      track();
    } else if (Date.now() - since >= FLOAT_AFTER) {
      setMode("floating");
      view.title.textContent = `Twitch chat · ${state.name}`;
      const note = tierNote(entry.t);
      view.note.textContent = note;
      view.note.title = note ? "This Kick channel has the same name as a streamer you follow on Twitch, but that isn't verified." : "";
      applyOpen();
      applyLayer();
    } else {
      waitTimer = setTimeout(render, 500); // Kick's chat may still be loading: keep looking for a moment
    }
  }

  // Kick blocks our chat frame with its page policy? Say so, and offer the pop-out. Only OUR frame counts: a blocked resource of
  // some other extension must never hide a chat that works.
  document.addEventListener("securitypolicyviolation", (e) => {
    if (!view || !view.frame) return;
    const blocked = String(e.blockedURI || "");
    const ours = blocked.startsWith(chrome.runtime.getURL("").replace(/\/$/, ""));
    const twitchFrame = state.style === "official" && /^https:\/\/([a-z0-9-]+\.)*twitch\.tv(\/|$)/i.test(blocked) && /frame|child|default/.test(e.effectiveDirective || "frame-src");
    if (ours || twitchFrame) showBlocked();
  });

  chrome.runtime.onMessage.addListener((m) => {
    if (!m || m.type !== "TWITCH_EMBED_RESULT" || state.style !== "official" || !view || !view.frame || m.channel !== state.login) return;
    const why = embedProblemText(m.verdict, m.status);
    if (why) showBlocked(why); // ok -> nothing to say
  });

  chrome.storage.local.get(["showTwitchChat", "kickIndex", "twitchChatPanel", "twitchChatTab", "twitchChatStyle"]).then((s) => {
    state.enabled = Boolean(s.showTwitchChat);
    state.index = s.kickIndex || {};
    state.tab = s.twitchChatTab === "twitch" ? "twitch" : "kick";
    state.style = validStyle(s.twitchChatStyle);
    if (s.twitchChatPanel) {
      state.open = Boolean(s.twitchChatPanel.open);
      if (validBox(s.twitchChatPanel)) state.box = clampBox(s.twitchChatPanel, window.innerWidth, window.innerHeight);
    }
    render();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || (!changes.showTwitchChat && !changes.kickIndex && !changes.twitchChatStyle)) return;
    if (changes.showTwitchChat) state.enabled = Boolean(changes.showTwitchChat.newValue);
    if (changes.kickIndex) state.index = changes.kickIndex.newValue || {};
    if (changes.twitchChatStyle) {
      const next = validStyle(changes.twitchChatStyle.newValue);
      if (next !== state.style) { state.style = next; refreshFrame(); } // changed in Settings: reload the chat in the new style
    }
    render(); // the tab appears or disappears straight away
  });

  // Kick is a single-page app. Check the page on a STEADY beat: at most once per 300 ms however busy the page is. (Waiting for a quiet
  // moment instead never happens on a busy chat, and the panel would not appear until a refresh.)
  const schedule = () => {
    if (renderTimer) return;
    renderTimer = setTimeout(() => { renderTimer = null; render(); }, 300);
  };
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  window.addEventListener("popstate", schedule);
  // Moving between streamers changes the address without any event a content script can hear, so watch the address itself.
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) { lastPath = location.pathname; schedule(); }
    else if (mode === "floating") schedule(); // keep looking for Kick's chat while the fallback is showing
  }, 400);
  window.addEventListener("resize", () => {
    if (mode === "docked") track();
    else if (view && state.box) { state.box = clampBox(state.box, window.innerWidth, window.innerHeight); if (state.open) applyBox(); }
  });
}
