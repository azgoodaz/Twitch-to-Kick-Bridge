const FIELDS = ["kickId", "kickSecret", "twitchId", "twitchSecret"];
const $ = (id) => document.getElementById(id);

chrome.storage.local.get(FIELDS).then((vals) => {
  for (const f of FIELDS) $(f).value = vals[f] || "";
});

$("save").addEventListener("click", async () => {
  const vals = Object.fromEntries(FIELDS.map((f) => [f, $(f).value.trim()]));
  // Drop cached tokens so new credentials take effect immediately.
  await chrome.storage.local.remove(["kickToken", "twitchToken"]);
  // Forget remembered failures so new credentials get a fresh try.
  const all = await chrome.storage.local.get(null);
  const bad = Object.keys(all).filter((k) => k.startsWith("kc:") && all[k]?.value?.failed);
  if (bad.length) await chrome.storage.local.remove(bad);
  await chrome.storage.local.set(vals);
  $("saved").textContent = "Saved ✓";
  setTimeout(() => ($("saved").textContent = ""), 1500);
});

$("test").addEventListener("click", async () => {
  const login = $("testLogin").value.trim();
  if (!login) return;
  $("out").textContent = "Looking up…";
  const res = await chrome.runtime.sendMessage({ type: "LOOKUP", login });
  $("out").textContent = JSON.stringify(res, null, 2);
});

$("redirect").textContent = chrome.identity.getRedirectURL();

// "Minimal button" saves immediately; the content script reacts live.
chrome.storage.local.get("minimal").then((s) => ($("minimal").checked = Boolean(s.minimal)));
$("minimal").addEventListener("change", (e) => chrome.storage.local.set({ minimal: e.target.checked }));

// Checking speed: saved as you type, read at the start of each check.
chrome.storage.local.get(["rateBatch", "rateMinutes"]).then((s) => {
  $("rateBatch").value = s.rateBatch || 200;
  $("rateMinutes").value = s.rateMinutes || 3;
});
for (const id of ["rateBatch", "rateMinutes"]) {
  $(id).addEventListener("change", (e) => {
    const n = Number(e.target.value);
    if (n > 0) chrome.storage.local.set({ [id]: n });
  });
}

// Toolbar badge: saved immediately; the background worker reacts to the change.
chrome.storage.local.get("showBadge").then((s) => ($("showBadge").checked = Boolean(s.showBadge)));
$("showBadge").addEventListener("change", (e) => chrome.storage.local.set({ showBadge: e.target.checked }));

// ---------- Connections ----------
function fmtLeft(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

async function renderConnections() {
  const { twitchUser: t, kickUser: k } = await chrome.storage.local.get(["twitchUser", "kickUser"]);

  const left = t ? t.exp - Date.now() : 0;
  $("twitchState").textContent = !t
    ? "Not connected"
    : left > 0
      ? `Connected as ${t.login} · session ends in ${fmtLeft(left)}`
      : `Connected as ${t.login} · session expired, reconnect to refresh your follows`;
  $("twitchConnect").textContent = t ? "Reconnect" : "Connect";
  $("twitchLogout").hidden = !t;

  $("kickState").textContent = k ? `Connected as ${k.name || "your Kick account"}` : "Not connected";
  $("kickConnect").textContent = k ? "Reconnect" : "Connect";
  $("kickLogout").hidden = !k;
}

async function runConnection(type, doing) {
  const buttons = document.querySelectorAll(".btns button");
  $("connMsg").textContent = doing;
  buttons.forEach((b) => (b.disabled = true));
  const res = await chrome.runtime.sendMessage({ type });
  buttons.forEach((b) => (b.disabled = false));

  if (res?.error) {
    let msg = `Failed: ${res.error}`;
    if (/invalid_scope/i.test(res.error)) msg += " Enable “Read user information” for your Kick app.";
    if (/could not be loaded/i.test(res.error)) msg += " Check the redirect URL above is registered in that app.";
    $("connMsg").textContent = msg;
  } else {
    $("connMsg").textContent = "";
  }
  renderConnections();
}

$("twitchConnect").addEventListener("click", () => runConnection("TWITCH_LOGIN", "Opening Twitch login…"));
$("twitchLogout").addEventListener("click", () => runConnection("TWITCH_LOGOUT", "Logging out of Twitch…"));
$("kickConnect").addEventListener("click", () => runConnection("KICK_LOGIN", "Opening Kick login…"));
$("kickLogout").addEventListener("click", () => runConnection("KICK_LOGOUT", "Logging out of Kick…"));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.twitchUser || changes.kickUser)) renderConnections();
});
setInterval(renderConnections, 30000); // keeps "session ends in …" current
renderConnections();
