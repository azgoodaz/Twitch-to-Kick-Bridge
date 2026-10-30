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

// ---------- Diagnostics ----------
// ==== diagnostics-pure-start (no chrome.* calls in here, so it can be tested)
const fmtDur = (ms) => {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)} days`;
};
const ago = (ms) => (ms < 60000 ? "just now" : `${fmtDur(ms)} ago`);
const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const bytesOf = (v) => new Blob([JSON.stringify(v)]).size;

// all = everything in chrome.storage.local, total = bytes in use, quota = byte limit.
// Returns [{ group } | { label, text, status }], status = "ok" | "warn" | "bad" | "".
function buildDiagnostics(all, total, now, quota, extra = {}) {
  const rows = [];
  const group = (name) => rows.push({ group: name });
  const add = (label, text, status = "") => rows.push({ label, text, status });

  group("Credentials");
  const kickOk = Boolean(all.kickId && all.kickSecret);
  add("Kick app", kickOk ? "Client ID and Secret set" : "Missing. Add them in the Kick section above", kickOk ? "ok" : "bad");
  add("Twitch app",
    !all.twitchId ? "Client ID missing"
      : all.twitchSecret ? "Client ID and Secret set"
      : "Client ID set (no secret: the channel-page bio check is off)",
    all.twitchId ? "ok" : "bad");

  group("Tokens");
  const token = (label, obj, who, expiredNote) => {
    if (!obj) return add(label, "Not connected", "");
    const left = obj.exp - now;
    if (left > 10 * 60_000) add(label, `${who}. Expires in ${fmtDur(left)}`, "ok");
    else if (left > 0) add(label, `${who}. Expires in ${fmtDur(left)}`, "warn");
    else add(label, `${who}. Expired ${ago(-left)}. ${expiredNote}`, "warn");
  };
  token("Twitch login", all.twitchUser, all.twitchUser && `Connected as ${all.twitchUser.login}`, "Reconnect in Connections to refresh your follows.");
  token("Kick login", all.kickUser, all.kickUser && `Connected as ${all.kickUser.name || "your Kick account"}`, "Nothing uses this token yet.");
  const appToken = (label, obj) =>
    !obj ? add(label, "None yet (fetched on first use)", "")
      : obj.exp - now > 0 ? add(label, `Valid, expires in ${fmtDur(obj.exp - now)}`, "ok")
      : add(label, "Expired (renewed automatically on next use)", "");
  appToken("Twitch app token", all.twitchToken);
  appToken("Kick app token", all.kickToken);

  group("Checks");
  const ss = all.scanState || {};
  const rl = all.rateLimit;
  const batch = all.rateBatch || 200, minutes = all.rateMinutes || 3;
  const alive = ss.running && now - (ss.heartbeat || 0) < 20_000;
  if (alive && ss.pausedUntil > now) {
    add("Rate limit", `Paused by Kick. Resuming in ${fmtDur(ss.pausedUntil - now)}`, "bad");
  } else if (!ss.running && ss.limited) {
    add("Rate limit", "The last check gave up after repeated rate limits. Press ↻ later, or lower the speed", "bad");
  } else if (rl?.lastAt) {
    add("Rate limit", `Not limited now. Last hit ${ago(now - rl.lastAt)} (${rl.total} since the cache was cleared)`,
      now - rl.lastAt < 15 * 60_000 ? "warn" : "ok");
  } else {
    add("Rate limit", "None recorded", "ok");
  }
  add("Pace", `${batch} streamers every ${minutes} min (one every ${((minutes * 60) / batch).toFixed(1)}s)`);
  const left = (all.scanItems || []).length - (all.scanIndex || 0);
  if (alive) add("Check", `Running: ${ss.done}/${ss.total}`, "ok");
  else if (all.scanItems && left > 0) add("Check", `Interrupted with ${left} left. It resumes automatically`, "warn");
  else if (ss.finishedAt) add("Check", `Idle. Last finished ${ago(now - ss.finishedAt)}`, "ok");
  else add("Check", "Nothing checked yet");

  const favList = all.favorites || [];
  if (!favList.length) {
    add("Favorites", "None starred");
  } else {
    const fc = all.favCheck;
    const parts = [`${favList.length} favorite${favList.length > 1 ? "s" : ""}`];
    parts.push(fc?.lastAt ? `last checked ${ago(now - fc.lastAt)}` : "not checked yet");
    if (extra.favNextAt && extra.favNextAt > now) parts.push(`next in ${fmtDur(extra.favNextAt - now)}`);
    parts.push(`notifications ${all.notifyFavorites ? "on" : "off"}`);
    if (fc?.error) parts.push(`last attempt failed: ${fc.error}`);
    add("Favorites", parts.join(", "), fc?.error ? "warn" : "ok");
  }

  group("Cache");
  const entries = Object.entries(all).filter(([k]) => k.startsWith("kc:"));
  let found = 0, notOn = 0, failed = 0, oldest = Infinity, newest = 0, size = 0;
  for (const [, e] of entries) {
    size += bytesOf(e);
    if (e.value?.failed) failed++;
    else if (e.value?.kickSlug) found++;
    else notOn++;
    oldest = Math.min(oldest, e.at);
    newest = Math.max(newest, e.at);
  }
  if (entries.length) {
    add("Lookups", `${entries.length} channels: ${found} on Kick, ${notOn} not on Kick, ${failed} failed (~${fmtBytes(size)})`, failed ? "warn" : "");
    add("Checked", `oldest ${ago(now - oldest)}, newest ${ago(now - newest)}`);
  } else {
    add("Lookups", "Empty");
  }
  const fc = all.followsCache;
  add("Follow list", fc ? `${fc.list.length} follows, saved ${ago(now - fc.at)} (~${fmtBytes(bytesOf(fc))})` : "Not loaded yet");
  add("Storage", `${fmtBytes(total)} used of ${fmtBytes(quota)}`, total > quota * 0.8 ? "warn" : "");

  group("Recent errors");
  const log = all.errorLog || [];
  if (!log.length) add("None", "No errors recorded", "ok");
  for (const e of log) add(ago(now - e.at), `${e.source}: ${e.message}${e.count > 1 ? ` (×${e.count})` : ""}`, "bad");
  return rows;
}

function diagnosticsText(rows, version, now) {
  const lines = [`Twitch → Kick Bridge ${version} diagnostics (${new Date(now).toISOString()})`];
  for (const r of rows) lines.push(r.group ? `\n[${r.group}]` : `${r.label}: ${r.text}`);
  return lines.join("\n");
}
// ==== diagnostics-pure-end

let lastDiagRows = [];

async function renderDiagnostics() {
  const all = await chrome.storage.local.get(null);
  const total = await chrome.storage.local.getBytesInUse(null);
  const quota = chrome.storage.local.QUOTA_BYTES || 10485760;
  const favAlarm = await chrome.alarms.get("kick-bridge-favs");
  lastDiagRows = buildDiagnostics(all, total, Date.now(), quota, { favNextAt: favAlarm?.scheduledTime });

  const table = $("diag");
  table.textContent = "";
  for (const r of lastDiagRows) {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    if (r.group) {
      tr.className = "grp";
      th.colSpan = 2;
      th.textContent = r.group;
      tr.append(th);
    } else {
      th.textContent = r.label;
      const td = document.createElement("td");
      const dot = document.createElement("span");
      dot.className = `dot ${r.status || ""}`;
      td.append(dot, document.createTextNode(r.text));
      tr.append(th, td);
    }
    table.append(tr);
  }
}

$("copyDiag").addEventListener("click", async () => {
  const text = diagnosticsText(lastDiagRows, chrome.runtime.getManifest().version, Date.now());
  try {
    await navigator.clipboard.writeText(text);
    $("diagMsg").textContent = "Copied.";
  } catch (e) {
    $("diagMsg").textContent = "Couldn't copy to the clipboard.";
  }
  setTimeout(() => ($("diagMsg").textContent = ""), 2000);
});

$("clearCache").addEventListener("click", async () => {
  const s = await chrome.storage.local.get(["followsCache", "rateBatch", "rateMinutes"]);
  const n = s.followsCache?.list?.length || 0;
  const mins = Math.ceil((n / (s.rateBatch || 200)) * (s.rateMinutes || 3));
  const warn = n
    ? `\n\nThe next time you open the popup it will re-check all ${n} follows (about ${mins} min at your current speed).`
    : "";
  if (!confirm(`Clear the cache? Your logins, credentials and settings are kept.${warn}`)) return;

  $("diagMsg").textContent = "Clearing…";
  const res = await chrome.runtime.sendMessage({ type: "CLEAR_CACHE" });
  $("diagMsg").textContent = res?.error ? `Failed: ${res.error}` : `Cleared ${res.removed} items.`;
  renderDiagnostics();
});

// Live view: refresh when anything is saved (debounced), plus a slow tick for countdowns.
let diagTimer = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  clearTimeout(diagTimer);
  diagTimer = setTimeout(renderDiagnostics, 1000);
});
setInterval(renderDiagnostics, 10000);
renderDiagnostics();

// ---------- Favorites ----------
// ==== favorites-pure-start (no chrome.* calls in here, so it can be tested)
// s = storage values, kc = the "kc:<login>" entries of the favorites, nextAt = next hourly check (ms) or undefined
function buildFavorites(s, kc, nextAt, now) {
  const favs = s.favorites || [];
  const names = new Map((s.followsCache?.list || []).map((f) => [f.login, f.name]));
  const parts = [`${favs.length} of 10 favorites`];
  if (favs.length) {
    parts.push(s.favCheck?.lastAt ? `last checked ${ago(now - s.favCheck.lastAt)}` : "not checked yet");
    if (nextAt && nextAt > now) parts.push(`next check in ${fmtDur(nextAt - now)}`);
    if (s.favCheck?.error) parts.push(`last attempt failed: ${s.favCheck.error}`);
  }
  const items = favs.map((login) => {
    const v = kc[`kc:${login}`]?.value;
    let text = "Not checked yet", status = "";
    if (v?.failed) { text = "Couldn't check"; status = "warn"; }
    else if (v && !v.kickSlug) { text = "Not on Kick"; status = "warn"; }
    else if (v?.isLive) { text = "Live on Kick"; status = "ok"; }
    else if (v) { text = "Offline on Kick"; }
    return { login, name: names.get(login) || login, text, status };
  });
  return { summary: parts.join(" · "), items };
}
// ==== favorites-pure-end

async function renderFavorites() {
  const s = await chrome.storage.local.get(["favorites", "followsCache", "favCheck"]);
  const kc = await chrome.storage.local.get((s.favorites || []).map((l) => `kc:${l}`));
  const alarm = await chrome.alarms.get("kick-bridge-favs");
  const { summary, items } = buildFavorites(s, kc, alarm?.scheduledTime, Date.now());

  $("favSummary").textContent = summary;
  const box = $("favList");
  box.textContent = "";
  for (const it of items) {
    const row = document.createElement("div");
    row.className = "conn";
    const left = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = `★ ${it.name}`;
    const state = document.createElement("small");
    const dot = document.createElement("span");
    dot.className = `dot ${it.status}`;
    state.append(dot, document.createTextNode(it.text));
    left.append(name, document.createElement("br"), state);

    const remove = document.createElement("button");
    remove.className = "secondary";
    remove.style.marginTop = "0";
    remove.textContent = "Remove";
    remove.addEventListener("click", async () => {
      const { favorites = [] } = await chrome.storage.local.get("favorites");
      await chrome.storage.local.set({ favorites: favorites.filter((l) => l !== it.login) });
    });
    row.append(left, remove);
    box.append(row);
  }
}

chrome.storage.local.get("notifyFavorites").then((s) => ($("notifyFavorites").checked = Boolean(s.notifyFavorites)));
$("notifyFavorites").addEventListener("change", (e) => chrome.storage.local.set({ notifyFavorites: e.target.checked }));

async function favAction(type, doing, done) {
  $("favMsg").textContent = doing;
  const res = await chrome.runtime.sendMessage({ type });
  $("favMsg").textContent = res?.error ? `Failed: ${res.error}` : done(res);
  setTimeout(() => ($("favMsg").textContent = ""), 5000);
  renderFavorites();
}
$("testNotify").addEventListener("click", () => favAction("TEST_NOTIFICATION", "Sending…", () => "Sent. Check your system notifications."));
$("checkFavs").addEventListener("click", () =>
  favAction("CHECK_FAVORITES", "Checking…", (r) =>
    r.skipped ? "A check is already running." : r.checked === 0 ? "No favorites yet." : `Checked ${r.checked}.`));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.favorites || changes.favCheck || changes.followsCache)) renderFavorites();
});
setInterval(renderFavorites, 30000);
renderFavorites();
