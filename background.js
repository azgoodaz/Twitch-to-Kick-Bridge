// Service worker: talks to the Twitch (Helix) and Kick (public) APIs.
// NOTE: credentials live in chrome.storage.local. That's fine for personal
// dev-mode testing, but for a published extension move them to a backend proxy.

const CACHE_TTL = 5 * 60 * 1000;
const cache = new Map(); // login -> { at, value }

const HANDLERS = {
  LOOKUP: (m) => lookup(m.login),               // content script (single channel)
  START_SCAN: (m) => startScan(m),               // popup: first load or the refresh button
  TWITCH_LOGIN: () => twitchLogin(),             // popup / settings: connect Twitch
  TWITCH_LOGOUT: () => twitchLogout(),           // settings / popup: log out of Twitch
  KICK_LOGIN: () => kickLogin(),                 // settings: connect Kick
  KICK_LOGOUT: () => kickLogout(),               // settings: log out of Kick
  CLEAR_CACHE: () => clearCache(),               // settings > Diagnostics
  CHECK_FAVORITES: () => checkFavorites(),       // settings > Favorites: "Check now"
  SET_OVERRIDE: (m) => setOverride(m.login, m.verdict), // "not them" / "it's them" / undo
  IMPORT_OVERRIDES: (m) => importOverrides(m.data),     // settings: restore corrections from an export file
  TEST_NOTIFICATION: () => testNotification(),   // settings > Favorites
  LOG_ERROR: (m) => recordError(m.source, m.message).then(() => ({ ok: true })), // popup -> diagnostics
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = HANDLERS[msg?.type];
  if (!handler) return;
  handler(msg)
    .then(sendResponse)
    .catch((err) => {
      console.warn("[Kick Bridge] handler failed:", err);
      if (isRateLimit(err)) noteRateLimit(err);
      else recordError(msg.type, err);
      sendResponse({ error: String(err.message || err) });
    });
  return true; // async response
});

async function getCreds() {
  return chrome.storage.local.get(["twitchId", "twitchSecret", "kickId", "kickSecret"]);
}

// ---------- tokens (client-credentials / app access tokens) ----------

async function cachedToken(key, fetchToken, force = false) {
  const stored = (await chrome.storage.local.get(key))[key];
  if (!force && stored && stored.exp > Date.now() + 60_000) return stored.token;
  const { token, expiresIn } = await fetchToken();
  await chrome.storage.local.set({ [key]: { token, exp: Date.now() + expiresIn * 1000 } });
  return token;
}

async function twitchToken(c, force) {
  return cachedToken("twitchToken", async () => {
    const url =
      "https://id.twitch.tv/oauth2/token" +
      `?client_id=${encodeURIComponent(c.twitchId)}` +
      `&client_secret=${encodeURIComponent(c.twitchSecret)}` +
      "&grant_type=client_credentials";
    const r = await fetch(url, { method: "POST" });
    if (!r.ok) throw new Error(`Twitch token error ${r.status}`);
    const j = await r.json();
    return { token: j.access_token, expiresIn: j.expires_in };
  }, force);
}

async function kickToken(c, force) {
  return cachedToken("kickToken", async () => {
    const r = await fetch("https://id.kick.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: c.kickId,
        client_secret: c.kickSecret,
      }),
    });
    if (!r.ok) throw new Error(`Kick token error ${r.status}`);
    const j = await r.json();
    return { token: j.access_token, expiresIn: j.expires_in };
  }, force);
}

// ---------- API calls (retry once with a fresh token on 401) ----------

async function twitchUser(login, c) {
  for (const force of [false, true]) {
    const token = await twitchToken(c, force);
    const r = await fetch(
      `https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`,
      { headers: { Authorization: `Bearer ${token}`, "Client-Id": c.twitchId } }
    );
    if (r.status === 401 && !force) continue;
    if (!r.ok) throw new Error(`Twitch API error ${r.status}`);
    return (await r.json()).data?.[0] ?? null;
  }
}

