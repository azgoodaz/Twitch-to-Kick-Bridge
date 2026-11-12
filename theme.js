// Light / dark theme for the popup and the settings page.
// Loaded in <head>, so the right colours are in place before the page paints (no white flash).
//
// Two saved settings (chrome.storage.local, included in backups):
//   themeFollowSystem  true (default): use your computer's light/dark setting
//   theme              "light" | "dark": what to use when not following the system
// The sun/moon button switches by hand, which turns "follow system" off. The checkbox in
// Settings > General > Display turns it back on.
// A copy of the current mode lives in localStorage ("system" | "light" | "dark") only so it can be
// read synchronously before first paint; chrome.storage stays the source of truth.
(() => {
  const KEY = "kb-theme";
  const root = document.documentElement;
  const mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : { matches: false };
  const state = { follow: true, theme: "light" };
  let mode = "system";
  let current = "light";

  const resolve = (m, systemDark) => (m === "dark" ? "dark" : m === "light" ? "light" : systemDark ? "dark" : "light");
  const modeOf = (s) => (s.follow ? "system" : s.theme === "dark" ? "dark" : "light");

  function updateUi() {
    for (const b of document.querySelectorAll("[data-theme-toggle]")) {
      const label = current === "dark" ? "Switch to light mode" : "Switch to dark mode";
      b.title = label + (mode === "system" ? " (this stops following your computer's setting)" : "");
      b.setAttribute("aria-label", label);
      b.setAttribute("aria-pressed", String(current === "dark"));
    }
    const cb = document.querySelector("[data-theme-follow]");
    if (cb) cb.checked = mode === "system";
  }

  function apply(m) {
    mode = m;
    current = resolve(m, mq.matches);
    root.dataset.theme = current;
    try { localStorage.setItem(KEY, m); } catch (e) { /* storage blocked: the theme still works, just not pre-paint */ }
    updateUi();
  }

  // 1) before first paint: the mirrored mode (or the system setting on a first run)
  let mirrored = "system";
  try { mirrored = localStorage.getItem(KEY) || "system"; } catch (e) { /* ignore */ }
  apply(mirrored === "light" || mirrored === "dark" ? mirrored : "system");

  // 2) then the saved settings, which win
  const fromStorage = (s) => {
    state.follow = s.themeFollowSystem !== false;
    state.theme = s.theme === "dark" ? "dark" : "light";
    apply(modeOf(state));
  };
  chrome.storage.local.get(["themeFollowSystem", "theme"]).then(fromStorage);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || (!changes.themeFollowSystem && !changes.theme)) return;
    if (changes.themeFollowSystem) state.follow = changes.themeFollowSystem.newValue !== false;
    if (changes.theme) state.theme = changes.theme.newValue === "dark" ? "dark" : "light";
    apply(modeOf(state));
  });
  const onSystemChange = () => { if (mode === "system") apply("system"); };
  if (mq.addEventListener) mq.addEventListener("change", onSystemChange);
  else if (mq.addListener) mq.addListener(onSystemChange);

  // 3) the buttons
  function toggle() {
    const next = current === "dark" ? "light" : "dark";
    state.follow = false;
    state.theme = next;
    apply(next);
    chrome.storage.local.set({ theme: next, themeFollowSystem: false });
  }
  function wire() {
    for (const b of document.querySelectorAll("[data-theme-toggle]")) b.addEventListener("click", toggle);
    const cb = document.querySelector("[data-theme-follow]");
    if (cb) {
      cb.addEventListener("change", () => {
        if (cb.checked) {
          state.follow = true;
          apply("system");
          chrome.storage.local.set({ themeFollowSystem: true });
        } else {
          // keep the look the page has right now, instead of flipping to some stored default
          state.follow = false;
          state.theme = current;
          apply(current);
          chrome.storage.local.set({ themeFollowSystem: false, theme: current });
        }
      });
    }
    updateUi();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();
