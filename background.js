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
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = HANDLERS[msg?.type];
  if (!handler) return;
  handler(msg)
    .then(sendResponse)
    .catch((err) => {
      console.warn("[Kick Bridge] handler failed:", err);
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

// Best effort: Kick's official public API doesn't seem to expose the verified
// badge, so ask the unofficial v2 endpoint. It may fail (Cloudflare, format
// changes) — in that case we return null and the UI just doesn't show a badge.
async function kickVerifiedBadge(slug) {
  try {
    const r = await fetch(
      `https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`,
      { credentials: "omit", headers: { Accept: "application/json" } }
    );
    if (!r.ok) return null;
    const j = await r.json();
    return j.verified === undefined ? null : Boolean(j.verified);
  } catch (e) {
    console.debug("[Kick Bridge] verified-badge lookup failed", e);
    return null;
  }
}

// ---------- matching ----------

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
    const slug = kick.slug.toLowerCase();
    const twitchBio = (tw?.description || "").toLowerCase();
    const kickBio = (kick.channel_description || "").toLowerCase();

    // "linked" = one profile's bio points at the other (strong evidence they
    // are the same person). This is separate from Kick's own verified badge.
    const linked =
      twitchBio.includes(`kick.com/${slug}`) ||
      kickBio.includes(`twitch.tv/${login}`);

    value = {
      kickSlug: kick.slug,
      isLive: Boolean(kick.stream?.is_live),
      linked,
      kickVerified: await kickVerifiedBadge(kick.slug), // true / false / null (unknown)
      title: kick.stream_title || "",
    };
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

async function lookupLite(login, twitchBio, force = false) {
  login = String(login || "").toLowerCase();
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
    // Remember the failure for a while so every popup open doesn't retry it.
    const failed = { kickSlug: null, failed: true };
    await chrome.storage.local.set({ [key]: { at: Date.now(), value: failed } });
    return failed;
  }
  let value = { kickSlug: null };
  if (kick?.slug) {
    const slug = kick.slug.toLowerCase();
    const linked =
      (twitchBio || "").toLowerCase().includes(`kick.com/${slug}`) ||
      (kick.channel_description || "").toLowerCase().includes(`twitch.tv/${login}`);
    value = {
      kickSlug: kick.slug,
      kickUserId: kick.broadcaster_user_id, // lets us batch live-status refreshes
      isLive: Boolean(kick.stream?.is_live),
      linked,
      // the badge almost never changes: reuse it on refreshes (saves a request)
      kickVerified: stored?.value?.kickVerified ?? (await kickVerifiedBadge(kick.slug)),
    };
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
  for (let i = 0; i < entries.length; i += 50) {
    const q = new URLSearchParams();
    for (const e of entries.slice(i, i + 50)) q.append("broadcaster_user_id", e.userId);
    const data = await kickGet(`https://api.kick.com/public/v1/livestreams?${q}`, c);
    for (const s of data) liveIds.add(String(s.broadcaster_user_id));
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
  return { results };
}

// ---------- Scans run here, not in the popup ----------
// A scan is a persistent queue (storage.scanItems / scanIndex) worked through at
// a steady, configurable pace (default: 200 streamers per 3 minutes) so Kick's
// rate limit isn't hit. Closing the popup can't interrupt it. If Kick still says
// "slow down" the scan backs off, slows itself down and carries on. If Chrome
// stops this worker, an alarm wakes it and it resumes from the saved position.
// Progress is published in storage.scanState; the popup just watches it.

let activeScan = false;
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
  while (left > 0) {
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

    const bios = new Map((s.followsCache?.list || []).map((f) => [f.login, f.bio]));

    st.total = total;
    st.done = (live.length ? 0 : liveCount) + index;
    await saveState();

    // 1) live status of everyone already known to be on Kick: one batched request per 50
    if (live.length) {
      try {
        await refreshLive(live);
      } catch (e) {
        st.liveFailed = true;
      }
      await chrome.storage.local.set({ scanLive: [] });
      st.done = liveCount + index;
      await saveState();
    }

    // 2) full lookups, one at a time at the steady pace
    let strikes = 0, backoff = 60_000;
    while (index < items.length) {
      const it = items[index];
      const t0 = Date.now();
      try {
        await lookupLite(it.login, bios.get(it.login) || "", it.force);
        strikes = 0;
        backoff = 60_000;
      } catch (e) {
        if (!isRateLimit(e)) throw e;
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
  }

  // Finished (or gave up): drop the queue and the watchdog.
  await chrome.storage.local.remove(["scanItems", "scanIndex", "scanLive", "scanTotal"]);
  chrome.alarms.clear(WATCHDOG);
  activeScan = false;
  await saveState({ running: false, pausedUntil: 0, etaMs: 0, finishedAt: Date.now() });
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
    const { showBadge, followsCache } = await chrome.storage.local.get(["showBadge", "followsCache"]);
    const list = followsCache?.list || [];
    if (!showBadge || !list.length) {
      await chrome.action.setBadgeText({ text: "" });
      await chrome.action.setTitle({ title: "Twitch → Kick Bridge" });
      return;
    }
    const keys = list.map((f) => `kc:${f.login}`); // only people you still follow
    const stored = await chrome.storage.local.get(keys);
    let live = 0;
    for (const k of keys) {
      const v = stored[k]?.value;
      if (v?.kickSlug && v.isLive) live++;
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
    (k) => k === "showBadge" || k === "followsCache" || k.startsWith("kc:")
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