async function kickChannel(slug, c) {
  for (const force of [false, true]) {
    const token = await kickToken(c, force);
    const r = await fetch(
      `https://api.kick.com/public/v1/channels?slug=${encodeURIComponent(slug)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (r.status === 401 && !force) continue;
    if (r.status === 404 || r.status === 400) return null; // unknown slug
    if (r.status === 429) throw rateLimitError(r);
    if (!r.ok) throw new Error(`Kick API error ${r.status}`);
    return (await r.json()).data?.[0] ?? null;
  }
}

// ---------- Is this Kick account really them? ----------
// Kick channels are matched by username, so a different person (or an impersonator)
// can own the same name. Each match gets a confidence tier from several signals:
//   confirmed   the Twitch bio links to the Kick channel (only the real streamer controls
//               that), or Kick-verified + the same profile picture
//   likely      Kick-verified, or the same profile picture
//   suspected   different profile picture + not verified + a tiny Kick following
//               (or a Twitch partner with almost no Kick following): possible impersonator
//   unconfirmed same username and nothing else to go on
// A link in the *Kick* bio back to Twitch is NOT counted: anyone can write that.
// Matches you mark "not them" / "it's them" always win (storage.kickOverrides).

// dHash: compare each pixel of a 9x8 greyscale thumbnail with its right neighbour.
// Similar pictures give similar bit strings even after resizing or recompression.
function dhashFromGray(g) {
  let bits = "";
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += g[y * 9 + x] > g[y * 9 + x + 1] ? "1" : "0";
  return bits;
}
function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}
const AVATAR_SAME_MAX = 10;        // of 64 bits: practically the same picture
const AVATAR_DIFFERENT_MIN = 24;   // unrelated pictures land around 32; in between = inconclusive

async function imageHash(url) {
  try {
    if (!url || typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") return null;
    const r = await fetch(url);
    if (!r.ok) return null;
    const bmp = await createImageBitmap(await r.blob());
    const mid = new OffscreenCanvas(72, 64);                    // two steps = a cleaner downscale
    const mctx = mid.getContext("2d");
    mctx.fillStyle = "#fff";                                    // transparent logos -> white
    mctx.fillRect(0, 0, 72, 64);
    mctx.drawImage(bmp, 0, 0, 72, 64);
    if (bmp.close) bmp.close();
    const small = new OffscreenCanvas(9, 8);
    const sctx = small.getContext("2d", { willReadFrequently: true });
    sctx.imageSmoothingQuality = "high";
    sctx.drawImage(mid, 0, 0, 9, 8);
    const px = sctx.getImageData(0, 0, 9, 8).data;
    const gray = [];
    for (let i = 0; i < 72; i++) gray.push(0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]);
    return dhashFromGray(gray);
  } catch (e) {
    return null; // unknown, never a guess
  }
}

function assessMatch({ twLinksKick, kickLinksTwitch, verified, followers, avatarDist, twType }) {
  const avatar =
    typeof avatarDist !== "number" ? "unknown"
      : avatarDist <= AVATAR_SAME_MAX ? "same"
      : avatarDist >= AVATAR_DIFFERENT_MIN ? "different"
      : "unknown";
  const partner = twType === "partner";
  const known = typeof followers === "number";
  const lowKick = known && followers < 100;
  const partnerMismatch = partner && known && followers < 500;

  let tier;
  if (twLinksKick || (verified === true && avatar === "same")) tier = "confirmed";
  else if (verified === true || avatar === "same") tier = "likely";
  else if (avatar === "different" && (lowKick || partnerMismatch)) tier = "suspected";
  else tier = "unconfirmed";

  const good = [], bad = [];
  if (twLinksKick) good.push("linked from the Twitch bio");
  if (verified === true) good.push("Kick-verified");
  if (avatar === "same") good.push("same profile picture");
  if (avatar === "different") bad.push("different profile picture");
  if (known && (lowKick || partnerMismatch)) bad.push(`only ${followers.toLocaleString("en-US")} follower${followers === 1 ? "" : "s"} on Kick`);
  if (verified === false && (tier === "suspected" || tier === "unconfirmed")) bad.push("not Kick-verified");
  if (partner && tier === "suspected") bad.push("Twitch partner");
  if (kickLinksTwitch && !twLinksKick) {
    if (verified === true) good.push("Kick bio mentions Twitch");
    else bad.push("Kick bio mentions Twitch (anyone can write that)");
  }
  return { tier, reasons: tier === "suspected" || tier === "unconfirmed" ? [...bad, ...good] : [...good, ...bad] };
}

// The tier after your own corrections. "none" = you said it isn't them.
// (Same small function lives in popup.js and content.js: keep them in sync.)
function effectiveTier(v, override) {
  if (override === "not") return "none";
  if (override === "yes") return "confirmed";
  return v?.tier || "unconfirmed";
}

// Best effort: Kick's official public API has no verified badge, follower count or
// avatar, so ask the unofficial v2 endpoint. It may fail (Cloudflare, format
// changes); then we return null and the match simply can't rise above "unconfirmed".
async function kickProfile(slug) {
  try {
    const r = await fetch(
      `https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`,
      { credentials: "omit", headers: { Accept: "application/json" } }
    );
    if (!r.ok) return null;
    const j = await r.json();
    return {
      verified: j.verified === undefined ? null : Boolean(j.verified),
      followers: typeof j.followers_count === "number" ? j.followers_count : null,
      avatar: j.user?.profile_pic || null,
    };
  } catch (e) {
    console.debug("[Kick Bridge] profile lookup failed", e);
    return null;
  }
}

const PROFILE_TTL = 7 * 24 * 60 * 60 * 1000; // badge/followers/avatar rarely change: reuse for a week

// Everything we keep about a found Kick channel. `tw` = { bio, img, type } from Twitch,
// `prev` = the previously saved value, reused so a refresh doesn't repeat slow requests.
async function buildKickValue({ login, kick, tw, prev }) {
  const slug = kick.slug.toLowerCase();
  // No Twitch info this time (e.g. no Twitch secret on a channel page)? Keep what we already knew.
  const twLinksKick = typeof tw?.bio === "string"
    ? tw.bio.toLowerCase().includes(`kick.com/${slug}`)
    : Boolean(prev?.linked);
  const kickLinksTwitch = (kick.channel_description || "").toLowerCase().includes(`twitch.tv/${login}`);

  const old = prev
    ? { verified: prev.kickVerified ?? null, followers: prev.kickFollowers ?? null, avatar: prev.kickAvatar ?? null, at: prev.profileAt }
    : null;
  let prof;
  if (old?.at && Date.now() - old.at < PROFILE_TTL) {
    prof = old;
  } else {
    const p = await kickProfile(kick.slug);
    prof = p ? { ...p, at: Date.now() } : old?.at ? old : null;
  }

  let avatarDist = null;
  const twImg = tw?.img || prev?.twAvatar || null;
  const twType = tw?.type || prev?.twType || "";
  const kAvatar = prof?.avatar || null;
  if (twImg && kAvatar) {
    if (prev && prev.kickAvatar === kAvatar && prev.twAvatar === twImg && typeof prev.avatarDist === "number") {
      avatarDist = prev.avatarDist;
    } else {
      const [a, b] = await Promise.all([imageHash(twImg), imageHash(kAvatar)]);
      avatarDist = a && b ? hamming(a, b) : null;
    }
  }

  const { tier, reasons } = assessMatch({
    twLinksKick, kickLinksTwitch,
    verified: prof?.verified ?? null, followers: prof?.followers ?? null,
    avatarDist, twType,
  });
  return {
    kickSlug: kick.slug,
    kickUserId: kick.broadcaster_user_id, // lets us batch live-status refreshes
    isLive: Boolean(kick.stream?.is_live),
    linked: twLinksKick,                  // the Twitch bio points at this Kick channel
    kickLinksTwitch,
    kickVerified: prof?.verified ?? null,
    kickFollowers: prof?.followers ?? null,
    kickAvatar: kAvatar,
    twAvatar: twImg,
    twType,
    avatarDist,
    tier,
    reasons,
    profileAt: prof?.at,          // when the badge/followers/avatar were last read OK
    profileTriedAt: Date.now(),   // when we last tried (so a blocked endpoint isn't re-flagged forever)
  };
}

async function lookup(login) {
  login = String(login || "").toLowerCase();
  const hit = cache.get(login);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;

  const c = await getCreds();
  if (!c.kickId || !c.kickSecret) return { error: "NO_CREDENTIALS" };
  const hasTwitch = Boolean(c.twitchId && c.twitchSecret);

  const [tw, kick] = await Promise.all([
    hasTwitch ? twitchUser(login, c) : null,
    kickChannel(kickSlugGuess(login), c),
  ]);

  let value = { kickSlug: null };
  if (kick?.slug) {
    const got = await chrome.storage.local.get([`kc:${login}`, "followsCache"]);
    const saved = got[`kc:${login}`]?.value;
    const followed = (got.followsCache?.list || []).find((f) => f.login === login);
    const built = await buildKickValue({
      login,
      kick,
      tw: tw
        ? { bio: tw.description, img: tw.profile_image_url, type: tw.broadcaster_type }
        : followed && { bio: followed.bio, img: followed.img, type: followed.type },
      prev: saved?.kickSlug ? saved : undefined, // reuse what the popup already worked out
    });
    value = { ...built, title: kick.stream_title || "" };
  }

  cache.set(login, { at: Date.now(), value });
  return value;
}

// Kick slugs generally use hyphens where usernames have underscores.
function kickSlugGuess(login) {
  return login.replace(/_/g, "-");
}

// ---------- Twitch user login (for the followed-streamers list) ----------
// Implicit grant via chrome.identity. Requires the redirect URL shown on the
// options page to be added to your Twitch app's "OAuth Redirect URLs".

async function twitchLogin() {
  const c = await getCreds();
  if (!c.twitchId) throw new Error("Add your Twitch Client ID in settings first.");

  const state = crypto.randomUUID();
  const authUrl =
    "https://id.twitch.tv/oauth2/authorize?" +
    new URLSearchParams({
      client_id: c.twitchId,
      redirect_uri: chrome.identity.getRedirectURL(),
      response_type: "token",
      scope: "user:read:follows",
      state,
    });

  const redirected = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
  const params = new URLSearchParams(new URL(redirected).hash.slice(1));
  if (params.get("state") !== state) throw new Error("Login state mismatch.");
  const token = params.get("access_token");
  if (!token) throw new Error(params.get("error_description") || "No access token returned.");

  // Validate to learn the user id, login and token lifetime.
  const v = await fetch("https://id.twitch.tv/oauth2/validate", {
    headers: { Authorization: `OAuth ${token}` },
  });
  if (!v.ok) throw new Error(`Token validation failed (${v.status}).`);
  const info = await v.json();

  await chrome.storage.local.set({
    twitchUser: {
      token,
      userId: info.user_id,
      login: info.login,
      exp: Date.now() + info.expires_in * 1000,
    },
  });
  return { login: info.login };
}

// ---------- Lightweight lookup for many channels (popup) ----------
// One Kick request per channel (+1 for the badge when found), cached in
// chrome.storage.local so reopening the popup is fast and rate-limit friendly.

const FOUND_TTL = 2 * 60 * 1000;                 // live status goes stale quickly
const MISS_TTL = 7 * 24 * 60 * 60 * 1000;        // "not on Kick" rarely changes

async function lookupLite(login, twOrBio, force = false) {
  login = String(login || "").toLowerCase();
  const tw = typeof twOrBio === "string" ? { bio: twOrBio } : twOrBio || {}; // { bio, img, type } from Twitch
  const key = `kc:${login}`;
  const stored = (await chrome.storage.local.get(key))[key];
  if (stored && !force) {
    const ttl = stored.value.kickSlug ? FOUND_TTL : MISS_TTL;
    if (Date.now() - stored.at < ttl) return stored.value;
  }

  const c = await getCreds();
  if (!c.kickId || !c.kickSecret) return { error: "NO_CREDENTIALS" };

  let kick;
  try {
    kick = await kickChannel(kickSlugGuess(login), c);
  } catch (e) {
    if (String(e.message).includes("RATE_LIMIT")) throw e; // not cached: we stopped early
    await recordError("Kick lookup", e);
    // Remember the failure for a while so every popup open doesn't retry it.
    const failed = { kickSlug: null, failed: true };
    await chrome.storage.local.set({ [key]: { at: Date.now(), value: failed } });
    return failed;
  }
  let value = { kickSlug: null };
  if (kick?.slug) {
    value = await buildKickValue({ login, kick, tw, prev: stored?.value?.kickSlug ? stored.value : undefined });
  }
  await chrome.storage.local.set({ [key]: { at: Date.now(), value } });
  return value;
}

// ---------- Batched live status (popup) ----------
// Kick's /livestreams takes up to 50 broadcaster ids per request and simply
// leaves offline channels out of the answer, so refreshing the live status of
// every channel that is on Kick costs ~1 request per 50 channels.

async function kickGet(url, c) {
  for (const force of [false, true]) {
    const token = await kickToken(c, force);
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (r.status === 401 && !force) continue;
    if (r.status === 429) throw rateLimitError(r);
    if (!r.ok) throw new Error(`Kick API error ${r.status}`);
    return (await r.json()).data ?? [];
  }
}

async function refreshLive(entries) {
  const c = await getCreds();
  if (!c.kickId || !c.kickSecret) return { error: "NO_CREDENTIALS" };

  const liveIds = new Set();
  const liveInfo = {}; // broadcaster id -> { title, category } for streams that are live
  for (let i = 0; i < entries.length; i += 50) {
    const q = new URLSearchParams();
    for (const e of entries.slice(i, i + 50)) q.append("broadcaster_user_id", e.userId);
    const data = await kickGet(`https://api.kick.com/public/v1/livestreams?${q}`, c);
    for (const s of data) {
      liveIds.add(String(s.broadcaster_user_id));
      liveInfo[String(s.broadcaster_user_id)] = {
        title: s.stream_title || s.title || "",
        category: s.category?.name || "",
      };
    }
  }

  const keys = entries.map((e) => `kc:${e.login}`);
  const stored = await chrome.storage.local.get(keys);
  const now = Date.now();
  const update = {};
  const results = {};
  for (const e of entries) {
    const prev = stored[`kc:${e.login}`];
    if (!prev?.value?.kickSlug) continue;
    const value = { ...prev.value, isLive: liveIds.has(String(e.userId)) };
    update[`kc:${e.login}`] = { at: now, value };
    results[e.login] = value;
  }
  await chrome.storage.local.set(update);
  return { results, liveInfo };
}

// ---------- Scans run here, not in the popup ----------
// A scan is a persistent queue (storage.scanItems / scanIndex) worked through at
// a steady, configurable pace (default: 200 streamers per 3 minutes) so Kick's
// rate limit isn't hit. Closing the popup can't interrupt it. If Kick still says
// "slow down" the scan backs off, slows itself down and carries on. If Chrome
// stops this worker, an alarm wakes it and it resumes from the saved position.
// Progress is published in storage.scanState; the popup just watches it.

let activeScan = false;
let scanCancelled = false; // set by "Clear cache" to stop a running scan
const WATCHDOG = "kick-bridge-scan";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const isRateLimit = (e) => String(e?.message || e).includes("RATE_LIMIT");

function rateLimitError(r) {
  const e = new Error("RATE_LIMIT");
  const secs = Number(r.headers?.get?.("Retry-After"));
  if (secs > 0) e.retryAfterMs = Math.min(secs * 1000, 10 * 60 * 1000);
  return e;
}

// Long waits are cut into short slices with a storage write in between:
// extension API calls keep the service worker alive, one long timer would not.
async function sleepAlive(ms, beat) {
  let left = ms;
  while (left > 0 && !scanCancelled) {
    const slice = Math.min(10_000, left);
    await sleep(slice);
    left -= slice;
    if (ms > 10_000) await beat();
  }
}

async function startScan({ full = [], live = [] }) {
  if (activeScan) return { alreadyRunning: true };
  const c = await getCreds();
  if (!c.kickId || !c.kickSecret) return { error: "NO_CREDENTIALS" };

  await chrome.storage.local.set({
    scanItems: full.map((x) => ({ login: x.login, force: Boolean(x.force) })),
    scanIndex: 0,
    scanLive: live,
    scanTotal: full.length + live.length,
  });
  chrome.alarms.create(WATCHDOG, { periodInMinutes: 1 });
  runQueue(); // deliberately not awaited: the popup gets an instant reply
  return { started: true };
}

async function runQueue() {
  if (activeScan) return;
  activeScan = true;
  const st = { running: true, total: 0, done: 0, pausedUntil: 0, etaMs: 0, limited: false, liveFailed: false, heartbeat: 0 };
  const saveState = (extra = {}) => {
    Object.assign(st, extra);
    st.heartbeat = Date.now();
    return chrome.storage.local.set({ scanState: { ...st } });
  };

  try {
    const s = await chrome.storage.local.get([
      "scanItems", "scanIndex", "scanLive", "scanTotal", "rateBatch", "rateMinutes", "followsCache",
    ]);
    const items = s.scanItems || [];
    let index = s.scanIndex || 0;
    const live = s.scanLive || [];
    const total = s.scanTotal || items.length + live.length;
    const liveCount = total - items.length;

    // Pace: `batch` checks spread evenly over `minutes`.
    const batch = clamp(Math.round(Number(s.rateBatch) || 200), 10, 1000);
    const minutes = clamp(Number(s.rateMinutes) || 3, 1, 60);
    const base = (minutes * 60_000) / batch;
    let interval = base;

    const twInfo = new Map((s.followsCache?.list || []).map((f) => [f.login, { bio: f.bio, img: f.img, type: f.type }]));

    st.total = total;
    st.done = (live.length ? 0 : liveCount) + index;
    await saveState();

    // 1) live status of everyone already known to be on Kick: one batched request per 50
    if (live.length) {
      try {
        await refreshLive(live);
      } catch (e) {
        st.liveFailed = true;
        if (isRateLimit(e)) await noteRateLimit(e);
        else await recordError("Live status refresh", e);
      }
      await chrome.storage.local.set({ scanLive: [] });
      st.done = liveCount + index;
      await saveState();
    }

    // 2) full lookups, one at a time at the steady pace
    let strikes = 0, backoff = 60_000;
    while (index < items.length && !scanCancelled) {
      const it = items[index];
      const t0 = Date.now();
      try {
        await lookupLite(it.login, twInfo.get(it.login) || {}, it.force);
        strikes = 0;
        backoff = 60_000;
      } catch (e) {
        if (!isRateLimit(e)) throw e;
        await noteRateLimit(e);
        if (++strikes > 6) { st.limited = true; break; } // give up; leftovers wait for ↻
        const wait = e.retryAfterMs || backoff;
        backoff = Math.min(backoff * 2, 10 * 60_000);
        interval = Math.min(interval * 1.5, base * 4);   // be gentler for the rest of the scan
        await saveState({ pausedUntil: Date.now() + wait });
        await sleepAlive(wait, () => saveState());
        await saveState({ pausedUntil: 0 });
        continue; // retry the same streamer
      }
      index++;
      st.done = liveCount + index;
      st.etaMs = (items.length - index) * interval;
      if (index % 10 === 0) await chrome.storage.local.set({ scanIndex: index });
      await saveState();

      const wait = interval - (Date.now() - t0);
      if (wait > 0 && index < items.length) await sleepAlive(wait, () => saveState());
    }
  } catch (e) {
    console.warn("[Kick Bridge] scan stopped:", e);
    st.limited = isRateLimit(e);
    if (!isRateLimit(e)) await recordError("Scan", e);
  }

  // Finished (or gave up): drop the queue and the watchdog.
  await chrome.storage.local.remove(["scanItems", "scanIndex", "scanLive", "scanTotal"]);
  chrome.alarms.clear(WATCHDOG);
  await saveState({ running: false, pausedUntil: 0, etaMs: 0, finishedAt: Date.now() });
  activeScan = false;
}

// If Chrome stopped this worker mid-scan, pick the queue back up.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== WATCHDOG || activeScan) return;
  const s = await chrome.storage.local.get(["scanItems", "scanIndex", "scanLive"]);
  const pending = s.scanItems && ((s.scanIndex || 0) < s.scanItems.length || (s.scanLive || []).length);
  if (pending) runQueue();
  else chrome.alarms.clear(WATCHDOG);
});

