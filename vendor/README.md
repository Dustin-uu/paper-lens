# Vendored dependencies

Bundled locally so the app works offline with no build step and no CDN.

| Library | Version | License | Upstream |
|---|---|---|---|
| PDF.js | 4.7.76 | Apache-2.0 | https://github.com/mozilla/pdf.js |
| KaTeX  | 0.16.11 | MIT | https://github.com/KaTeX/KaTeX |

`katex.min.css` has been edited to drop the `woff`/`ttf` font fallbacks —
only `woff2` files are shipped, which every target browser supports.
