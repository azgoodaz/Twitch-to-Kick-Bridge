const $ = (id) => document.getElementById(id);

// How long cached data is trusted before it is quietly refreshed in the background.
const FOLLOWS_TTL = 60 * 60 * 1000;          // your follow list: 1 hour
const MISS_TTL = 7 * 24 * 60 * 60 * 1000;    // "not on Kick": 1 week

const MAX_FAVS = 10;
let overrides = {};     // your corrections: login -> "yes" (it's them) | "not" (not them); storage.kickOverrides
let overrideTimes = {}; // when you clicked "It's them" (login -> ms); storage.kickOverrideTimes
const RECENT_CONFIRM_MS = 5 * 60 * 1000; // "Undo" and "you confirmed this match" show for this long, then retire
let favs = new Set();   // favorite streamers (Twitch logins); saved in storage.favorites
let flashUntil = 0;     // a short message in the status line is showing until this time
let spinUntil = 0;      // the refresh icon spins until this time after a click, until the worker confirms it started
let searchFocused = false;
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

function effectiveTier(v, override) {
  if (override === "not") return "none"; // you said it isn't them
  if (override === "yes") return "confirmed";
  return v?.tier || "unconfirmed";
}

function fmtAgo(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function fmtCountdown(ms) {
  const s = Math.ceil(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

// ---------- header / controls ----------

$("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

$("disconnect").addEventListener("click", async () => {
  runId++;
  await chrome.runtime.sendMessage({ type: "TWITCH_LOGOUT" });
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

function applyShowAll(on) {
  $("showAll").checked = on;
  $("rows").classList.toggle("showAll", on);
  updateEmpty();
}
$("showAll").addEventListener("change", (e) => applyShowAll(e.target.checked));

// "Live only" is purely a display filter: toggling it never re-checks anything.
function applyLiveOnly(on) {
  $("liveOnly").checked = on;
  $("rows").classList.toggle("liveOnly", on);
  applySearch(); // keeps the "no match" message accurate
}
$("liveOnly").addEventListener("change", (e) => {
  applyLiveOnly(e.target.checked);
  chrome.storage.local.set({ liveOnly: e.target.checked });
});
chrome.storage.local.get("liveOnly").then((s) => applyLiveOnly(Boolean(s.liveOnly)));

// ↻ is the ONLY thing that re-checks streamers after the first load:
//   click       = refresh live status + check anything unchecked/failed
//   Shift+click = re-check every follow from scratch (e.g. someone just joined Kick)
let fetchingFollows = false; // true while we ask Twitch for your current follow list

// How many streamers Twitch says you follow right now. One tiny request (first=1) instead of the whole list.
async function probeFollowCount(clientId, user) {
  const url = new URL("https://api.twitch.tv/helix/channels/followed");
  url.searchParams.set("user_id", user.userId);
  url.searchParams.set("first", "1");
  const r = await fetch(url, { headers: { Authorization: `Bearer ${user.token}`, "Client-Id": clientId } });
  if (!r.ok) throw Object.assign(new Error(`Twitch API error ${r.status}`), { code: r.status });
  const j = await r.json();
  return typeof j.total === "number" ? j.total : null;
}

// The follow count saved with the list (Twitch's own number), or null when it can't be trusted:
// no saved list (cleared or never loaded), a different Twitch account, or saved before counts were kept.
async function getStoredFollowCount(userId) {
  const s = await chrome.storage.local.get(["followsCache", "followCount"]);
  if (!s.followsCache || s.followsCache.userId !== userId || typeof s.followCount !== "number") return null;
  return s.followCount;
}

// The two-way refresh:
//   same count as the saved one  -> { fetched: false }: keep the list, carry on with the normal refresh
//   count went up or down        -> fetch the whole list, save it and the new count: { fetched: true, list, before, after }
// force (Shift+click) always fetches, since one streamer followed and another unfollowed leaves the count unchanged.
// Throws with .code = 401 if the Twitch login expired.
async function refreshFollowsNow({ force = false } = {}) {
  const s = await chrome.storage.local.get(["twitchId", "twitchUser"]);
  const user = s.twitchUser;
  if (!s.twitchId || !user || user.exp < Date.now() + 60_000) {
    throw Object.assign(new Error("Your Twitch session expired."), { code: 401 });
  }
  const before = await getStoredFollowCount(user.userId);
  if (!force && before !== null) {
    const total = await probeFollowCount(s.twitchId, user);
    if (total !== null && total === before) return { fetched: false, before, after: before };
  }
  const list = await fetchFollows(s.twitchId, user, false); // also saves the new count
  const after = (await chrome.storage.local.get("followCount")).followCount ?? list.length;
  return { fetched: true, list, before, after };
}

async function startManualCheck(everyone) {
  if (!view.ready) return; // nothing loaded yet
  if (scanRunning() || fetchingFollows) return flash("A check is already running."); // one at a time
  spinUntil = Date.now() + 2500;            // start spinning at once...
  updateSpinner();
  setTimeout(updateSpinner, 2600);          // ...and stop again if nothing needed checking

  // 1) Did you follow (or unfollow) anyone since the list was saved? Ask Twitch, so new follows get checked too.
  let list = currentList;
  fetchingFollows = true;
  updateSpinner();
  try {
    const r = await refreshFollowsNow({ force: everyone });
    if (r.fetched) {
      // The follow count changed (or this is a full re-check): the feed is rebuilt from Twitch's current
      // list, so unfollowed streamers drop out and new follows appear (and get checked).
      const known = new Set(currentList.map((f) => f.login));
      const now = new Set(r.list.map((f) => f.login));
      const added = r.list.filter((f) => !known.has(f.login)).length;
      const removed = currentList.filter((f) => !now.has(f.login)).length;
      list = r.list;
      const notes = [];
      if (added) notes.push(`${added} new follow${added === 1 ? "" : "s"} found, checking ${added === 1 ? "it" : "them"} now`);
      if (removed) notes.push(`${removed} unfollowed`);
      const head = r.before !== null && r.after !== r.before ? `Follows ${r.before} → ${r.after}: ` : "";
      if (notes.length) flash(`${head}${notes.join(" · ")}.`);
    }
    // else: same count as the stored one. Nothing to rebuild; carry on with the normal refresh of the current feed.
  } catch (e) {
    if (e.code === 401) {
      fetchingFollows = false;
      updateSpinner();
      return onFollowsError(e); // shows the Connect screen
    }
    chrome.runtime.sendMessage({ type: "LOG_ERROR", source: "Twitch follows", message: e.message }).catch(() => {});
    flash("Couldn't refresh your follow list. Checking the saved one.");
  } finally {
    fetchingFollows = false;
    updateSpinner();
  }

  // 2) Check whatever needs it (new follows are unchecked, so they're included).
  renderFromCache(list, everyone ? "all" : "manual");
}
$("refresh").addEventListener("click", (e) => startManualCheck(e.shiftKey));

// The refresh icon spins while streamers are being checked (from this click, from the
// first load, or from a check that was already running when you opened the popup).
// It freezes while the worker waits out a Kick rate limit.
// How old the oldest live status on screen is, e.g. "2h ago" (null before anything is checked).
function lastUpdatedAgo() {
  const { oldest } = matchCounts();
  return oldest === Infinity ? null : fmtAgo(Date.now() - oldest);
}

function updateSpinner() {
  const b = $("refresh");
  const running = scanRunning();
  const paused = running && (scan?.pausedUntil || 0) > Date.now();
  const spinning = running || Date.now() < spinUntil || fetchingFollows;
  b.classList.toggle("spinning", spinning);
  b.classList.toggle("paused", paused);
  b.setAttribute("aria-busy", String(spinning));
  const ago = spinning ? null : lastUpdatedAgo();
  const progress = running && scan?.total ? ` ${scan.done} of ${scan.total}` : "";
  const eta = running && scan?.etaMs > 60000 ? ` · about ${Math.round(scan.etaMs / 60000)} min left` : "";
  b.title = paused ? "Kick asked us to slow down: resuming shortly"
    : fetchingFollows ? "Looking for new follows…"
    : spinning ? `Checking your follows…${progress}${eta}`
    : `${ago ? `Updated ${ago} · ` : ""}Refresh live status (Shift+click: recheck everyone)`;
}

// ---------- search ----------
// Filters by display name or login as you type. While a search is active,
// streamers who aren't on Kick are shown too (dimmed), so you can also use it to
// answer "is X on Kick?". Combines with the "live only" filter.
function applySearch() {
  const q = $("search").value.trim().toLowerCase();
  const ul = $("rows");
  ul.classList.toggle("searching", q !== "");
  for (const li of ul.children) {
    const hit = !q || li.dataset.name.includes(q) || (li.dataset.login || "").includes(q);
    li.classList.toggle("nomatch", !hit);
  }
  updateEmpty();
}

// ---------- empty states ----------
// What to say when the list shows nothing, so a blank popup is never a mystery.
// emptyState is pure (numbers in, message out); updateEmpty gathers the numbers.
function emptyState({ follows, query, liveOnly, showAll, onKick, unchecked, running, done, total, checkedAgo }) {
  if (!follows) return { text: "You don't follow anyone on Twitch yet." };
  if (running) return { text: `Checking your follows… ${done}/${total}` };
  if (query) {
    return liveOnly
      ? { text: `No live streamer matches “${query}”.`, action: { id: "includeOffline", label: "Include offline" } }
      : { text: `No followed streamer matches “${query}”.` };
  }
  if (unchecked === follows) {
    return { text: "Nothing has been checked yet.", hint: "Press ↻ to check your follows.", action: { id: "check", label: "Check now" } };
  }
  if (!onKick) {
    return {
      text: "None of the streamers you follow are on Kick yet.",
      hint: "Press ↻ to look again.",
      action: liveOnly || !showAll ? { id: "showEveryone", label: "Show everyone" } : null,
    };
  }
  if (liveOnly) {
    return {
      text: "Nobody is live on Kick right now.",
      hint: checkedAgo ? `Last checked ${checkedAgo}. Press ↻ to refresh.` : "Press ↻ to refresh.",
      action: { id: "includeOffline", label: "Show everyone on Kick" },
    };
  }
  return null;
}

let emptyActionId = null;

function updateEmpty() {
  if (!view.ready) return; // nothing loaded yet: the status line says "Loading…"
  const liveOnly = $("liveOnly").checked;
  const showAll = $("showAll").checked;
  const query = $("search").value.trim();

  // the same rules the stylesheet uses to hide rows
  let visible = 0;
  for (const li of $("rows").children) {
    const c = li.classList;
    if (c.contains("nomatch")) continue;
    if (c.contains("nokick") && !showAll && !query) continue;
    if (liveOnly && !c.contains("live")) continue;
    visible++;
  }

  let msg = null;
  if (!visible) {
    const c = matchCounts();
    msg = emptyState({
      follows: view.list.length, query, liveOnly, showAll,
      onKick: c.found, unchecked: c.unchecked,
      running: scanRunning(), done: scan?.done, total: scan?.total,
      checkedAgo: c.oldest === Infinity ? null : fmtAgo(Date.now() - c.oldest),
    });
  }
  $("noMatch").hidden = !msg;
  emptyActionId = msg?.action ? msg.action.id : null;
  if (!msg) return;
  $("emptyText").textContent = msg.text;
  $("emptyHint").textContent = msg.hint || "";
  $("emptyHint").hidden = !msg.hint;
  $("emptyAction").hidden = !msg.action;
  if (msg.action) $("emptyAction").textContent = msg.action.label;
}

$("emptyAction").addEventListener("click", () => {
  if (emptyActionId === "check") return startManualCheck(false);
  if (emptyActionId === "showEveryone") applyShowAll(true);
  if ($("liveOnly").checked) {
    applyLiveOnly(false);
    chrome.storage.local.set({ liveOnly: false });
  }
});

$("search").addEventListener("input", applySearch);
$("search").addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("search").value) {
    e.preventDefault();
    $("search").value = "";
    applySearch();
  }
});

// ---------- Twitch data ----------

async function fetchFollows(clientId, user, quiet) {
  const headers = { Authorization: `Bearer ${user.token}`, "Client-Id": clientId };
  const fail = (r) => Object.assign(new Error(`Twitch API error ${r.status}`), { code: r.status });

  // 1) page through followed channels
  const ids = [];
  let after = null;
  let total = null; // Twitch's own count of who you follow (can be higher than the list: deleted/banned accounts have no profile)
  do {
    const url = new URL("https://api.twitch.tv/helix/channels/followed");
    url.searchParams.set("user_id", user.userId);
    url.searchParams.set("first", "100");
    if (after) url.searchParams.set("after", after);
    const r = await fetch(url, { headers });
    if (!r.ok) throw fail(r);
    const j = await r.json();
    if (total === null && typeof j.total === "number") total = j.total;
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
      list.push({ login: u.login, name: u.display_name, bio: u.description || "", img: u.profile_image_url, type: u.broadcaster_type || "" });
    }
  }
  list.sort((a, b) => a.name.localeCompare(b.name));

  // The count is saved WITH the list, so the two can never disagree about what was last fetched.
  await chrome.storage.local.set({
    followsCache: { at: Date.now(), userId: user.userId, list },
    followCount: typeof total === "number" ? total : ids.length,
  });
  return list;
}

const loginSet = (list) => list.map((f) => f.login).sort().join(",");

// ---------- rows ----------

function makeRow(f) {
  const li = document.createElement("li");
  li.className = "row nokick";
  li.dataset.name = f.name.toLowerCase();
  li.dataset.login = f.login;

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
  // "Not them" / "It's them" / "Undo": your correction beats the automatic guess.
  const acts = document.createElement("span");
  acts.className = "acts";
  acts.hidden = true;
  const mkAct = (label, verdict, title) => {
    const b = document.createElement("button");
    b.className = "act";
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", () => setOverride(f.login, verdict));
    return b;
  };
  const notThem = mkAct("Not them", "not", "A different person: hide this match");
  const itsThem = mkAct("It's them", "yes", "This is the same person: confirm the match");
  const undo = mkAct("Undo", null, "Go back to the automatic result");
  acts.append(notThem, itsThem, undo);
  mid.append(name, sub, acts);

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

  const star = document.createElement("button");
  star.className = "star";
  star.hidden = true; // only streamers who are on Kick can be favorites
  star.addEventListener("click", () => toggleFavorite(f.login));

  li.append(star, img, mid, a);
  li._sub = sub;
  li._a = a;
  li._star = star;
  li._acts = { box: acts, not: notThem, yes: itsThem, undo };
  refreshRowFav(li);
  return li;
}

// Star state of one row (call after anything that could change it).
function refreshRowFav(li) {
  const on = favs.has(li.dataset.login);
  li.classList.toggle("fav", on);
  li.dataset.fav = on ? "1" : "0";
  li._star.textContent = on ? "★" : "☆";
  li._star.classList.toggle("on", on);
  li._star.title = on ? "Remove from favorites" : "Add to favorites";
  // no star on streamers who aren't on Kick, or on a possible impersonator (unless already starred, so it can be removed)
  li._star.hidden = li.classList.contains("nokick") || (li.dataset.suspect === "1" && !on);
}

function flash(msg) {
  flashUntil = Date.now() + 3000;
  setStatus(msg);
}

async function toggleFavorite(login) {
  if (favs.has(login)) {
    favs.delete(login);
  } else {
    if (favs.size >= MAX_FAVS) return flash(`You can have up to ${MAX_FAVS} favorites. Remove one first.`);
    favs.add(login);
  }
  for (const li of view.rows.values()) refreshRowFav(li);
  sortRows($("rows"));
  await chrome.storage.local.set({ favorites: [...favs] });
}

// Safe to call repeatedly: updates a row in place from a lookup result.
const isRecentConfirm = (login) => Date.now() - (overrideTimes[login] || 0) < RECENT_CONFIRM_MS;

function setOverride(login, verdict) {
  chrome.runtime.sendMessage({ type: "SET_OVERRIDE", login, verdict }).catch(() => {});
}

function subText(res, tier, ov, recent) {
  if (tier === "suspected") return ["⚠ Possible impersonator", ...(res.reasons || []).slice(0, 2)].join(" · ");
  const parts = [res.isLive ? "Live on Kick" : "Offline on Kick"];
  if (res.kickVerified) parts.push("✓ Kick-verified");
  if (ov === "yes") {
    // You vouched for it: no confidence label at all, just the clean status line.
    // (A brief "you confirmed this match" shows right after the click, alongside Undo.)
    if (recent) parts.push("you confirmed this match");
  } else if (tier === "unconfirmed") {
    // Only a caution gets a label: no label means confirmed or likely (hover the status for the reasons).
    parts.push("unconfirmed (same username)");
  }
  return parts.join(" · ");
}

// Safe to call repeatedly: updates a row in place from a lookup result and your corrections.
function applyResult(li, res) {
  const ov = overrides[li.dataset.login];
  const recent = ov === "yes" && isRecentConfirm(li.dataset.login); // just confirmed: still shows Undo
  li.dataset.recent = recent ? "1" : "0";
  const matched = Boolean(res?.kickSlug);
  const tier = matched ? effectiveTier(res, ov) : "none"; // "none" also when you said "not them"
  const show = matched && tier !== "none";

  li.classList.toggle("suspect", show && tier === "suspected");
  li.dataset.suspect = show && tier === "suspected" ? "1" : "0";

  // correction buttons: only where a human judgement can help (or to undo one)
  const a = li._acts;
  const canJudge = matched && !ov && (tier === "unconfirmed" || tier === "suspected");
  a.not.hidden = a.yes.hidden = !canJudge;
  a.undo.hidden = !(matched && (ov === "not" || recent)); // a settled confirmation has no Undo here (Settings still has one)
  a.undo.textContent = ov === "not" ? "Restore" : "Undo";
  a.box.hidden = a.not.hidden && a.yes.hidden && a.undo.hidden;

  if (show) {
    li.classList.remove("nokick");
    const live = Boolean(res.isLive) && tier !== "suspected"; // a lookalike's stream isn't "live" for you
    li.classList.toggle("live", live);
    li.dataset.live = live ? "1" : "0";
    li.dataset.trust = String({ confirmed: 3, likely: 2, unconfirmed: 1, suspected: 0 }[tier]);
    li._sub.textContent = subText(res, tier, ov, recent);
    li._sub.title = (res.reasons || []).join(" · ");
    li._a.href = `https://kick.com/${encodeURIComponent(res.kickSlug)}`;
    li._a.hidden = false;
  } else {
    li.classList.add("nokick");
    li.classList.remove("live");
    li.dataset.live = "0";
    li.dataset.trust = "0";
    li._a.hidden = true;
    li._sub.title = "";
    li._sub.textContent = matched ? "You marked this as not them" : res?.failed ? "Couldn't check — will retry later" : "Not on Kick";
  }
  refreshRowFav(li);
}

function sortRows(ul) {
  const key = (li) => [
    li.dataset.fav === "1" ? 0 : 1, // favorites always on top
    li.classList.contains("nokick") ? 1 : 0,
    li.dataset.suspect === "1" ? 1 : 0, // possible impersonators below real matches
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
  if (!v.kickUserId || !v.profileTriedAt) return "full"; // saved by an older version: needs its match assessed
  return "live";
}

let view = { list: [], rows: new Map(), results: new Map() };
let scan = null; // storage.scanState, kept current by the listener below
let uiTimer = null;

const scanRunning = () => Boolean(scan?.running) && Date.now() - (scan.heartbeat || 0) < 20000;

// What the saved results say about your follows (lookalikes and "not them" excluded from "on Kick").
function matchCounts() {
  const { list, results } = view;
  let found = 0, liveNow = 0, unchecked = 0, failed = 0, lookalikes = 0, reverify = 0, oldest = Infinity;
  for (const f of list) {
    const e = results.get(f.login);
    if (!e) { unchecked++; continue; }
    if (e.value?.failed) { failed++; continue; }
    if (!e.value?.kickSlug) continue;
    if (!e.value.profileTriedAt) reverify++;
    const t = effectiveTier(e.value, overrides[f.login]);
    if (t === "none") continue;
    if (t === "suspected") { lookalikes++; continue; }
    found++;
    if (e.value.isLive) liveNow++;
    oldest = Math.min(oldest, e.at);
  }
  return { found, liveNow, unchecked, failed, lookalikes, reverify, oldest };
}

function updateStatus() {
  if (Date.now() < flashUntil) return; // let a short message be read
  const { list } = view;
  if (!list.length) return;
  // Kept short on purpose: the count of possible impersonators lives in Settings > Matches,
  // and "updated ... ago" is in the refresh button's tooltip.
  const { found, liveNow, unchecked, failed, reverify } = matchCounts();
  const parts = [`${list.length} follows`, `${found} on Kick`, `${liveNow} live`];
  if (scanRunning()) {
    const wait = (scan.pausedUntil || 0) - Date.now();
    if (wait > 0) {
      parts.push(`rate limited — resuming in ${fmtCountdown(wait)}`);
    } else {
      let t = `checking ${scan.done}/${scan.total}`;
      if (scan.etaMs > 60000) t += ` · ~${Math.round(scan.etaMs / 60000)} min left`;
      parts.push(t + "…");
    }
  } else {
    if (scan?.limited) parts.push("gave up after repeated rate limits");
    if (scan?.liveFailed) parts.push("live update failed");
    if (unchecked + failed) parts.push(`${unchecked + failed} not checked — press ↻`);
    else if (reverify) parts.push(`${reverify} match${reverify > 1 ? "es" : ""} to verify — press ↻`);
  }
  setStatus(parts.join(" · "));
}

function scheduleUI() {
  clearTimeout(uiTimer);
  uiTimer = setTimeout(() => {
    if (!scanRunning()) sortRows($("rows")); // don't shuffle rows under your cursor mid-check
    updateStatus();
    updateEmpty();
  }, 250);
}

// Results arrive via storage (written by the service worker as each lands).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  let touched = false;
  for (const [key, ch] of Object.entries(changes)) {
    if (key === "favorites") {
      favs = new Set(ch.newValue || []);
      for (const li of view.rows.values()) refreshRowFav(li);
      sortRows($("rows"));
    } else if (key === "kickOverrides") {
      overrides = ch.newValue || {};
      if (changes.kickOverrideTimes) overrideTimes = changes.kickOverrideTimes.newValue || {};
      for (const [login, li] of view.rows) {
        const r = view.results.get(login)?.value;
        if (r) applyResult(li, r);
      }
      sortRows($("rows"));
      touched = true;
    } else if (key === "scanState") {
      scan = ch.newValue || null;
      updateSpinner();
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
setInterval(() => { updateStatus(); updateEmpty(); updateSpinner(); }, 1000); // countdowns, and notices a worker that died mid-check
// Retire the Undo link / "you confirmed this match" text once the window has passed.
setInterval(() => {
  for (const [login, li] of view.rows) {
    if (li.dataset.recent === "1" && !isRecentConfirm(login)) {
      const r = view.results.get(login)?.value;
      if (r) applyResult(li, r);
    }
  }
}, 10000);

async function renderFromCache(list, mode = "view") {
  const myRun = ++runId;
  currentList = list;
  showOnly("list");
  if (!searchFocused) {
    searchFocused = true;
    $("search").focus(); // start typing right away
  }

  // One batched read of everything saved: no per-row waiting.
  const stored = await chrome.storage.local.get([...list.map((f) => `kc:${f.login}`), "scanState", "favorites", "kickOverrides", "kickOverrideTimes"]);
  if (myRun !== runId) return;
  scan = stored.scanState || null;
  updateSpinner(); // opened while a check is already running? the icon spins
  favs = new Set(stored.favorites || []);
  overrides = stored.kickOverrides || {};
  overrideTimes = stored.kickOverrideTimes || {};

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
  view = { list, rows, results, ready: true };
  sortRows(ul); // same tick as the inserts, so no visible reshuffle
  applySearch(); // keep any text typed in the search box applied after a re-render
  updateStatus();

  // Streamers whose Twitch bio mentions kick.com are certain hits: check them first.
  const mentionsKick = (x) => (/kick\.com/i.test(x.bio) ? 0 : 1);
  full.sort((a, b) => mentionsKick(a) - mentionsKick(b));

  if (full.length || live.length) {
    const res = await chrome.runtime.sendMessage({ type: "START_SCAN", full, live });
    if (myRun === runId && res?.error) setStatus(`Couldn't start check: ${res.error}`);
  } else if (mode === "manual" || mode === "all") {
    flash("Everything is already up to date."); // you pressed refresh and there was nothing to do
  }
}

// ---------- entry point ----------

async function onFollowsError(e) {
  chrome.runtime.sendMessage({ type: "LOG_ERROR", source: "Twitch follows", message: e.message }).catch(() => {});
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