// ---------- Toolbar badge (optional: Settings > Display) ----------
// Shows how many followed streamers were live on Kick at the last check. It only
// reads saved results and never starts a check, so the number moves when a check
// finishes (first load, or ↻ in the popup).

async function updateBadge() {
  try {
    const { showBadge, followsCache, kickOverrides = {} } = await chrome.storage.local.get(["showBadge", "followsCache", "kickOverrides"]);
    const list = followsCache?.list || [];
    if (!showBadge || !list.length) {
      await chrome.action.setBadgeText({ text: "" });
      await chrome.action.setTitle({ title: "Twitch → Kick Bridge" });
      return;
    }
    const keys = list.map((f) => `kc:${f.login}`); // only people you still follow
    const stored = await chrome.storage.local.get(keys);
    let live = 0;
    for (const f of list) {
      const v = stored[`kc:${f.login}`]?.value;
      const t = effectiveTier(v, kickOverrides[f.login]);
      if (v?.kickSlug && v.isLive && t !== "suspected" && t !== "none") live++; // lookalikes don't count
    }
    await chrome.action.setBadgeBackgroundColor({ color: "#53fc18" });
    if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: "#0b0e0f" });
    await chrome.action.setBadgeText({ text: String(live) });
    await chrome.action.setTitle({ title: `Twitch → Kick Bridge — ${live} live on Kick (last check)` });
  } catch (e) {
    console.debug("[Kick Bridge] badge update failed", e);
  }
}

