// 解析引擎（模型版）：整页交给文档解析模型读，程序只负责裁像素。
//
// 为什么要有这一版：本地那版（parser.js）没有"看"的能力，只能从字符坐标倒推版面 ——
// 字号在不在正文区间、左边界够不够顶格、行距超没超阈值。每条规则最后都落在一个
// 几何比较上，换一份文档就整页掉进"截成图"：某篇论文摘要宽 325pt 而阈值是 350，
// 整个摘要变成一张 571pt 高的图片。用几何去猜语义，天花板就在那儿。
//
// 这一版把分工倒过来：
//   模型负责"读"  —— 正文、标题、表格结构、阅读顺序（双栏也对）、公式 LaTeX
//   程序负责"裁"  —— 插图、公式、表格仍按原坐标截像素，零失真
// 之所以不让模型也接管图片，是实测的结论：一张折线图它当作不存在，一张多面板图
// 它去 OCR 每个坐标轴标注直到撞上 token 上限然后开始复读。图形定位必须留给墨迹。
//
// PDF.js 在这一版里仍然有用，只是换了用途：它给的**位置**是可靠的（字符坐标不会错），
// 不可靠的是**顺序**（双栏会左右交错）。所以位置用它的，顺序用模型的。

import { initPdfjs, withUnthrottledRaf } from './parser.js';
import { inkFrom, coverMap, freeInkRuns2D, growToInk } from './ink.js';
import * as docvl from './docvl.js';

const CAPTION_RE = /^(Table|Figure|Fig|Panel|Chart|Exhibit)\s*\.?\s*[A-Z]?\.?\s*\d+/i;
const norm = t => String(t).toLowerCase().replace(/[^a-z0-9]/g, '');

// ---------- 模型输出 -> 块 ----------

