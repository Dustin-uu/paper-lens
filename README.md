<div align="center">

# paper-lens

**Read English papers bilingually — with the formulas intact and an AI tutor in the margin.**

Drop in a PDF, get a side-by-side Chinese/English reader where every equation, table and figure keeps its original typesetting. Click a formula to have it explained. Highlight anything to ask a follow-up.

Runs entirely in your browser. No backend, no build step, no upload.

[中文说明](README.zh-CN.md)

<img src="docs/screenshots/06-ai-formula.png" width="920" alt="Reading view with AI explaining a formula">

</div>

---

## Why this exists

I was working through an 85-page finance/ML paper and every existing option failed in a different way.

**Machine translators destroy the math.** This is not a quality problem, it is structural. A PDF has no concept of "an equation" — it stores glyphs at coordinates. Pull the text out of a matrix and you get this:

```
0.2880.4130.8991.057
```

A table fares worse:

```
High(H)40.020.61.9443.620.42.14225.819.31.34...
```

Any pipeline that tries to reconstruct formulas from the text stream is building on sand. Translate that stream and the math is gone.

**Translation alone doesn't solve the actual problem.** When you hit a bilevel optimization with a KKT-differentiated inner layer, a Chinese rendering of the surrounding prose doesn't help. You need someone to walk you through the symbols. That means switching to a chat window, re-typing the formula in LaTeX, and re-explaining the context you just read — every single time.

**The convenient tools want your file.** Upload-based services are fine for a blog post and wrong for an unpublished draft, a client document, or anything under NDA.

So: keep the formulas as pixels, put the tutor next to the text, and never let the file leave the machine.

## What it does

Formulas, tables and figures are **cropped from the rendered PDF at their original coordinates** and embedded as images. Zero fidelity loss, because nothing is reconstructed. Only prose gets translated.

Layout thresholds are **learned from the document itself** — it samples pages, takes the modal body font size and left margin, and derives the rest. A LaTeX paper (12pt body at x=72) and an NVIDIA whitepaper (11pt at x=54) both parse correctly with no manual tuning.

<table>
<tr>
<td width="50%"><img src="docs/screenshots/04-fidelity.png" alt="Formulas preserved inline"></td>
<td width="50%"><img src="docs/screenshots/05-side-by-side.png" alt="Side-by-side view"></td>
</tr>
<tr>
<td align="center"><em>Equations sit exactly where they belong, between the paragraphs that discuss them</em></td>
<td align="center"><em>Four view modes — this is side-by-side</em></td>
</tr>
</table>

### Ask about a formula

Click any equation. The image **and** the surrounding context (nearest section heading, neighbouring paragraphs in both languages) go to the model together, so the answer is grounded in this paper rather than generic. Answers render through KaTeX — you get $\ell(\theta)=\frac{1}{NT}\sum_{i=1}^{N}\sum_{t=1}^{T}(\cdot)^2$, not `1/(NT) Σ...`.

Follow-up questions keep the conversation, so "why is it designed this way?" works as a second turn.

### Highlight and annotate

<img src="docs/screenshots/07-highlight-notes.png" width="920" alt="Highlighting and the annotation panel">

Select text and it highlights immediately — in the translation or the original, both work. The panel lists every highlight in document order; click one to jump back and flash it in place.

Highlights are stored as **character offsets within a block**, not DOM positions, so they survive view switches, re-translation and re-rendering.

### Bring your own model

<table>
<tr>
<td width="50%"><img src="docs/screenshots/08-settings.png" alt="Settings"></td>
<td width="50%"><img src="docs/screenshots/09-layout-params.png" alt="Layout parameters"></td>
</tr>
</table>

Any OpenAI-compatible endpoint. Presets for DeepSeek, OpenAI, Zhipu GLM, Moonshot, Qwen, SiliconFlow and local Ollama. The key lives in `localStorage` and is sent to exactly one place: the URL you typed.

Layout parameters are exposed too, for when a PDF's typography doesn't match the defaults.

### Handles more than clean LaTeX

- **Bitmap figures are found by looking at the rendered pixels.** A photo or an unlabelled diagram produces no text fragments at all, so clustering can't see it. Rows that have ink but no text block over them are cropped as figures.
- **Figures split across a page break are stitched back together.** If one block hugs the bottom of a page and the next hugs the top of the next page with matching horizontal extent, they're joined into a single image.
- **Tables keep their header rows.** Rows that got classified as text are absorbed back into the table region by following ink connectivity.
- **Running headers and footers are dropped**, and table-of-contents entries (`Introduction.........12`) are left untranslated — translating a wall of leader dots and page numbers helps nobody.

