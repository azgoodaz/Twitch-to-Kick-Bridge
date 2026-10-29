const $ = (id) => document.getElementById(id);

// How long cached data is trusted before it is quietly refreshed in the background.
const FOLLOWS_TTL = 60 * 60 * 1000;          // your follow list: 1 hour
const MISS_TTL = 7 * 24 * 60 * 60 * 1000;    // "not on Kick": 1 week

let runId = 0;          // bumps on every render so older background checks stop themselves
let currentList = [];   // the follow list currently on screen

const setStatus = (t) => ($("status").textContent = t);

function showOnly(panel) {
  for (const id of ["message", "connect", "list"]) $(id).hidden = id !== panel;
  $("disconnect").hidden = panel !== "list";
}

function showMessage(text) {
  $("message").textContent = text;
  showOnly("message");
}

function showConnect(note) {
  if (note) $("connectMsg").textContent = note;
  showOnly("connect");
}

function fmtAgo(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

// ---------- header / controls ----------

$("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

$("disconnect").addEventListener("click", async () => {
  runId++;
  await chrome.storage.local.remove(["twitchUser", "followsCache"]);
  showConnect("Disconnected. Connect again to reload your follows.");
});

// The popup closes if the login window steals focus, so the login runs in the
// service worker. If this popup survives, carry on; otherwise the next time you
// open it you'll already be connected.
$("connectBtn").addEventListener("click", async () => {
  $("connectBtn").disabled = true;
  const res = await chrome.runtime.sendMessage({ type: "TWITCH_LOGIN" });
  $("connectBtn").disabled = false;
  if (res?.error) return showConnect(`Login failed: ${res.error}`);
  main();
});

$("showAll").addEventListener("change", (e) => {
  $("rows").classList.toggle("showAll", e.target.checked);
});

// "Live only" is purely a display filter: toggling it never re-checks anything.
function applyLiveOnly(on) {
  $("liveOnly").checked = on;
  $("rows").classList.toggle("liveOnly", on);
}
$("liveOnly").addEventListener("change", (e) => {
  applyLiveOnly(e.target.checked);
  chrome.storage.local.set({ liveOnly: e.target.checked });
});
chrome.storage.local.get("liveOnly").then((s) => applyLiveOnly(Boolean(s.liveOnly)));

// ↻ is the ONLY thing that re-checks streamers after the first load:
//   click       = refresh live status + check anything unchecked/failed
//   Shift+click = re-check every follow from scratch (e.g. someone just joined Kick)
$("refresh").addEventListener("click", (e) => {
  if (currentList.length) renderFromCache(currentList, e.shiftKey ? "all" : "manual");
});

// ---------- Twitch data ----------

async function fetchFollows(clientId, user, quiet) {
  const headers = { Authorization: `Bearer ${user.token}`, "Client-Id": clientId };
  const fail = (r) => Object.assign(new Error(`Twitch API error ${r.status}`), { code: r.status });

  // 1) page through followed channels
  const ids = [];
  let after = null;
  do {
    const url = new URL("https://api.twitch.tv/helix/channels/followed");
    url.searchParams.set("user_id", user.userId);
    url.searchParams.set("first", "100");
    if (after) url.searchParams.set("after", after);
    const r = await fetch(url, { headers });
    if (!r.ok) throw fail(r);
    const j = await r.json();
    for (const d of j.data) ids.push(d.broadcaster_id);
    after = j.pagination?.cursor || null;
    if (!quiet) setStatus(`Loading follows… ${ids.length}`);
  } while (after);

  // 2) profile details (login, name, bio, avatar) in batches of 100
  const list = [];
  for (let i = 0; i < ids.length; i += 100) {
    const url = new URL("https://api.twitch.tv/helix/users");
    for (const id of ids.slice(i, i + 100)) url.searchParams.append("id", id);
    const r = await fetch(url, { headers });
    if (!r.ok) throw fail(r);
    for (const u of (await r.json()).data) {
      list.push({ login: u.login, name: u.display_name, bio: u.description || "", img: u.profile_image_url });
    }
  }
  list.sort((a, b) => a.name.localeCompare(b.name));

  await chrome.storage.local.set({ followsCache: { at: Date.now(), userId: user.userId, list } });
  return list;
}

const loginSet = (list) => list.map((f) => f.login).sort().join(",");

// ---------- rows ----------

function makeRow(f) {
  const li = document.createElement("li");
  li.className = "row nokick";
  li.dataset.name = f.name.toLowerCase();

  const img = new Image();
  img.src = f.img;
  img.width = img.height = 32;
  img.alt = "";

  const mid = document.createElement("div");
  mid.className = "mid";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = f.name;
  const sub = document.createElement("span");
  sub.className = "sub";
  sub.textContent = "Checking…";
  mid.append(name, sub);

  const a = document.createElement("a");
  a.className = "go";
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = "Kick ↗";
  a.hidden = true;
  // A normal link would focus the new tab and close the popup. Opening it as a
  // background tab keeps the popup open. (Ctrl/Cmd/middle-click behave as usual.)
  a.addEventListener("click", (e) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    chrome.tabs.create({ url: a.href, active: false });
  });

  li.append(img, mid, a);
  li._sub = sub;
  li._a = a;
  return li;
}

// Safe to call repeatedly: updates a row in place from a lookup result.
function applyResult(li, res) {
  if (res?.kickSlug) {
    li.classList.remove("nokick");
    li.classList.toggle("live", Boolean(res.isLive));
    li.dataset.live = res.isLive ? "1" : "0";
    li.dataset.trust = res.linked ? "2" : res.kickVerified ? "1" : "0";

    const parts = [res.isLive ? "Live on Kick" : "Offline on Kick"];
    if (res.kickVerified) parts.push("✓ Kick-verified");
    parts.push(res.linked ? "linked in bio" : "same username");
    li._sub.textContent = parts.join(" · ");

    li._a.href = `https://kick.com/${encodeURIComponent(res.kickSlug)}`;
    li._a.hidden = false;
  } else {
    li.classList.add("nokick");
    li.classList.remove("live");
    li.dataset.live = "0";
    li.dataset.trust = "0";
    li._a.hidden = true;
    li._sub.textContent = res?.failed ? "Couldn't check — will retry later" : "Not on Kick";
  }
}

function sortRows(ul) {
  const key = (li) => [
    li.classList.contains("nokick") ? 1 : 0,
    -Number(li.dataset.live || 0),
    -Number(li.dataset.trust || 0),
    li.dataset.name,
  ];
  [...ul.children]
    .sort((a, b) => {
      const ka = key(a), kb = key(b);
      for (let i = 0; i < ka.length; i++) {
        if (ka[i] < kb[i]) return -1;
        if (ka[i] > kb[i]) return 1;
      }
      return 0;
    })
    .forEach((li) => ul.append(li));
}

// ---------- render ----------
// Opening the popup NEVER re-checks anything: it just draws what is saved.
// Checks start in exactly two cases: the very first load (nothing saved yet)
// and the ↻ button. They run in the background service worker, so closing the
// popup can't interrupt them; this page just watches storage and updates.
//
// planFor says what a saved entry needs for a given mode:
//   "view"    opening the popup           -> nothing, ever
//   "initial" first load                  -> full lookup of never-checked channels
//   "manual"  ↻                           -> full lookup of never-checked, failed,
//                                            old-format or week-old "not on Kick"
//                                            entries; live status for the rest
//   "all"     Shift+↻                     -> full lookup of everyone
// "full" = complete one-channel lookup, "live" = batched live-status refresh.

function planFor(entry, mode, now) {
  if (mode === "view") return null;
  if (mode === "all" || !entry) return "full";
  if (mode === "initial") return null;
  const v = entry.value || {};
  if (v.failed) return "full";
  if (!v.kickSlug) return now - entry.at > MISS_TTL ? "full" : null;
  if (!v.kickUserId) return "full";
  return "live";
}

let view = { list: [], rows: new Map(), results: new Map() };
let scan = null; // storage.scanState, kept current by the listener below
let uiTimer = null;

const scanRunning = () => Boolean(scan?.running) && Date.now() - (scan.heartbeat || 0) < 20000;

function updateStatus() {
  const { list, results } = view;
  if (!list.length) return;
  let found = 0, liveNow = 0, unchecked = 0, failed = 0, oldest = Infinity;
  for (const f of list) {
    const e = results.get(f.login);
    if (!e) { unchecked++; continue; }
    if (e.value?.failed) { failed++; continue; }
    if (!e.value?.kickSlug) continue;
    found++;
    if (e.value.isLive) liveNow++;
    oldest = Math.min(oldest, e.at);
  }
  const parts = [`${list.length} follows`, `${found} on Kick`, `${liveNow} live`];
  if (scanRunning()) {
    parts.push(`checking ${scan.done}/${scan.total}…`);
  } else {
    if (scan?.limited) parts.push("Kick rate-limited the last check");
    if (unchecked + failed) parts.push(`${unchecked + failed} not checked — press ↻`);
    else if (found) parts.push(`updated ${fmtAgo(Date.now() - oldest)}`);
  }
  setStatus(parts.join(" · "));
}

function scheduleUI() {
  clearTimeout(uiTimer);
  uiTimer = setTimeout(() => {
    if (!scanRunning()) sortRows($("rows")); // don't shuffle rows under your cursor mid-check
    updateStatus();
  }, 250);
}

// Results arrive via storage (written by the service worker as each lands).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  let touched = false;
  for (const [key, ch] of Object.entries(changes)) {
    if (key === "scanState") {
      scan = ch.newValue || null;
      touched = true;
    } else if (key.startsWith("kc:") && ch.newValue) {
      const login = key.slice(3);
      const li = view.rows.get(login);
      if (!li) continue;
      view.results.set(login, ch.newValue);
      applyResult(li, ch.newValue.value);
      touched = true;
    }
  }
  if (touched) scheduleUI();
});
setInterval(updateStatus, 5000); // notices a worker that died mid-check