// Debounced: a paced scan writes a result every second or so; wait for a quiet moment.
let badgeTimer = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const relevant = Object.keys(changes).some(
    (k) => k === "showBadge" || k === "followsCache" || k === "kickOverrides" || k.startsWith("kc:")
  );
  if (!relevant) return;
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(updateBadge, 2000);
});
chrome.runtime.onStartup.addListener(updateBadge);
chrome.runtime.onInstalled.addListener(updateBadge);
updateBadge(); // and whenever the worker wakes up

// ---------- Connections (Settings > Connections) ----------
// Twitch: used to read who you follow. Kick: your own Kick account, saved for
// features that need it. Kick's public API has no follow action, so for now the
// Kick login is only stored and shown; "Kick ↗" is still a link to their profile.
// (These user tokens are separate from the app tokens used for lookups.)

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const FORM = { "Content-Type": "application/x-www-form-urlencoded" };

async function kickLogin() {
  const c = await getCreds();
  if (!c.kickId || !c.kickSecret) throw new Error("Add your Kick Client ID and Secret first.");

  // PKCE (required by Kick)
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = crypto.randomUUID();
  const redirect = chrome.identity.getRedirectURL();

  const authUrl =
    "https://id.kick.com/oauth/authorize?" +
    new URLSearchParams({
      response_type: "code",
      client_id: c.kickId,
      redirect_uri: redirect,
      scope: "user:read",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    });

  const redirected = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
  const params = new URL(redirected).searchParams;
  if (params.get("state") !== state) throw new Error("Login state mismatch.");
  const code = params.get("code");
  if (!code) throw new Error(params.get("error_description") || params.get("error") || "No authorization code returned.");

  const r = await fetch("https://id.kick.com/oauth/token", {
    method: "POST",
    headers: FORM,
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: c.kickId,
      client_secret: c.kickSecret,
      redirect_uri: redirect,
      code_verifier: verifier,
    }),
  });
  if (!r.ok) throw new Error(`Kick token exchange failed (${r.status}).`);
  const t = await r.json();

  // Who just logged in? (/users with no ids returns the token's owner.)
  let name = null, userId = null;
  try {
    const u = await fetch("https://api.kick.com/public/v1/users", {
      headers: { Authorization: `Bearer ${t.access_token}` },
    });
    if (u.ok) {
      const d = (await u.json()).data?.[0];
      name = d?.name ?? null;
      userId = d?.user_id ?? null;
    }
  } catch (e) { /* the name is cosmetic */ }

  await chrome.storage.local.set({
    kickUser: {
      accessToken: t.access_token,
      refreshToken: t.refresh_token || null,
      exp: Date.now() + (t.expires_in || 0) * 1000,
      scope: t.scope || "",
      userId,
      name,
    },
  });
  return { name };
}

