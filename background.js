// Service worker: talks to the Twitch (Helix) and Kick (public) APIs.
// NOTE: credentials live in chrome.storage.local. That's fine for personal
// dev-mode testing, but for a published extension move them to a backend proxy.

const CACHE_TTL = 5 * 60 * 1000;
const cache = new Map(); // login -> { at, value }

const HANDLERS = {
  LOOKUP: (m) => lookup(m.login),               // content script (single channel)
  LOOKUP_LITE: (m) => lookupLite(m.login, m.bio, m.force), // popup (full lookup of one channel)
  LIVE_REFRESH: (m) => refreshLive(m.entries),             // popup (batched live status)
  TWITCH_LOGIN: () => twitchLogin(),             // popup "Connect Twitch"
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
    if (r.status === 429) throw new Error("RATE_LIMIT");
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
    if (r.status === 429) throw new Error("RATE_LIMIT");
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