### The AI proofreads the layout when translation finishes

<img src="docs/screenshots/11-audit.png" width="920" alt="Audit report after translation">

No amount of threshold tuning catches everything. A paragraph gets cropped as an image. A table is split in half by the rows in the middle that were read as text. A figure's boundary stops a few points short. A caption has no figure. What these have in common is that **a human spots them instantly and a rule can't**.

So when translation finishes, an audit pass runs: **the program filters, the model judges.**

1. **The program shortlists suspects.** It pulls the original PDF text underneath every cropped region and measures stopword density, intra-line gaps and math symbols; then it uses the ink projection to see whether unclaimed strokes run right past a figure's edge. On the 85-page paper that shortlists 4 regions; on the 49-page NVIDIA deck, 23. The other hundred-plus crops never reach the model.
2. **The model only answers multiple choice.** Each suspect is cropped and sent to a vision model with a fixed question — *is the subject of this image body text or a figure?*, *are these two halves one table or two unrelated things?* — and a fixed set of answers, returned as JSON. **It is never asked for coordinates.** Vision models routinely report boxes that are off by tens of points; cropping with those makes things worse. Every boundary is computed from ink.
3. **Only confirmed problems get repaired.** Text is restored and queued for translation, split tables are re-cropped as one image, truncated figures grow back along their ink, missing figures are inserted.

Measured on the NVIDIA whitepaper: 23 questions, 21 seconds — 13 paragraphs restored from images, 5 shredded tables reassembled (one of them from 6 pieces and 5 interleaved text rows), 1 truncated figure recovered, graphic blocks down from 71 to 46. On the academic paper it changed exactly one thing, which is the point: there wasn't much to fix, and the model didn't invent work.

Guardrails that exist specifically to avoid making things worse: **a region containing two or more hard math glyphs is never touched** (restore `∂w⋆/∂rˆ` as text and it is gone for good); **a region where most lines have a wide internal gap is treated as a table** (the appendix "acronym / source / description" tables read exactly like prose by every word-level metric — only the column gutter separates them); **two blocks with a caption between them are never merged** (merging makes the caption part of an image, so it would never be translated again).

It can be switched off in settings, and the per-document question budget is capped (default 40). Without a vision model it falls back to the single highest-confidence case and leaves the rest alone.

### Also

- **Four view modes** — translation-first, side-by-side, translation-only, original-only
- **Document library** in IndexedDB; translations are cached, so reopening costs nothing
- **Interruptible** — stop mid-translation, resume later
- **Built-in glossary** — 70+ finance/optimization terms pinned to consistent translations
- **Dark mode** and `Cmd+P` to print (toolbars hide themselves)

<img src="docs/screenshots/10-dark.png" width="920" alt="Dark mode">

## Quick start

```bash
git clone https://github.com/Dustin-uu/paper-lens.git
cd paper-lens
python3 -m http.server 8080
```

Open <http://localhost:8080>, click **设置** (Settings), fill in your API base URL and key, then drop a PDF on the page.

> **Serve it over HTTP — don't double-click `index.html`.** ES modules and the pdf.js worker are blocked by the same-origin policy on `file://`. Any static server works: `npx serve`, nginx, GitHub Pages.

Two requirements for the API:

1. **CORS must be open.** Most official APIs are. Self-hosted gateways need `Access-Control-Allow-Origin`. The *Test connection* button tells you plainly when this is the problem.
2. **Explaining formulas and auditing the layout need a vision model.** If yours can't read images, put `-` in the vision-model field and both degrade gracefully — formula explanations reason from context and say so, and the audit falls back to its one text-only check.

## Measured on an 85-page paper

| | |
|---|---|
| Parsing | 6.1 s (85 pages, in-browser) |
| Translation | ~150 s at 6-way concurrency |
| Blocks | 481 — 39 headings / 200 paragraphs / 28 captions / 32 footnotes / **67 graphics** / 115 references |
| Re-open | instant (cache hit) |

The parser is validated against a PyMuPDF implementation of the same logic: identical graphic count (67), and translatable character counts within 0.8%.

Also verified on a 49-page NVIDIA GPU architecture whitepaper — a completely different typographic system (NVIDIASans instead of Computer Modern, 11pt body, running headers, `Figure1.` captions with no space, bitmap diagrams, cross-page tables). Auto-profiling handles it without touching a single setting: 5.8 s, 103 paragraphs, 31 captions, 71 graphics, 3 cross-page stitches, 65k characters.

