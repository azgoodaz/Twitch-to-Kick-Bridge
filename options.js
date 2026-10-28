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