async function renderFromCache(list, mode = "view") {
  const myRun = ++runId;
  currentList = list;
  showOnly("list");

  // One batched read of everything saved: no per-row waiting.
  const stored = await chrome.storage.local.get([...list.map((f) => `kc:${f.login}`), "scanState"]);
  if (myRun !== runId) return;
  scan = stored.scanState || null;

  const ul = $("rows");
  ul.textContent = "";
  const rows = new Map();
  const results = new Map(); // login -> { value, at }
  const full = [];
  const live = [];
  const now = Date.now();

  for (const f of list) {
    const li = makeRow(f);
    rows.set(f.login, li);
    ul.append(li);

    const entry = stored[`kc:${f.login}`];
    if (entry) {
      results.set(f.login, entry);
      applyResult(li, entry.value);
    } else {
      li._sub.textContent = "Not checked yet";
    }
    const p = planFor(entry, mode, now);
    if (p === "full") full.push({ login: f.login, bio: f.bio, force: Boolean(entry) });
    else if (p === "live") live.push({ login: f.login, userId: entry.value.kickUserId });
  }
  view = { list, rows, results };
  sortRows(ul); // same tick as the inserts, so no visible reshuffle
  updateStatus();

  if (full.length || live.length) {
    const res = await chrome.runtime.sendMessage({ type: "START_SCAN", full, live });
    if (myRun === runId && res?.error) setStatus(`Couldn't start check: ${res.error}`);
  }
}

