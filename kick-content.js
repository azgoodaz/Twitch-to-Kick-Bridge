// Content script for kick.com: the optional "Twitch chat" switch.
//
// Off unless Settings > General > Display > "Show Twitch Chat" is on. On the Kick channel of a streamer you follow on
// Twitch (matched by the extension, and not a possible impersonator) a "Kick | Twitch" switch appears over Kick's chat.
// Pick Twitch and that streamer's Twitch chat takes the place of Kick's chat (Kick's chat keeps running underneath).
//
// - The chat is the extension's own small Twitch chat client (twitch-chat.html), signed in with the Twitch login you already
//   gave the extension (needs the optional chat permission, otherwise read-only). It is NOT Twitch's embed: that can't share
//   your login.
// - Nothing connects to Twitch until you open the Twitch tab.
// - Kick's page is never changed. To sit on top of Kick's chat the script looks at where its chat column is on screen
//   (found by the chat container's id, or from the message box; never from Kick's styling classes) and places its own overlay
//   there. It doesn't read chat messages.
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
  const state = { enabled: false, index: {}, tab: "kick", open: false, box: null, login: null, name: "", tier: "" };
  let host = null;
  let shadow = null;    // the host's shadow root (what attachShadow returns)
  let mode = null;      // "docked" (over Kick's chat column) | "floating" | null
  let view = null;      // the UI of the current mode: { body, frame, msg, frameLogin, ... }
  let column = null;    // Kick's chat column element (read-only: we only measure it)
  let since = 0;
  let loadTimer = null, saveTimer = null, trackTimer = null, waitTimer = null, renderTimer = null;
  let drag = null;

  const CSS = `
    :host { all: initial; }
    .pill { position: fixed; left: 16px; bottom: 16px; z-index: 2147483000; display: inline-flex; align-items: center; gap: 8px;
      padding: 9px 15px; background: #9146ff; color: #fff; border: 0; border-radius: 999px; font: 600 13px/1 system-ui, sans-serif;
      cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,.45); }
    .pill:hover { filter: brightness(1.1); }
    .win { position: fixed; z-index: 2147483000; display: flex; flex-direction: column; box-sizing: border-box; min-width: ${MIN_W}px;
      min-height: ${MIN_H}px; resize: both; overflow: hidden; background: #0e0e10; color: #efeff1; border: 1px solid #2f2f35;
      border-top: 2px solid #9146ff; border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,.55); font: 13px/1.3 system-ui, sans-serif; }
    .pill[hidden], .win[hidden], .msg[hidden], iframe[hidden], .dock[hidden], .tw[hidden] { display: none; }
    .bar { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: #18181b; cursor: grab; user-select: none;
      border-bottom: 1px solid #2f2f35; }
    .bar:active { cursor: grabbing; }
    .title { flex: 1; min-width: 0; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .note { font-size: 11px; color: #adadb8; white-space: nowrap; }
    .bar button, .msg button, .tw .pop { font: inherit; border: 0; border-radius: 6px; padding: 4px 9px; background: #26262c; color: #efeff1; cursor: pointer; }
    .bar button:hover, .tw .pop:hover { background: #34343c; }
    .body { position: relative; flex: 1; min-height: 0; }
    iframe { display: block; width: 100%; height: 100%; border: 0; }
    .msg { padding: 16px; color: #adadb8; }
    .msg button { margin-top: 10px; background: #9146ff; color: #fff; padding: 7px 12px; font-weight: 600; }
    /* docked: sits exactly over Kick's chat column */
    .dock { position: fixed; z-index: 2147483000; pointer-events: none; font: 13px/1.3 system-ui, sans-serif; }
    .tabs { position: absolute; top: 8px; left: 50%; transform: translateX(-50%); z-index: 2; display: flex; gap: 2px; padding: 3px;
      pointer-events: auto; background: #18181b; border: 1px solid #2f2f35; border-radius: 999px; box-shadow: 0 3px 10px rgba(0,0,0,.45); }
    .tabs button { border: 0; background: none; color: #adadb8; font: 600 12px/1 system-ui, sans-serif; padding: 6px 15px; border-radius: 999px; cursor: pointer; }
    .tabs button:hover { color: #efeff1; }
    .tabs .t-kick[aria-pressed="true"] { background: #53fc18; color: #0b0e0f; }
    .tabs .t-twitch[aria-pressed="true"] { background: #9146ff; color: #fff; }
    .tw { position: absolute; inset: 0; display: flex; flex-direction: column; pointer-events: auto; background: #0e0e10; color: #efeff1; padding-top: 46px; }
    .tw .pop { position: absolute; top: 9px; right: 9px; z-index: 3; }
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

  function popOut() {
    try {
      chrome.runtime.sendMessage({ type: "OPEN_CHAT_WINDOW", login: state.login }).catch(() => {});
    } catch (e) { /* the extension was reloaded under this page: reload the page */ }
  }

  function showBlocked() {
    if (!view) return;
    if (view.frame) view.frame.hidden = true;
    if (!view.msg) {
      view.msg = make("div", { className: "msg" });
      view.msg.append("Twitch chat couldn't load inside this page. You can still chat from its own window.");
      const b = make("button", { type: "button", className: "b-pop2", textContent: "Pop out Twitch chat" });
      b.addEventListener("click", popOut);
      view.msg.append(make("br"), b);
      view.body.append(view.msg);
    }
    view.msg.hidden = false;
  }

  // The chat page is loaded only when its tab/panel is opened, and kept (connected) while hidden.
  // Close the chat frame (and with it the connection to Twitch's chat).
  function dropFrame() {
    clearTimeout(loadTimer);
    if (view.frame) view.frame.remove();
    view.frame = null;
    view.frameLogin = null;
    if (view.msg) view.msg.hidden = true;
  }
  function ensureFrame() {
    if (view.frame && view.frameLogin === state.login) return;
    dropFrame();
    view.frameLogin = state.login;
    view.frame = make("iframe", { title: `Twitch chat: ${state.name}` }, { allow: "clipboard-write" });
    view.frame.addEventListener("load", () => clearTimeout(loadTimer));
    view.body.append(view.frame);
    clearTimeout(loadTimer);
    loadTimer = setTimeout(showBlocked, 10000);
    view.frame.src = chatPageUrl(chrome.runtime.getURL("twitch-chat.html"), state.login, mode === "docked" ? "docked" : "floating"); // last: nothing is requested before this
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
    const pop = make("button", { type: "button", className: "pop", textContent: "Pop out", title: "Open Twitch chat in its own window" });
    const body = make("div", { className: "body" });
    tw.append(pop, body);
    root.append(tw, tabs);
    shadow.append(root);
    view = { root, tabs, kickBtn, twBtn, tw, pop, body, frame: null, msg: null, frameLogin: null };
    const pick = (tab) => { state.tab = tab; applyTab(); chrome.storage.local.set({ twitchChatTab: tab }); };
    kickBtn.addEventListener("click", () => pick("kick"));
    twBtn.addEventListener("click", () => pick("twitch"));
    pop.addEventListener("click", popOut);
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
    const pop = make("button", { type: "button", className: "b-pop", textContent: "Pop out", title: "Open Twitch chat in its own window" });
    const min = make("button", { type: "button", className: "b-min", textContent: "–", title: "Collapse" }, { "aria-label": "Collapse Twitch chat" });
    const body = make("div", { className: "body" });
    bar.append(title, note, pop, min);
    win.append(bar, body);
    shadow.append(pill, win);
    view = { pill, win, bar, title, note, pop, min, body, frame: null, msg: null, frameLogin: null };

    pill.addEventListener("click", () => { state.open = true; applyOpen(); saveSoon(); });
    min.addEventListener("click", () => { state.open = false; applyOpen(); saveSoon(); });
    pop.addEventListener("click", popOut);

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
    report();
  }

  // Idempotent: called on load, on setting/index changes and on every page change.
  function render() {
    clearTimeout(waitTimer);
    const slug = channelSlug(location.pathname);
    const entry = state.enabled && slug ? state.index[slug] : null;
    report();
    if (!entry) return teardown();
    if (state.login && state.login !== entry.l && view) dropFrame(); // another streamer: the old chat closes at once, whichever tab you're on
    state.login = entry.l;
    state.name = entry.n || entry.l;
    state.tier = entry.t;
    if (!since) since = Date.now();

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
    } else {
      waitTimer = setTimeout(render, 500); // Kick's chat may still be loading: keep looking for a moment
    }
  }

  // Kick blocks our chat frame with its page policy? Say so, and offer the pop-out. Only OUR frame counts: a blocked
  // resource of some other extension must never hide a chat that works.
  document.addEventListener("securitypolicyviolation", (e) => {
    if (view && view.frame && String(e.blockedURI || "").startsWith(chrome.runtime.getURL("").replace(/\/$/, ""))) showBlocked();
  });

  chrome.storage.local.get(["showTwitchChat", "kickIndex", "twitchChatPanel", "twitchChatTab"]).then((s) => {
    state.enabled = Boolean(s.showTwitchChat);
    state.index = s.kickIndex || {};
    state.tab = s.twitchChatTab === "twitch" ? "twitch" : "kick";
    if (s.twitchChatPanel) {
      state.open = Boolean(s.twitchChatPanel.open);
      if (validBox(s.twitchChatPanel)) state.box = clampBox(s.twitchChatPanel, window.innerWidth, window.innerHeight);
    }
    render();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || (!changes.showTwitchChat && !changes.kickIndex)) return;
    if (changes.showTwitchChat) state.enabled = Boolean(changes.showTwitchChat.newValue);
    if (changes.kickIndex) state.index = changes.kickIndex.newValue || {};
    render(); // the tab appears or disappears straight away
  });

  // Kick is a single-page app: watch for navigation to another channel.
  const schedule = () => { clearTimeout(renderTimer); renderTimer = setTimeout(render, 300); };
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  window.addEventListener("popstate", schedule);
  window.addEventListener("resize", () => {
    if (mode === "docked") track();
    else if (view && state.box) { state.box = clampBox(state.box, window.innerWidth, window.innerHeight); if (state.open) applyBox(); }
  });
}
