# PKR Explorer

PKR Explorer is a browser-based Tony Hawk's Pro Skater data file viewer.

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

### Online / hosted

This project is a static web app. When hosted on any normal web server or static hosting platform, the site entry point is `index.html`.

You do not need `serve.py` in production hosting. Just serve the repository root as static files.

### Local testing

For local testing, use the included Python helper:

```bash
python serve.py
```

Then open the printed URL in your browser, usually `http://127.0.0.1:8080/`.

The helper exists because opening `index.html` directly via `file://` can break module loading and CDN-loaded dependencies in some browsers.

## Tech Notes

- Plain HTML, CSS, and JavaScript modules
- No build step
- `Three.js` is loaded from a CDN for `.psx` preview rendering
- `fflate` is loaded from a CDN for zlib-compressed archive entries

## Attribution

This project uses or references the following third-party work:

- [`three.js`](https://threejs.org/) for browser-based 3D rendering
- [`fflate`](https://github.com/101arrowz/fflate) for zlib decompression in the browser
- THPS2-style PKR support in `pkr.js` is based in part on the `extract-pkr.py` layout from [`JayFoxRox/thps2-tools`](https://github.com/JayFoxRox/thps2-tools)
- `.psx` parsing and texture handling in `psx-model.js` and `psx-textures.js` follow public format notes by GreaseMonkey / iamgreaser: [gist](https://gist.github.com/iamgreaser/b54531e41d77b69d7d13391deb0ac6a5)

## Project Files

- `index.html`: app shell and UI markup
- `app.js`: main application logic
- `pkr.js`: PKR archive parsing and extraction
- `prk.js`: PRK parsing
- `psx-model.js`: `.psx` geometry parsing and preview logic
- `psx-textures.js`: `.psx` texture decoding helpers
- `styles.css`: app styling
- `serve.py`: local static server for testing

## Limitations

- `.psx` preview is best effort and does not fully replicate original PS1 rendering behavior
- Some features rely on CDN-hosted dependencies, so fully offline use would require vendoring them
- There is currently no automated test suite in this repo

## Purpose

This repo is intended as a viewer and inspection tool for THPS-era data files, useful for research, modding, and reverse-engineering workflows.
