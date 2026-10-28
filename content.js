// Content script: detects the current Twitch channel (Twitch is a SPA, so we
// watch for DOM changes) and shows a floating "Kick profile" button.

const RESERVED = new Set([
  "directory", "videos", "settings", "downloads", "turbo", "subscriptions",
  "wallet", "inventory", "drops", "prime", "jobs", "store", "friends",
  "messages", "p", "popout", "embed", "search", "login", "signup", "u",
]);

const BTN_ID = "kick-bridge-btn";
let state = { login: null, data: null };
let timer = null;
let minimal = false; // "Minimal button" setting (see options page)

chrome.storage.local.get("minimal").then((s) => {
  minimal = Boolean(s.minimal);
  ensureButton();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.minimal) {
    minimal = Boolean(changes.minimal.newValue);
    ensureButton(); // re-render right away, no page reload needed
  }
});

function currentChannel() {
  const first = location.pathname.split("/").filter(Boolean)[0];
  if (!first || RESERVED.has(first.toLowerCase())) return null;
  return first.toLowerCase();
}

function injectStyle() {
  if (document.getElementById("kick-bridge-style")) return;
  const s = document.createElement("style");
  s.id = "kick-bridge-style";
  s.textContent = `
    #${BTN_ID} {
      position: fixed; top: 60px; right: 16px; z-index: 9999;
      display: inline-flex; align-items: center; gap: 8px;
      padding: 6px 12px; border-radius: 6px;
      background: #53fc18; color: #0b0e0f; font: 600 13px/1 system-ui, sans-serif;
      text-decoration: none; box-shadow: 0 2px 8px rgba(0,0,0,.35);
    }
    #${BTN_ID}:hover { filter: brightness(1.08); }
    #${BTN_ID}.min { padding: 5px 10px; gap: 6px; }
    #${BTN_ID} .dot { width: 8px; height: 8px; border-radius: 50%; background: #0b0e0f55; }
    #${BTN_ID}.live .dot { background: #e91916; }
    #${BTN_ID} .unverified { opacity: .6; font-weight: 500; }
  `;
  document.head.appendChild(s);
}

function removeButton() {
  document.getElementById(BTN_ID)?.remove();
}

function ensureButton() {
  const d = state.data;
  if (!state.login || !d?.kickSlug) return removeButton();

  const existing = document.getElementById(BTN_ID);
  if (existing?.dataset.login === state.login && existing.dataset.minimal === String(minimal)) return;
  removeButton();
  injectStyle();

  const a = document.createElement("a");
  a.id = BTN_ID;
  a.dataset.login = state.login;
  a.dataset.minimal = String(minimal);
  a.href = `https://kick.com/${encodeURIComponent(d.kickSlug)}`;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.className = d.isLive ? "live" : "";
  const tips = [];
  if (d.linked) tips.push("A bio links the Twitch and Kick channels.");
  if (d.kickVerified) tips.push("This Kick channel has Kick's verified badge.");
  if (!d.linked) tips.push("Matched by username only; not confirmed to be the same account.");
  if (minimal) tips.unshift(d.isLive ? "Live on Kick." : "Offline on Kick.");
  a.title = tips.join(" ");

  const dot = document.createElement("span");
  dot.className = "dot";
  const label = document.createElement("span");
  label.textContent = minimal ? "Kick" : d.isLive ? "Live on Kick ↗" : "Kick profile ↗";
  a.append(dot, label);
  if (minimal) a.classList.add("min");

  if (!minimal && d.kickVerified) {
    const v = document.createElement("span");
    v.textContent = "✓";
    a.append(v);
  }
  if (!minimal && !d.linked) {
    const q = document.createElement("span");
    q.className = "unverified";
    q.textContent = d.kickVerified ? "(same name)" : "(unconfirmed)";
    a.append(q);
  }
  document.body.appendChild(a);
}

async function refresh() {
  const login = currentChannel();
  if (login !== state.login) {
    removeButton();
    state = { login, data: null };
    if (login) {
      try {
        const res = await chrome.runtime.sendMessage({ type: "LOOKUP", login });
        if (state.login === login) state.data = res;
        if (res?.error === "NO_CREDENTIALS") {
          console.warn("[Kick Bridge] Add your API credentials in the extension options.");
        } else if (res?.error) {
          console.warn("[Kick Bridge]", res.error);
        }
      } catch (e) {
        console.debug("[Kick Bridge] message failed", e);
      }
    }
  }
  ensureButton();
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(refresh, 300);
}

new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
schedule();