## How it works

```
PDF ──► parser.js ──► block sequence + cropped images
                          │
                          ├─► translator.js ──► batched / concurrent / cached
                          ├─► audit.js      ──► shortlist suspects, ask the model, repair
                          ├─► reader.js     ──► render, TOC, highlight, click-to-ask
                          └─► ai.js         ──► context assembly, streamed answers
```

| File | Role |
|---|---|
| `js/parser.js` | PDF → layout blocks + image crops. **The core.** |
| `js/translator.js` | Batching, concurrency, caching, graceful degradation |
| `js/llm.js` | OpenAI-format client with streaming |
| `js/ai.js` | Conversation state, context assembly, formula prompts |
| `js/reader.js` | Rendering, TOC, selection highlighting |
| `js/audit.js` | Post-translation layout audit — suspect filter, model judgement, repairs |
| `js/store.js` | IndexedDB — library, translation cache, original PDF |
| `js/main.js` | State machine and interactions |
| `js/config.js` | Defaults, provider presets, layout params, glossary |

### Notes from the build

Things that cost real time to find:

**Formulas must be cropped, never reconstructed.** See the mangled matrix above. There is no clever parsing that recovers it.

**PDF.js rendering is driven by `requestAnimationFrame`, which browsers freeze in background tabs.** Switch tabs mid-parse and it deadlocks. OffscreenCanvas does not help — the freeze is on the scheduler, not the canvas. Swapping rAF for `setTimeout` during parsing fixes it and removes the 60fps ceiling as a bonus.

**Vector strokes are what hold a figure together, and they aren't in the text stream.** Axis lines, plot curves, fraction bars, radicals, matrix brackets — `getTextContent()` returns none of them. Cluster only by text-fragment spacing and a line chart shatters into horizontal bands (one figure here broke into 4 pieces with 66/21/16pt gaps). Parsing `getOperatorList()` means reimplementing the graphics state stack, so instead: **look at the rendered pixels**. Downscale the page to 72dpi once, compute a per-row ink projection, and merge two fragments when the gap between them has no text but does have ink.

> Don't sample `getImageData` per-region on the 200dpi canvas — that took 85 pages from 5s to 80s. One downscaled pass, computed lazily, is 11s.

**IndexedDB returns `undefined` for a miss**, so `result !== undefined` is not a valid "did we get a value" check — it returns the `IDBRequest` object itself and every block looks like a cache hit on first run.

**Body text and references have opposite indent semantics.** Paragraphs indent the first line; bibliography entries hang it. The same x-offset means opposite things, so block segmentation has to infer which style it's looking at from the second line.

**Hardcoding layout thresholds does not survive contact with a second document.** The defaults were tuned on a LaTeX paper: 12pt body, margin at x=72, bold detected by `CMBX` in the font name. An NVIDIA whitepaper breaks every one of those — 11pt body, margin at x=54, `NVIDIASans-Bold`. The body-size window alone was enough to misclassify the entire document as images. The fix is to sample a dozen pages up front and learn the modal body size, the left margin, and the deepest body indent from the x-histogram. On the original LaTeX paper the learned values come out at 12pt / x=72 / x0Max=97 — essentially identical to the hand-tuned constants, which is a good sign the statistics are sound.

**Running headers poison block segmentation.** Academic papers don't have them; commercial documents do. A repeated header line merges into the first paragraph, the block's attributes go incoherent, and the whole thing gets screenshotted. Detect them during profiling — normalize page numbers to `#`, and blacklist edge lines that repeat across sampled pages — then drop them at the *line* level, before blocks are formed.

**A 2pt threshold cost four regressions.** LaTeX indents the first line of a paragraph to x=90; the "starts at margin" cutoff was 88. Single-line paragraphs and bulleted lists — the cases where a block's min-x *is* the indent — got classified as graphics and screenshotted as images.

**PNG encoding does not scale.** Cropping is cheap; `convertToBlob({type:'image/png'})` is not — it was 70 of the 80 seconds spent parsing an 85-page paper. WebP at q=0.92 is visually identical on screenshots, several times faster, and halves the output size.

**Then WebP became the bottleneck too, because it was awaited one crop at a time.** `convertToBlob` does its work off the main thread, so `await`-ing each crop in turn is pure queueing: 20 crops took 1022 ms serially and 359 ms in parallel. The catch is that a single shared scratch canvas *forces* serialization — you can't draw the next crop until the current one has finished encoding. Giving each crop its own canvas and flushing in batches (capped by both count and total pixels, since one full-page figure is tens of megabytes) cut parsing roughly in half: 12.1 s → 6.1 s on the 85-page paper, 10.8 s → 5.8 s on the NVIDIA deck, with byte-identical output. Issuing `getTextContent()` before awaiting the render, rather than after, is worth another ~40 ms per page for free.