// Log out = ask the provider to revoke the token (best effort) + forget it here.
async function kickLogout() {
  const { kickUser, kickId, kickSecret } = await chrome.storage.local.get(["kickUser", "kickId", "kickSecret"]);
  if (kickUser && kickId) {
    for (const [token, hint] of [[kickUser.accessToken, "access_token"], [kickUser.refreshToken, "refresh_token"]]) {
      if (!token) continue;
      try {
        await fetch("https://id.kick.com/oauth/revoke", {
          method: "POST",
          headers: FORM,
          body: new URLSearchParams({ token, token_type_hint: hint, client_id: kickId, client_secret: kickSecret || "" }),
        });
      } catch (e) { /* offline or rejected: we still forget it locally */ }
    }
  }
  await chrome.storage.local.remove("kickUser"); // keeps the app token used for lookups
  return { ok: true };
}

async function twitchLogout() {
  const { twitchUser, twitchId } = await chrome.storage.local.get(["twitchUser", "twitchId"]);
  if (twitchUser?.token && twitchId) {
    try {
      await fetch("https://id.twitch.tv/oauth2/revoke", {
        method: "POST",
        headers: FORM,
        body: new URLSearchParams({ client_id: twitchId, token: twitchUser.token }),
      });
    } catch (e) { /* still forget it locally */ }
  }
  // The follow list belongs to the logged-in account, so it goes too.
  await chrome.storage.local.remove(["twitchUser", "followsCache"]);
  return { ok: true };
}

