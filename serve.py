#!/usr/bin/env python3
"""
Minimal static file server for PKR explorer.

Opening index.html via file:// breaks ES modules and can block dynamic import()
of fflate from a CDN. Serve this directory over HTTP instead.

Usage:
  python serve.py
  python serve.py --port 9000

Then open http://127.0.0.1:8080/ (or your port) in a browser.
"""

from __future__ import annotations

import argparse
import contextlib
import http.server
import os
import socketserver
import sys


class ExplorerHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    """
    On Windows, ``mimetypes`` often maps ``.js`` to ``text/plain``, which
    browsers reject for ``<script type="module">``. Force correct types.
    """

    extensions_map = dict(
        http.server.SimpleHTTPRequestHandler.extensions_map,
        **{
            ".css": "text/css; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".mjs": "text/javascript; charset=utf-8",
        },
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0].strip())
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="bind address (default: 127.0.0.1)",
    )
    parser.add_argument(
        "-p",
        "--port",
        type=int,
        default=8080,
        help="port (default: 8080)",
    )
    args = parser.parse_args()

    root = os.path.dirname(os.path.abspath(__file__))
    os.chdir(root)

    for port in (args.port, *range(args.port + 1, args.port + 10)):
        try:
            httpd = socketserver.TCPServer((args.host, port), ExplorerHTTPRequestHandler)
            break
        except OSError:
            httpd = None
            continue
    else:
        print(f"Could not bind to {args.host}:{args.port}–{args.port + 9}", file=sys.stderr)
        sys.exit(1)

    if httpd.server_address[1] != args.port:
        print(f"Port {args.port} busy; using {httpd.server_address[1]} instead.", file=sys.stderr)

    url = f"http://{args.host}:{httpd.server_address[1]}/"
    print(f"Serving {root}")
    print(f"Open: {url}")
    print("Ctrl+C to stop")

    with contextlib.closing(httpd):
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")


if __name__ == "__main__":
    main()