**Extract LaTeX before running Markdown.** `**` and `_` will happily eat `\frac{}{}` and `\sum_{i=1}^{N}`. Stash the math, convert, then substitute back.

**Never set `white-space: normal` on KaTeX.** Its layout is absolutely positioned; allow wrapping and the right half of the equation vanishes. Scale oversized formulas with `transform` instead.

**A running header that changes every few pages ends up as a picture.** The header blacklist works by normalising page numbers and keeping edge lines that repeat across sampled pages — which by construction cannot catch `Introduction` / `DLSS 4` / `APPENDIX A: …`, since each one appears on only two or three pages. And a short right-aligned 9pt line matches no body, heading or footnote rule, so it falls all the way through `classify()` to `graphic` and gets cropped. Sixteen of this whitepaper's 86 "figures" were section headers rendered as white cards in the middle of the text. The fix keys on shape rather than text — inside the margin band, single line, short, not wide — and, crucially, records the dropped box so `findFigureRegions` doesn't immediately re-crop the now-unclaimed ink.

**Pairwise adjacency cannot reassemble a shredded table.** A long spec table lands on the page as a dozen alternating strips — image, row-of-text, image, row-of-text. Checking neighbours a pair at a time means any single threshold that rejects one pair breaks the chain there and leaves the rest in pieces; on one page the rejections came from three different rules (both strips under the 50pt height floor, a 102pt gap, and the word `Edition` in between). Sweeping instead — start at an image and keep absorbing downward until you hit a hard boundary — put all six pieces and the five text rows between them into a single question.

**`Edition` and `TGP` are table cells, not section headings.** They are short and bold, so `classify()` calls them headings, and treating every heading as a hard boundary meant the table could never be reassembled. Only a heading at the document's own heading size counts as a boundary; one at body size inside a table's horizontal span is a cell.

**Ask the question you actually need answered.** The split check first asked the model "is this one table or two unrelated things?". For a Table 3 made of two side-by-side sub-tables, "two" is a perfectly defensible answer — and it left the table shredded into strips. What the repair actually needs to know is different: *would merging this into one image swallow any translatable body text?* Rephrased that way the same model answers "one" on the same image, and the table comes back whole.

**Blocks that overlap are not blocks that sit between.** The rows caught between two crops are usually sliced *through* — the top half of the glyphs stays in the image above, the bottom half becomes a text block. Looking for text "fully inside the gap" finds nothing at all, so merging leaves those half-rows dangling between the pieces. Overlap, not containment, is the right test.

**Asking a model for coordinates does not work.** The first attempt at the audit sent whole pages to a vision model and asked where a figure's real boundary was. The boxes came back tens of points off, and cropping to them made things worse. It only became reliable once the model was restricted to **judgement questions** — *body text or figure?*, *one table or two?* — with every coordinate computed from the ink projection. The model decides *what*; the program decides *where*.

**Stopword density cannot tell an appendix table from prose.** A three-column "Abnormal accruals — Xie (2001) — Abnormal Accruals" table has all the *of / and / to* you could want; letter ratio, sentence punctuation and math-symbol counts all say prose. The one signal that works is the **intra-line gap**: a column gutter is tens of points, a word space is a few. Adding that check took the 85-page paper from 24 suspects to 4.

## Limitations

- **Two-column PDFs are not supported by default.** Blocks sort by y-coordinate, so columns interleave — on a page with a sidebar you'll see the two columns spliced line by line. There *is* a detector (`detectColumnZone`, enable with `detectColumns: true`) and it fixes such pages, but it also mistakes the gap between table columns for a column gutter: on one academic paper it misfired on 22 pages and inflated the translatable text by 19%. Off by default until it can tell a table apart from a gutter.
- **Scanned PDFs need OCR first** — this reads the text layer, it does not do OCR.
- Auto-profiling assumes a single dominant body style. Documents that mix wildly different layouts across sections may still need a manual pass through the layout settings.
- One known cosmetic issue: an inline fraction inside a footnote can get cropped as a wide thin strip.

## Contributing

Issues and PRs welcome. If a PDF parses badly, attaching it (or a page of it) helps enormously — nearly every rule in `parser.js` came from a concrete failure.

## License

MIT. Bundled dependencies keep their own licenses — see [`vendor/README.md`](vendor/README.md).