// ---------- Diagnostics support (Settings > Diagnostics) ----------

// Last few errors, newest first. Repeats of the same error within a minute are
// merged into one line with a count so a bad batch can't flood the list.
async function recordError(source, err) {
  try {
    const message = String(err?.message ?? err).slice(0, 300);
    const { errorLog = [] } = await chrome.storage.local.get("errorLog");
    const last = errorLog[0];
    if (last && last.source === source && last.message === message && Date.now() - last.at < 60_000) {
      last.at = Date.now();
      last.count = (last.count || 1) + 1;
    } else {
      errorLog.unshift({ at: Date.now(), source, message, count: 1 });
    }
    await chrome.storage.local.set({ errorLog: errorLog.slice(0, 5) });
  } catch (e) { /* diagnostics must never break the extension */ }
}

async function noteRateLimit(err) {
  try {
    const { rateLimit } = await chrome.storage.local.get("rateLimit");
    await chrome.storage.local.set({
      rateLimit: { lastAt: Date.now(), total: (rateLimit?.total || 0) + 1, retryAfterMs: err?.retryAfterMs || null },
    });
  } catch (e) { /* same */ }
}

// Everything here can be re-fetched. Logins, credentials and settings are kept.
const CACHE_KEYS = [
  "followsCache", "scanState", "scanItems", "scanIndex", "scanLive", "scanTotal",
  "kickToken", "twitchToken", "errorLog", "rateLimit", "favState", "favCheck",
];

