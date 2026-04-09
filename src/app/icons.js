/** Material “save / download” glyph (same path as Google Material Symbols). */
const DOWNLOAD_ICON_PATH_D =
  "M480-320 280-520l56-58 104 104v-326h80v326l104-104 56 58-200 200ZM240-160q-33 0-56.5-23.5T160-240v-120h80v120h480v-120h80v120q0 33-23.5 56.5T720-160H240Z";

/** Folder → ZIP (Material-style “save to archive” glyph). */
const FOLDER_ZIP_ICON_PATH_D =
  "m720-120 160-160-56-56-64 64v-167h-80v167l-64-64-56 56 160 160ZM560 0v-80h320V0H560ZM240-160q-33 0-56.5-23.5T160-240v-560q0-33 23.5-56.5T240-880h280l240 240v121h-80v-81H480v-200H240v560h240v80H240Zm0-80v-560 560Z";

/**
 * @param {string} [className]
 */
export function downloadIconSvg(className) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svg.setAttribute("viewBox", "0 -960 960 960");
  svg.setAttribute("width", "24");
  svg.setAttribute("height", "24");
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("aria-hidden", "true");
  if (className) svg.setAttribute("class", className);
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", DOWNLOAD_ICON_PATH_D);
  svg.appendChild(path);
  return svg;
}

/**
 * @param {string} [className]
 */
export function folderZipIconSvg(className) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svg.setAttribute("viewBox", "0 -960 960 960");
  svg.setAttribute("width", "24");
  svg.setAttribute("height", "24");
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("aria-hidden", "true");
  if (className) svg.setAttribute("class", className);
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", FOLDER_ZIP_ICON_PATH_D);
  svg.appendChild(path);
  return svg;
}

export const BUNDLE_STRIP_ICON_MESH = `<svg class="bundle-strip__icon" xmlns="http://www.w3.org/2000/svg" height="16" viewBox="0 -960 960 960" width="16" fill="currentColor" aria-hidden="true"><path d="M120-120v-720l360-180 360 180v720L480-300 120-120Zm80-131 280-126v-543L200-794v543Zm400 0v-543L440-920v543l280 126Z"/></svg>`;

export const BUNDLE_STRIP_ICON_TEX = `<svg class="bundle-strip__icon" xmlns="http://www.w3.org/2000/svg" height="16" viewBox="0 -960 960 960" width="16" fill="currentColor" aria-hidden="true"><path d="M200-200q-33 0-56.5-23.5T120-280v-400q0-33 23.5-56.5T200-760h560q33 0 56.5 23.5T840-680v400q0 33-23.5 56.5T760-200H200Zm40-80h480v-400H240v400Zm40-80h120l80 120 160-220 200 260v80H280v-240Z"/></svg>`;

export const BUNDLE_STRIP_ICON_ALT = `<svg class="bundle-strip__icon" xmlns="http://www.w3.org/2000/svg" height="16" viewBox="0 -960 960 960" width="16" fill="currentColor" aria-hidden="true"><path d="M360-240 120-480l240-240 240 240-240 240-240-240Zm240-154 86 86 86-86-86-86-86 86 86 86Z"/></svg>`;

export const BUNDLE_STRIP_ICON_TRIG = `<svg class="bundle-strip__icon" xmlns="http://www.w3.org/2000/svg" height="16" viewBox="0 -960 960 960" width="16" fill="currentColor" aria-hidden="true"><path d="m468-280 160-320H520v-200L360-480h108v200Zm12 160q-125 0-212.5-87.5T180-420q0-125 87.5-213T480-720q125 0 213 87T880-418q-2 125-90 213t-210 90Z"/></svg>`;