// ---------- entry point ----------

async function onFollowsError(e) {
  if (e.code === 401) {
    runId++;
    await chrome.storage.local.remove("twitchUser"); // keep the follow cache for after reconnect
    return showConnect("Your Twitch session expired. Connect again.");
  }
  // Network hiccup: keep showing cached rows rather than wiping them.
  if (!currentList.length) showMessage(`Couldn't load follows: ${e.message}`);
}

async function main() {
  const s = await chrome.storage.local.get(["twitchId", "kickId", "kickSecret", "twitchUser", "followsCache"]);
  if (!s.twitchId || !s.kickId || !s.kickSecret) {
    return showMessage("Add your Twitch Client ID and Kick credentials in Settings first.");
  }

  const user = s.twitchUser;
  if (!user || user.exp < Date.now() + 60_000) return showConnect();

  const cached = s.followsCache?.userId === user.userId ? s.followsCache : null;

  if (cached) {
    // Instant: draw from cache, then refresh the follow list quietly if it's old.
    renderFromCache(cached.list, "view");
    if (Date.now() - cached.at < FOLLOWS_TTL) return;
    try {
      const fresh = await fetchFollows(s.twitchId, user, true);
      if (loginSet(fresh) !== loginSet(cached.list)) renderFromCache(fresh, "view");
    } catch (e) {
      onFollowsError(e);
    }
    return;
  }

  // First run: nothing cached yet.
  showOnly("list");
  setStatus("Loading your follows…");
  try {
    renderFromCache(await fetchFollows(s.twitchId, user, false), "initial");
  } catch (e) {
    onFollowsError(e);
  }
}

main();
