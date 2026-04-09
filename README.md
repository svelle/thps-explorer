# PKR Explorer

PKR Explorer is a browser-based Tony Hawk's Pro Skater data file viewer.

<img width="2253" height="1263" alt="image" src="https://github.com/user-attachments/assets/cf4abd40-f004-472d-84e2-6fe3db7eaf7a" />

<img width="2247" height="1266" alt="image" src="https://github.com/user-attachments/assets/d4f75f1d-7e5f-4f4d-bfb8-fa025c4ceab6" />

<img width="2249" height="1263" alt="image" src="https://github.com/user-attachments/assets/08245678-6b66-40a2-ae2d-450b8d0b1c87" />


It is built for inspecting Neversoft archive and park-related formats in the browser, with support for browsing archive contents, previewing common asset types, and viewing some PlayStation-era model data.

The latest version is available at: https://svelle.github.io/thps-explorer/

I will never provide any game files, you need to find those on your own.

## Features

- Open `.pkr` archives in the browser
- Open standalone `.prk` park files
- Browse folders and files inside supported archives
- Filter, sort, and inspect extracted entries
- Preview text, hex, images, audio, and some `.psx` model content
- Download individual files from an archive

## Supported Formats

- `PKR3` archives
- THPS2-style PKR archives
- `PRK` park files
- Best-effort preview support for Neversoft `.psx` model files

## Running It

Prerequisites: [Bun](https://bun.sh/) 1.x (`bun install` installs app dependencies).

### Online / hosted

Build a production bundle, then host the `dist/` folder as static files (not the repo root).

```bash
bun run build
```

The entry file is `dist/index.html`.

### Local development

Hot reload while editing sources:

```bash
bun run dev
```

Then open the URL Bun prints in the terminal.

### Local preview (production build)

After `bun run build`, serve `dist/`:

```bash
bun run preview
```

Use `bun run preview -- --port 9000` (or env `PORT`) to pick another port.

Opening `index.html` via `file://` can break module loading in some browsers, so use HTTP for local work (`bun run dev` or `bun run preview`).

## Tech Notes

- Plain HTML, CSS, and JavaScript modules in the repo root; [Bun](https://bun.sh/) bundles them for release
- `bun run build` emits hashed JS/CSS into `dist/` and bundles `three` (PSX preview) and `fflate` (zlib / folder ZIP) from npm
- UI fonts still load from Google Fonts / Material Icons in `index.html` (optional CDN)

## Attribution

This project uses or references the following third-party work:

- `[three.js](https://threejs.org/)` for browser-based 3D rendering
- `[fflate](https://github.com/101arrowz/fflate)` for zlib decompression in the browser
- THPS2-style PKR support in `pkr.js` is based in part on the `extract-pkr.py` layout from `[JayFoxRox/thps2-tools](https://github.com/JayFoxRox/thps2-tools)`
- `.psx` parsing and texture handling in `psx-model.js` and `psx-textures.js` follow public format notes by GreaseMonkey / iamgreaser: [gist](https://gist.github.com/iamgreaser/b54531e41d77b69d7d13391deb0ac6a5)

## Project Files

- `package.json`: Bun scripts and npm dependencies (`three`, `fflate`)
- `index.html`: app shell and UI markup
- `app.js`: main application logic
- `pkr.js`: PKR archive parsing and extraction
- `prk.js`: PRK parsing
- `psx-model.js`: `.psx` geometry parsing and preview logic
- `psx-textures.js`: `.psx` texture decoding helpers
- `styles.css`: app styling
- `preview.ts`: tiny static server for `bun run preview` (`dist/` after build)

## Limitations

- `.psx` preview is best effort and does not fully replicate original PS1 rendering behavior
- Icon and web fonts are still loaded from Google’s CDN unless you vendor or replace those `<link>` tags in `index.html`
- There is currently no automated test suite in this repo

## Purpose

This repo is intended as a viewer and inspection tool for THPS-era data files, useful for research, modding, and reverse-engineering workflows.