// 把模型给的 markdown 切成块。它的输出形态实测有三种：普通段落、markdown 标题、
// 管道行表格（OTSL 已在 docvl 里翻过一道），以及 \[ \] / $$ 包起来的公式。
export function splitMarkdown(md) {
  const out = [];
  const lines = String(md).replace(/\r/g, '').split('\n');
  let buf = [], mode = 'para';

  const flush = () => {
    const text = buf.join('\n').trim();
    buf = [];
    if (!text) return;
    let kind = mode;
    if (kind === 'para') {
      if (/^#{1,6}\s/.test(text)) kind = 'heading';
      else if (CAPTION_RE.test(text)) kind = 'caption';
    }
    out.push({ kind, text: text.replace(/^#{1,6}\s*/, '').trim(), raw: text });
    mode = 'para';
  };

  let inMath = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    // 公式块：\[ … \] 或 $$ … $$，可能跨行
    if (!inMath && /^\s*(\\\[|\$\$)/.test(line)) {
      flush(); inMath = true; mode = 'math'; buf.push(line);
      if (/(\\\]|\$\$)\s*$/.test(line.replace(/^\s*(\\\[|\$\$)/, ''))) { inMath = false; flush(); }
      continue;
    }
    if (inMath) {
      buf.push(line);
      if (/(\\\]|\$\$)\s*$/.test(line)) { inMath = false; flush(); }
      continue;
    }
    // 表格：连续的管道行
    const isRow = /\|/.test(line) && line.split('|').length >= 3;
    if (isRow) {
      if (mode !== 'table') { flush(); mode = 'table'; }
      buf.push(line);
      continue;
    }
    if (mode === 'table') flush();
    if (!line.trim()) { flush(); continue; }
    if (/^#{1,6}\s/.test(line)) { flush(); buf.push(line); flush(); continue; }
    buf.push(line);
  }
  if (inMath) { inMath = false; }
  flush();
  return out;
}

// ---------- PDF 文本层 -> 行（只取位置，不取顺序） ----------

export function pageLines(pdfjs, items, viewport) {
  const rows = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const tx = pdfjs.Util.transform(viewport.transform, it.transform);
    const size = Math.hypot(tx[2], tx[3]);
    const x0 = tx[4], y = tx[5];
    const last = rows[rows.length - 1];
    const rec = { str: it.str, x0, x1: x0 + (it.width || 0), y, size };
    if (last && Math.abs(y - last.y) <= Math.max(2.5, size * 0.6)) last.parts.push(rec);
    else rows.push({ y, parts: [rec] });
  }
  return rows.map(r => {
    const ps = r.parts.sort((a, b) => a.x0 - b.x0);
    const size = ps[0].size;
    const text = ps.map(p => p.str).join('').replace(/\s+/g, ' ').trim();
    return {
      text, norm: norm(text), size,
      x0: Math.min(...ps.map(p => p.x0)), x1: Math.max(...ps.map(p => p.x1)),
      yTop: r.y - size * 0.85, yBot: r.y + size * 0.3,
    };
  }).filter(r => r.text).sort((a, b) => a.yTop - b.yTop);
}

// ---------- 把模型的块锚回页面坐标 ----------
//
// 模型只给内容和顺序，不给坐标；PDF 文本层只给坐标，顺序不可靠。两边按**文字内容**
// 对上，就同时拿到了正确顺序和真实坐标。
// 做法是逐行认领：每一行去找"哪个块的正文里包含这一行的字"。双栏页上这一步天然正确 ——
// 左栏第 5 行的字只会出现在左栏那个块里，跟它在页面上的 y 排第几毫无关系。
export function anchorBlocks(blocks, lines) {
  const bn = blocks.map(b => norm(b.text));
  const taken = new Array(blocks.length).fill(null).map(() => []);
  let cursor = 0;                       // 顺序提示：同样匹配时优先靠近上一次命中的块

  for (const ln of lines) {
    if (ln.norm.length < 4) continue;
    const probe = ln.norm.slice(0, Math.min(40, ln.norm.length));
    let best = -1, bestDist = Infinity;
    for (let i = 0; i < bn.length; i++) {
      if (!bn[i].includes(probe)) continue;
      const dist = Math.abs(i - cursor);
      if (dist < bestDist) { best = i; bestDist = dist; }
    }
    if (best < 0) continue;
    taken[best].push(ln);
    cursor = best;
  }

  return blocks.map((b, i) => {
    const ls = taken[i];
    if (!ls.length) return { ...b, bbox: null, lines: [] };
    return {
      ...b,
      lines: ls,
      bbox: [Math.min(...ls.map(l => l.x0)), Math.min(...ls.map(l => l.yTop)),
             Math.max(...ls.map(l => l.x1)), Math.max(...ls.map(l => l.yBot))],
      size: Math.round(ls[0].size * 10) / 10,
    };
  });
}

// ---------- 图形区 ----------

// 合并靠得很近的墨迹带：一张带坐标轴标注的折线图，标注行被文本层认领了，
// 剩下的绘图区就被切成好几条。间距小于阈值就并回一张。
function mergeRuns(runs, maxGap) {
  if (!runs.length) return [];
  const s = [...runs].sort((a, b) => a[1] - b[1]);
  const out = [s[0].slice()];
  for (let i = 1; i < s.length; i++) {
    const prev = out[out.length - 1], cur = s[i];
    if (cur[1] - prev[3] <= maxGap) {
      prev[0] = Math.min(prev[0], cur[0]); prev[2] = Math.max(prev[2], cur[2]);
      prev[3] = Math.max(prev[3], cur[3]);
    } else out.push(cur.slice());
  }
  return out;
}

function overlapY(a, b) {
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return h <= 0 ? 0 : h / Math.max(1, b[3] - b[1]);
}

// 页眉页脚：只看形状不看内容 —— 分节页眉每隔几页就换一次，靠"跨页重复"的黑名单
// 按定义抓不住它们。落在页边带里、单行、短，那就是页眉。
function isMarginLabel(b, pageH, pageW) {
  if (!b.bbox || (b.lines || []).length !== 1) return false;
  if ((b.text || '').length > 60) return false;
  if (b.bbox[2] - b.bbox[0] > pageW * 0.6) return false;
  return b.bbox[1] < pageH * 0.09 || b.bbox[3] > pageH * 0.91;
}

// 页眉横幅和分隔线不是插图。
// 有的模板每页顶上压一条通栏色带（白字 logo 那种），墨迹满、文字少，
// 按"有墨迹没人认领"的规则必然被当成插图截出来 —— 而且模型还会去猜那个 logo 上
// 写的是什么，实测把 arXiv 的标记读成了 "ALIENS ON EARTH"。
// 判据同样只看形状：贴着页边、通栏；或者又扁又长的横线。
function isBanner(f, pageH, pageW) {
  const w = f[2] - f[0], h = f[3] - f[1];
  if (w > pageW * 0.7 && (f[3] < pageH * 0.10 || f[1] > pageH * 0.90)) return true;
  return h < 6 && w > pageW * 0.6;
}

// ---------- 主流程 ----------

const PREVIEW_DPI = 144;      // 发给模型的整页图。实测这个分辨率够认，再高只是多花 token
const PREVIEW_W = 1500;

export function parsePdfVL(file, layout, cfg, onProgress, maxPages) {
  return withUnthrottledRaf(() => run(file, layout, cfg, onProgress, maxPages));
}

async function run(file, layout, cfg, onProgress, maxPages) {
  if (!docvl.configured(cfg)) throw new Error('没有配置文档解析模型，无法使用模型解析引擎。');
  const pdfjs = await initPdfjs();
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const last = Math.min(doc.numPages, maxPages || doc.numPages);
  const scale = (layout.dpi || 200) / 72;

  const OC = typeof OffscreenCanvas !== 'undefined';
  const mk = (w, h) => OC ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const toBlob = (c, t, q) => OC ? c.convertToBlob({ type: t, quality: q })
    : new Promise(r => c.toBlob(r, t, q));
  const IMG_T = layout.imageType || 'image/webp';
  const IMG_Q = layout.imageQuality ?? 0.92;

  const cv = mk(8, 8);
  const ctx = cv.getContext('2d', { willReadFrequently: true });

  // ---- 第一遍（串行，快）：渲染、取文本层、算墨迹、生成发给模型的整页图 ----
  const pages = [];
  for (let pno = 1; pno <= last; pno++) {
    const page = await doc.getPage(pno);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale });
    cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
    const tcP = page.getTextContent();
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const tc = await tcP;

    const lines = pageLines(pdfjs, tc.items, vp1);
    const ink = inkFrom(cv, vp1.width, vp1.height, mk);

    const pw = Math.round(vp1.width * PREVIEW_DPI / 72);
    const k = pw > PREVIEW_W ? PREVIEW_W / pw : 1;
    const sw = Math.max(8, Math.round(pw * k));
    const sh = Math.max(8, Math.round(vp1.height * PREVIEW_DPI / 72 * k));
    const pv = mk(sw, sh);
    pv.width = sw; pv.height = sh;
    const pctx = pv.getContext('2d');
    pctx.fillStyle = '#fff'; pctx.fillRect(0, 0, sw, sh);
    pctx.drawImage(cv, 0, 0, sw, sh);

    // 发给模型之前，把页眉色带涂白。
    // 有的模板每页顶上压一条黑色通栏，里面是白字和一个小 logo。模型会认真去猜那个
    // logo 上写了什么 —— 实测把 arXiv 的角标读成了 "ALIENS ON EARTH"，还因为它出现在
    // 第一页最上面，直接当上了全文标题。与其事后擦屁股，不如根本不给它看。
    const banners = mergeRuns(freeInkRuns2D(ink, [], 8), 6)
      .filter(f => isBanner(f, vp1.height, vp1.width));
    const k2 = sw / vp1.width;
    pctx.fillStyle = '#fff';
    for (const f of banners) {
      pctx.fillRect(Math.floor(f[0] * k2), Math.floor(f[1] * k2),
                    Math.ceil((f[2] - f[0]) * k2), Math.ceil((f[3] - f[1]) * k2));
    }

    pages.push({ pno, w: vp1.width, h: vp1.height, lines, ink, banners,
                 preview: await toBlob(pv, 'image/webp', 0.9) });
    page.cleanup();
    onProgress?.(pno, last, '正在渲染页面');
  }

  // ---- 第二遍（并发，慢）：整页交给模型读 ----
  let done = 0;
  const parsed = await docvl.pool(pages, Math.min(6, cfg.concurrency || 6), async (p) => {
    const pdfText = p.lines.map(l => l.text).join(' ');
    const r = await docvl.recognize(cfg, p.preview, pdfText, { maxTokens: 4000 });
    onProgress?.(++done, pages.length, '模型正在读页面');
    return r;
  });

  return assemble(pages, parsed, { mk, toBlob, IMG_T, IMG_Q, scale, layout, pdfjs, doc, cfg });
}

// ---------- 第三遍：定图形区、裁像素、按模型顺序组装 ----------

// 模型只给内容和顺序，不给层级 —— 它的输出里没有 markdown 标题标记。
// 但标题这件事上几何是可靠的：字号比正文大一截，或者"编号 + 很短"。
// 而且判错的代价很轻（标题变成普通段落），不像"正文判成图"那样会丢内容。
function bodySizeOf(pages) {
  const hist = new Map();
  for (const p of pages) for (const l of p.lines) {
    const k = Math.round(l.size * 2) / 2;
    hist.set(k, (hist.get(k) || 0) + l.text.length);
  }
  let best = 12, n = -1;
  for (const [k, v] of hist) if (v > n) { n = v; best = k; }
  return best;
}

const HEAD_NUM_RE = /^(?:[A-Z]\.)?\d+(?:\.\d+)*\.?\s*[A-Za-z]/;

function headingLevel(b, bodySize) {
  if (!b.bbox || !b.size) return 0;
  const words = b.text.split(/\s+/).length;
  if (b.text.length > 120 || words > 18) return 0;
  if (b.lines.length > 3) return 0;
  if (b.size >= bodySize + 4) return 1;
  if (b.size >= bodySize + 1.6) return 2;
  // 与正文同字号的编号小标题（3.1 Latent Regime Structure）
  if (b.size >= bodySize - 0.4 && HEAD_NUM_RE.test(b.text) && words <= 12) return 3;
  return 0;
}

const TEXT_KINDS = new Set(['para', 'heading', 'caption', 'note']);

async function assemble(pages, parsed, env) {
  const { mk, toBlob, IMG_T, IMG_Q, scale, layout, doc } = env;
  const bodySize = bodySizeOf(pages);
  const minFigH = layout.minFigureH || 40;
  const out = [];
  const cv = mk(8, 8);
  const ctx = cv.getContext('2d');
  let rendered = -1;

  // 需要裁图时才把这一页重新渲染成高分辨率。多数页没有图，能省掉一大半渲染。
  const ensurePage = async (p) => {
    if (rendered === p.pno) return;
    const page = await doc.getPage(p.pno);
    const vp = page.getViewport({ scale });
    cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    page.cleanup();
    rendered = p.pno;
  };
  const crop = async (p, bb) => {
    await ensurePage(p);
    const w = Math.max(4, Math.round((bb[2] - bb[0]) * scale));
    const h = Math.max(4, Math.round((bb[3] - bb[1]) * scale));
    const c = mk(w, h); c.width = w; c.height = h;
    const cc = c.getContext('2d');
    cc.fillStyle = '#fff'; cc.fillRect(0, 0, w, h);
    cc.drawImage(cv, Math.round(bb[0] * scale), Math.round(bb[1] * scale), w, h, 0, 0, w, h);
    return { blob: await toBlob(c, IMG_T, IMG_Q),
             w: Math.round(bb[2] - bb[0]), h: Math.round(bb[3] - bb[1]) };
  };

  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const r = parsed[i] || {};
    const pageIdx = p.pno - 1;

    // 模型这一页没读成 —— 退回按 y 分组的粗糙做法，内容不能丢，但标记出来
    if (!r.text) {
      for (const b of fallbackBlocks(p.lines)) {
        out.push({ ...b, page: pageIdx, fallback: true, reason: r.why || '模型未返回' });
      }
      continue;
    }

    // 压在页眉色带上的白字（还有模型对着色带里的 logo 猜出来的东西）不是正文。
    // 实测它把 arXiv 的角标读成了 "ALIENS ON EARTH"，还因为字号大当上了全文标题。
    const inBanner = bb => bb && (p.banners || []).some(f => overlapY(f, bb) > 0.5);
    // 页眉色带里的那行白字必须在锚定之前就剔掉。
    // 它往往是书名／章节名，而正文标题里恰好也含这几个词 —— 锚定按文字内容认领，
    // 于是页眉那一行被认到标题块上，标题凭空多出一行，再因为"超过两行"被判成普通段落，
    // 最后整个阅读器顶上顶着作者名当标题。
    const usable = p.lines.filter(l => !inBanner([l.x0, l.yTop, l.x1, l.yBot]));

    let blocks = anchorBlocks(splitMarkdown(r.text), usable)
      .filter(b => b.text && !isMarginLabel(b, p.h, p.w) && !inBanner(b.bbox));
    for (const b of blocks) {
      if (b.kind !== 'para') continue;
      if (CAPTION_RE.test(b.text)) { b.kind = 'caption'; continue; }
      const lv = headingLevel(b, bodySize);
      if (lv) { b.kind = 'heading'; b.level = lv; }
      else if (b.size && b.size <= bodySize - 1.2) b.kind = 'note';
    }

    // 图形区：有墨迹、却没有任何文本行认领的连续带。标注行会把一张图切成几条，
    // 所以近的要并回去。
    const textBoxes = p.lines.map(l => [l.x0, l.yTop, l.x1, l.yBot]);
    let figs = mergeRuns(freeInkRuns2D(p.ink, textBoxes, Math.min(minFigH, 24)),
                         layout.inkBridgeMax != null ? Math.min(layout.inkBridgeMax, 60) : 40)
      .filter(f => f[3] - f[1] >= minFigH)
      .filter(f => !isBanner(f, p.h, p.w));

    // 图里的标注文字（坐标轴刻度、图例）会被模型当成正文吐出来。谁落在图形区里，
    // 就并进那张图，别让它以段落的身份出现在译文里。
    const absorbed = new Set();
    for (const f of figs) {
      for (const b of blocks) {
        if (!b.bbox || absorbed.has(b) || b.kind === 'caption') continue;
        if (overlapY(f, b.bbox) > 0.6) { absorbed.add(b); f[0] = Math.min(f[0], b.bbox[0]); f[2] = Math.max(f[2], b.bbox[2]); }
      }
    }
    const figNotes = figs.map(f => [...blocks].filter(b => absorbed.has(b) && overlapY(f, b.bbox) > 0.6)
                                              .map(b => b.text).join('\n'));
    blocks = blocks.filter(b => !absorbed.has(b));

    // 公式和表格：模型已经给了 LaTeX / 表格行，但实测它会认错下标、把 nm 认成 Hm，
    // 所以正文里仍然放原始截图（零失真），识别结果只作附注给 AI 侧栏用。
    const items = [];
    for (const b of blocks) {
      const asImage = (b.kind === 'math' || b.kind === 'table') && b.bbox;
      if (!asImage) {
        // 锚不到坐标就截不了图。公式保持 math 这个 kind 交给 KaTeX 渲染
        // （顺带也就不会被送去翻译 —— 一段纯 LaTeX 没什么好翻的）；
        // 表格则退回普通文字，至少内容还在。
        const kind = b.kind === 'math' ? 'math' : (b.kind === 'table' ? 'para' : b.kind);
        items.push({ y: b.bbox ? b.bbox[1] : null, blk: {
          kind, text: b.text, page: pageIdx, bbox: b.bbox || undefined,
          size: b.size || bodySize } });
        continue;
      }
      const bb = growToInk(p.ink, coverMap(p.ink, blocks.filter(x => x !== b && x.bbox)
        .map(x => [x.bbox[0], x.bbox[1], x.bbox[2], x.bbox[3]])), b.bbox, 10);
      const img = await crop(p, bb);
      items.push({ y: bb[1], blk: { kind: 'graphic', text: '', page: pageIdx, bbox: bb,
                                    blob: img.blob, w: img.w, h: img.h, ocr: b.text } });
    }

    // 插图按 y 插进模型给的顺序里：找到它上方最近的那个块，插在其后。
    for (let fi = 0; fi < figs.length; fi++) {
      const f = figs[fi];
      const img = await crop(p, f);
      const blk = { kind: 'graphic', text: '', page: pageIdx, bbox: f,
                    blob: img.blob, w: img.w, h: img.h };
      if (figNotes[fi]) blk.ocr = figNotes[fi];
      let at = items.length;
      for (let k = 0; k < items.length; k++) {
        if (items[k].y != null && items[k].y > f[1]) { at = k; break; }
      }
      items.splice(at, 0, { y: f[1], blk });
    }

    out.push(...items.map(x => x.blk));
    env.onPage?.(i + 1, pages.length);
  }

  return finalize(out);
}

