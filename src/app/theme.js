import { STORAGE_THEME } from "./storage-keys.js";

const root = document.documentElement;

/**
 * @returns {"dark" | "light"}
 */
function readStoredTheme() {
  try {
    const v = localStorage.getItem(STORAGE_THEME);
    if (v === "light" || v === "dark") return v;
  } catch {
    /* ignore */
  }
  return "dark";
}

/**
 * @param {"dark" | "light"} theme
 */
export function applyTheme(theme) {
  const t = theme === "light" ? "light" : "dark";
  root.dataset.theme = t;

  const btn = document.getElementById("theme-toggle");
  const icon = btn?.querySelector(".theme-toggle__icon");
  if (btn && icon) {
    icon.textContent = t === "light" ? "dark_mode" : "light_mode";
    btn.setAttribute("aria-pressed", t === "light" ? "true" : "false");
    btn.setAttribute("aria-label", t === "light" ? "Switch to dark theme" : "Switch to light theme");
    btn.title = t === "light" ? "Switch to dark theme" : "Warehouse 99 light edition";
  }

  try {
    localStorage.setItem(STORAGE_THEME, t);
  } catch {
    /* ignore */
  }
}

export function initTheme() {
  document.getElementById("theme-toggle")?.addEventListener("click", () => {
    applyTheme(root.dataset.theme === "light" ? "dark" : "light");
  });
}

applyTheme(readStoredTheme());