async function clearCache() {
  scanCancelled = true; // a running scan stops at its next step
  for (let i = 0; i < 150 && activeScan; i++) await sleep(100);
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith("kc:") || CACHE_KEYS.includes(k));
  await chrome.storage.local.remove(keys);
  scanCancelled = false;
  return { removed: keys.length };
}

// ---------- Favorites: hourly check + "went live" notifications ----------
// Up to 10 starred streamers (storage.favorites = list of Twitch logins). They
// are the one thing checked automatically: every hour, and right after you star
// someone. That is a single batched request for all of them (plus one full
// lookup for any whose Kick id isn't known yet).
//
// A notification fires on a *transition*: the previous hourly check saw them
// offline and this one sees them live. The first check after starring only
// records a baseline, so starring someone who is already live stays quiet.
// Hourly polling can't see a stream that starts and ends between two checks.

const FAV_ALARM = "kick-bridge-favs";
const FAV_RETRY_ALARM = "kick-bridge-favs-retry";
const MAX_FAVS = 10;
let favCheckRunning = false;

async function ensureFavAlarm() {
  const { favorites = [] } = await chrome.storage.local.get("favorites");
  const existing = await chrome.alarms.get(FAV_ALARM);
  if (favorites.length && !existing) chrome.alarms.create(FAV_ALARM, { delayInMinutes: 60, periodInMinutes: 60 });
  if (!favorites.length && existing) await chrome.alarms.clear(FAV_ALARM);
}

async function checkFavorites(opts = {}) {
  if (favCheckRunning) return { skipped: true };
  favCheckRunning = true;
  try {
    const c = await getCreds();
    if (!c.kickId || !c.kickSecret) return { error: "NO_CREDENTIALS" };

    const s = await chrome.storage.local.get(["favorites", "notifyFavorites", "favState", "followsCache", "kickOverrides"]);
    const overrides = s.kickOverrides || {};
    const favs = (s.favorites || []).slice(0, MAX_FAVS);
    if (!favs.length) return { checked: 0, wentLive: 0 };
    const list = s.followsCache?.list || [];
    const names = new Map(list.map((f) => [f.login, f.name]));
    const twInfo = new Map(list.map((f) => [f.login, { bio: f.bio, img: f.img, type: f.type }]));
    const prevState = s.favState || {};

    // 1) We need each favorite's Kick user id. Look up any we don't have yet.
    const stored = await chrome.storage.local.get(favs.map((l) => `kc:${l}`));
    const entries = [];
    for (const login of favs) {
      let v = stored[`kc:${login}`]?.value;
      if (!v?.kickSlug || !v.kickUserId) v = await lookupLite(login, twInfo.get(login) || {}, true);
      const t = effectiveTier(v, overrides[login]);
      if (v?.kickSlug && v.kickUserId && t !== "suspected" && t !== "none") entries.push({ login, userId: v.kickUserId });
    }

    // 2) One batched request for everyone's live status (also refreshes the shared cache).
    let results = {}, liveInfo = {};
    if (entries.length) ({ results, liveInfo } = await refreshLive(entries));

    // 3) Compare with the previous hourly check.
    const now = Date.now();
    const nextState = {};
    const wentLive = [];
    for (const login of favs) {
      const value = results[login];
      if (!value) { // not on Kick / couldn't tell: keep whatever we knew
        if (prevState[login]) nextState[login] = prevState[login];
        continue;
      }
      const isLive = Boolean(value.isLive);
      nextState[login] = { live: isLive, at: now };
      if (isLive && prevState[login]?.live === false) {
        wentLive.push({
          slug: value.kickSlug,
          name: names.get(login) || login,
          info: liveInfo[String(value.kickUserId)],
        });
      }
    }
    await chrome.storage.local.set({ favState: nextState, favCheck: { lastAt: now, error: null } });
    if (s.notifyFavorites) for (const w of wentLive) await notifyLive(w);
    return { checked: favs.length, wentLive: wentLive.length };
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 200);
    if (isRateLimit(e)) await noteRateLimit(e);
    else await recordError("Favorites check", e);
    await chrome.storage.local.set({ favCheck: { lastAt: Date.now(), error: msg } });
    if (!opts.retry) chrome.alarms.create(FAV_RETRY_ALARM, { delayInMinutes: 5 }); // one retry, not a loop
    return { error: msg };
  } finally {
    favCheckRunning = false;
  }
}

async function notifyLive({ slug, name, info }) {
  const message = [info?.title, info?.category].filter(Boolean).join(" · ") || "Click to open their channel";
  chrome.notifications.create(`fav:${slug}:${Date.now()}`, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: `${name} is live on Kick`,
    message,
  });
}

