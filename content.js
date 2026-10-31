// Content script: detects the current Twitch channel (Twitch is a SPA, so we
// watch for DOM changes) and shows a floating "Kick profile" button.
//
// The Kick channel with the same name isn't always the same person, so the
// button reflects how sure we are (see "Is this Kick account really them?" in
// background.js): confirmed / likely / unconfirmed / possible impersonator.

const RESERVED = new Set([
  "directory", "videos", "settings", "downloads", "turbo", "subscriptions",
  "wallet", "inventory", "drops", "prime", "jobs", "store", "friends",
  "messages", "p", "popout", "embed", "search", "login", "signup", "u",
]);

const BTN_ID = "kick-bridge-btn";
let state = { login: null, data: null };
let timer = null;
let minimal = false;   // "Minimal button" setting (see options page)
let overrides = {};    // your corrections: login -> "yes" | "not"
let overrideTimes = {}; // when you clicked "It's them" (login -> ms)
const RECENT_CONFIRM_MS = 5 * 60 * 1000; // "Undo" shows for this long after you confirm, then retires
let expiryTimer = null;

chrome.storage.local.get(["minimal", "kickOverrides", "kickOverrideTimes"]).then((s) => {
  minimal = Boolean(s.minimal);
  overrides = s.kickOverrides || {};
  overrideTimes = s.kickOverrideTimes || {};
  ensureButton();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.minimal) minimal = Boolean(changes.minimal.newValue);
  if (changes.kickOverrides) overrides = changes.kickOverrides.newValue || {};
  if (changes.kickOverrideTimes) overrideTimes = changes.kickOverrideTimes.newValue || {};
  if (changes.minimal || changes.kickOverrides || changes.kickOverrideTimes) ensureButton(); // re-render right away
});

// Same small function as in background.js / popup.js: keep in sync.
function effectiveTier(v, override) {
  if (override === "not") return "none"; // you said it isn't them
  if (override === "yes") return "confirmed";
  return v?.tier || "unconfirmed";
}

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
      display: inline-flex; align-items: center; gap: 10px;
      padding: 6px 12px; border-radius: 6px;
      background: #53fc18; color: #0b0e0f; font: 600 13px/1 system-ui, sans-serif;
      box-shadow: 0 2px 8px rgba(0,0,0,.35);
    }
    #${BTN_ID}.warn { background: #ffb020; }
    #${BTN_ID}.min { padding: 5px 10px; }
    #${BTN_ID} .kb-link { display: inline-flex; align-items: center; gap: 8px; color: inherit; text-decoration: none; }
    #${BTN_ID} .kb-link:hover { filter: brightness(.92); }
    #${BTN_ID} .dot { width: 8px; height: 8px; border-radius: 50%; background: #0b0e0f55; }
    #${BTN_ID}.live .dot { background: #e91916; }
    #${BTN_ID} .muted { opacity: .6; font-weight: 500; }
    #${BTN_ID} .kb-act {
      all: unset; cursor: pointer; font: 500 11px/1 system-ui, sans-serif;
      text-decoration: underline; opacity: .85;
    }
    #${BTN_ID} .kb-act:hover { opacity: 1; }
  `;
  document.head.appendChild(s);
}

function removeButton() {
  document.getElementById(BTN_ID)?.remove();
}

function setOverride(login, verdict) {
  chrome.runtime.sendMessage({ type: "SET_OVERRIDE", login, verdict }).catch(() => {});
}

function ensureButton() {
  const d = state.data;
  if (!state.login || !d?.kickSlug) return removeButton();

  const ov = overrides[state.login];
  const tier = effectiveTier(d, ov);
  if (tier === "none") return removeButton(); // you said it isn't them

  const live = Boolean(d.isLive) && tier !== "suspected"; // a lookalike's stream isn't "live" for you
  const age = Date.now() - (overrideTimes[state.login] || 0);
  const recent = ov === "yes" && age < RECENT_CONFIRM_MS; // just confirmed: shows Undo for a few minutes
  clearTimeout(expiryTimer);
  if (recent) expiryTimer = setTimeout(ensureButton, RECENT_CONFIRM_MS - age + 500); // then retire it
  const sig = [state.login, minimal, tier, live, ov || "", recent, d.kickVerified].join("|");
  const existing = document.getElementById(BTN_ID);
  if (existing?.dataset.sig === sig) return;
  removeButton();
  injectStyle();

  const wrap = document.createElement("div");
  wrap.id = BTN_ID;
  wrap.dataset.sig = sig;
  wrap.className = [tier === "suspected" ? "warn" : "", live ? "live" : "", minimal ? "min" : ""].join(" ").trim();

  const a = document.createElement("a");
  a.className = "kb-link";
  a.href = `https://kick.com/${encodeURIComponent(d.kickSlug)}`;
  a.target = "_blank";
  a.rel = "noopener noreferrer";

  const headline =
    ov === "yes" && recent ? "You confirmed this match."
      : tier === "confirmed" ? "Confirmed match."
      : tier === "likely" ? "Likely the same person."
      : tier === "suspected" ? "Possible impersonator: this Kick account probably isn't them."
      : "Matched by username only; not confirmed to be the same person.";
  const tips = [headline, (d.reasons || []).join(" · ")];
  if (tier === "suspected") tips.push("If this is the real account, click “It's them”.");
  if (minimal) tips.unshift(live ? "Live on Kick." : "Offline on Kick.");
  a.title = tips.filter(Boolean).join(" ");

  const dot = document.createElement("span");
  dot.className = "dot";
  const label = document.createElement("span");
  if (tier === "suspected") label.textContent = minimal ? "⚠ Kick" : "⚠ Possible impersonator on Kick ↗";
  else label.textContent = minimal ? "Kick" : live ? "Live on Kick ↗" : "Kick profile ↗";
  a.append(tier === "suspected" ? document.createTextNode("") : dot, label);
  wrap.append(a);

  if (!minimal) {
    if (d.kickVerified && tier !== "suspected") {
      const v = document.createElement("span");
      v.textContent = "✓";
      a.append(v);
    }
    if (tier === "likely" || tier === "unconfirmed") {
      const q = document.createElement("span");
      q.className = "muted";
      q.textContent = tier === "likely" ? "(likely)" : "(unconfirmed)";
      a.append(q);
    }
    // Corrections, only where a human judgement can help (or to undo one).
    const act = (text, verdict) => {
      const b = document.createElement("button");
      b.className = "kb-act";
      b.textContent = text;
      b.addEventListener("click", () => setOverride(state.login, verdict));
      wrap.append(b);
    };
    if (!ov && (tier === "suspected" || tier === "unconfirmed")) {
      act("Not them", "not");
      act("It's them", "yes");
    } else if (recent) {
      act("Undo", null);
    }
  }
  document.body.appendChild(wrap);
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