// 模型没读成时的兜底：按行距分段。顺序按 y，双栏会错，但总比丢内容强。
function fallbackBlocks(lines) {
  const out = [];
  let cur = null;
  for (const l of lines) {
    const gap = cur ? l.yTop - cur.bbox[3] : 0;
    if (cur && gap < Math.max(4, l.size * 0.9) && Math.abs(l.x0 - cur.bbox[0]) < 30) {
      cur.text += (cur.text.endsWith('-') ? '' : ' ') + l.text;
      cur.bbox[2] = Math.max(cur.bbox[2], l.x1); cur.bbox[3] = l.yBot;
    } else {
      cur = { kind: 'para', text: l.text, size: Math.round(l.size * 10) / 10,
              bbox: [l.x0, l.yTop, l.x1, l.yBot] };
      out.push(cur);
    }
  }
  return out;
}

const PAGENO_RE = /^[ivxlcdm]{1,7}$|^\d{1,4}$/i;

function finalize(blocks) {
  // 参考文献整段保留原文。翻译一整页文献条目既费钱又没人看，
  // 本地引擎一直是这么做的，模型引擎不能把这条丢了 —— 实测这一篇的待译字符
  // 会因此凭空多出两万多。
  const rs = blocks.findIndex(b => b.kind === 'heading'
    && /^(references|bibliography|参考文献)\b/i.test(String(b.text).trim()));
  if (rs >= 0) {
    let end = blocks.length;
    for (let i = rs + 1; i < blocks.length; i++) {
      if (blocks[i].kind === 'heading' && (blocks[i].size || 0) >= (blocks[rs].size || 12) - 0.4) {
        end = i; break;
      }
    }
    for (let i = rs + 1; i < end; i++) {
      if (blocks[i].kind === 'para' || blocks[i].kind === 'note') blocks[i].kind = 'ref';
    }
  }
  // 首页那几行作者署名不翻译
  for (let i = 0; i < Math.min(8, blocks.length); i++) {
    const b = blocks[i];
    if (b.kind === 'heading' && (String(b.text).match(/,/g) || []).length >= 3) b.kind = 'ref';
  }

  const kept = [];
  for (const b of blocks) {
    if (b.kind !== 'graphic' && !String(b.text || '').trim()) continue;
    // 孤零零的页码
    if (b.kind !== 'graphic' && PAGENO_RE.test(String(b.text).trim())) continue;
    // 跨页续段：上一段没有句末标点、这一段小写开头，接回去
    const prev = kept[kept.length - 1];
    if (prev && prev.kind === 'para' && b.kind === 'para' && prev.page !== b.page
        && /^[a-z(,;]/.test(b.text) && !/[.!?:;)"”]\s*$/.test(prev.text)) {
      prev.text = prev.text.replace(/\s+$/, '') + ' ' + b.text;
      continue;
    }
    kept.push(b);
  }
  kept.forEach((b, i) => { b.id = i; });
  return kept;
}