chrome.notifications.onClicked.addListener((id) => {
  const m = /^fav:([^:]+):\d+$/.exec(id);
  if (!m) return;
  chrome.tabs.create({ url: `https://kick.com/${encodeURIComponent(m[1])}` });
  chrome.notifications.clear(id);
});

async function testNotification() {
  const level = await new Promise((res) => chrome.notifications.getPermissionLevel(res));
  if (level === "denied") {
    throw new Error("Notifications are blocked for Chrome. Allow them in your system's notification settings.");
  }
  chrome.notifications.create(`test:${Date.now()}`, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "Twitch → Kick Bridge",
    message: "Notifications are working. You'll see one like this when a favorite goes live.",
  });
  return { ok: true };
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === FAV_ALARM) checkFavorites();
  else if (alarm.name === FAV_RETRY_ALARM) checkFavorites({ retry: true });
});

// Starring someone: keep the alarm in sync and take their baseline right away.
let favTimer = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.favorites) return;
  clearTimeout(favTimer);
  favTimer = setTimeout(async () => {
    await ensureFavAlarm();
    const { favorites = [], favState = {} } = await chrome.storage.local.get(["favorites", "favState"]);
    if (favorites.some((l) => !favState[l])) checkFavorites();
  }, 2000);
});
chrome.runtime.onStartup.addListener(ensureFavAlarm);
chrome.runtime.onInstalled.addListener(ensureFavAlarm);
ensureFavAlarm(); // and whenever the worker wakes up

// ---------- Your corrections ("not them" / "it's them") ----------
// storage.kickOverrides = { login: "yes" | "not" }. They survive Clear cache: they're
// your decisions, not cached data. Marking someone "not them" also un-stars them.
async function setOverride(login, verdict) {
  login = String(login || "").toLowerCase();
  if (login === "__proto__") return { ok: false };
  const { kickOverrides = {}, kickOverrideTimes = {}, favorites = [] } =
    await chrome.storage.local.get(["kickOverrides", "kickOverrideTimes", "favorites"]);
  if (verdict === "yes" || verdict === "not") kickOverrides[login] = verdict;
  else delete kickOverrides[login];
  // "It's them" gets a short Undo window; the time is what the popup/page use to retire the Undo link.
  if (verdict === "yes") kickOverrideTimes[login] = Date.now();
  else delete kickOverrideTimes[login];
  for (const l of Object.keys(kickOverrideTimes)) if (kickOverrides[l] !== "yes") delete kickOverrideTimes[l];
  const update = { kickOverrides, kickOverrideTimes };
  if (verdict === "not" && favorites.includes(login)) update.favorites = favorites.filter((l) => l !== login);
  await chrome.storage.local.set(update);
  return { ok: true };
}

// Restore corrections from a file made by Settings > Match corrections > Export.
// Validated strictly (it's a file from outside): known app + version, sane logins, only
// "yes"/"not". Imported entries win over existing ones for the same streamer. Imported
// confirmations are settled, so they get no Undo window.
const LOGIN_RE = /^[a-z0-9_]{1,25}$/;
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key); // `in` would also match "constructor", "toString"...
const MAX_IMPORT = 5000;

async function importOverrides(data) {
  if (!data || typeof data !== "object" || data.app !== "twitch-kick-bridge") {
    throw new Error("This file isn't a Twitch → Kick Bridge export.");
  }
  if (!(Number(data.version) >= 1)) throw new Error("This file isn't a Twitch → Kick Bridge export.");
  if (Number(data.version) > 1) throw new Error("This export was made by a newer version of the extension.");
  const src = data.overrides;
  if (!src || typeof src !== "object" || Array.isArray(src)) throw new Error("This export has no corrections in it.");
  const entries = Object.entries(src);
  if (entries.length > MAX_IMPORT) throw new Error(`Too many entries (the limit is ${MAX_IMPORT}).`);

  const clean = {};
  let skipped = 0;
  for (const [raw, verdict] of entries) {
    const login = String(raw).trim().toLowerCase();
    // "__proto__" is a valid-looking login but can't be stored as a key; skip it rather than lose it silently
    if (LOGIN_RE.test(login) && login !== "__proto__" && (verdict === "yes" || verdict === "not")) clean[login] = verdict;
    else skipped++;
  }

  const { kickOverrides = {}, kickOverrideTimes = {}, favorites = [] } =
    await chrome.storage.local.get(["kickOverrides", "kickOverrideTimes", "favorites"]);
  let added = 0, updated = 0, unchanged = 0;
  for (const [login, verdict] of Object.entries(clean)) {
    if (!own(kickOverrides, login)) added++;
    else if (kickOverrides[login] !== verdict) updated++;
    else unchanged++;
    kickOverrides[login] = verdict;
    delete kickOverrideTimes[login];
  }
  const notThem = new Set(Object.entries(clean).filter(([, v]) => v === "not").map(([l]) => l));
  await chrome.storage.local.set({
    kickOverrides,
    kickOverrideTimes,
    favorites: favorites.filter((l) => !notThem.has(l)), // someone you say isn't them can't stay a favorite
  });
  return { added, updated, unchanged, skipped };
}
