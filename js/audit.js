// 译后自检：程序先挑出可疑的图块，再让 AI 逐块判断，最后按判断结果改版面。
//
// 两条硬约束：
//   1. 先程序筛后 AI 判。整篇几十上百张图全发给模型既贵又慢，绝大多数还没问题。
//   2. 只问判断题（"这是正文还是图表""这两半是不是一张表"），绝不让模型报坐标。
//      视觉模型给的框普遍偏几十个点，拿它去裁图只会越修越坏。坐标一律由墨迹算。

import { initPdfjs, withUnthrottledRaf } from './parser.js';
import { chat, blobToDataUrl } from './llm.js';

const INK_S = 0.5;                 // 墨迹检测分辨率（相对 72dpi），与 parser 保持一致
const CAPTION_RE = /^(Table|Figure|Fig|Panel|Chart|Exhibit)\s*\.?\s*[A-Z]?\.?\s*\d+/i;
const STOP = new Set(['the', 'of', 'a', 'an', 'is', 'are', 'was', 'were', 'we', 'in', 'to',
  'for', 'that', 'with', 'and', 'this', 'be', 'as', 'by', 'on', 'it', 'not', 'our', 'their',
  'which', 'can', 'from', 'at', 'or', 'has', 'have', 'these', 'those', 'but', 'more', 'than',
  'when', 'if', 'also', 'each', 'may', 'such', 'both', 'into', 'they', 'its', 'because']);
const MATH_CH = /[=+×÷±∑∏∫√≤≥≠≈∈∀∃∂∇⊤⋆λθσμαβγδεπρτφψΩΛΦΓΔ^_{}\\]/g;
// 这些字符只会出现在公式里。哪怕只有两个，也说明这块图里裹着一条行内公式 ——
// 而公式一旦被还原成文字就彻底毁了（∂w⋆/∂rˆ 会变成一串乱码），所以宁可放过不可错杀。
const HARD_MATH = /[∂∑∏∫√⋆⊤∈∀∃≤≥≠≈∇⊙⊗⌊⌋⌈⌉ˆ˜λθσμαβγδεπρτφψωΩΛΦΨΓΔ]/g;
const hardMath = t => (String(t).match(HARD_MATH) || []).length;

// ---------- 文本统计 ----------

function metrics(txt) {
  const solid = txt.replace(/\s/g, '');
  const n = solid.length || 1;
  const letters = (solid.match(/[A-Za-z]/g) || []).length;
  const digits = (solid.match(/\d/g) || []).length;
  const math = (solid.match(MATH_CH) || []).length;
  const words = txt.toLowerCase().match(/[a-z][a-z'-]+/g) || [];
  let stops = 0;
  for (const w of words) if (STOP.has(w)) stops++;
  return {
    len: n, words: words.length, stops,
    letter: letters / n, digit: digits / n, math: math / n,
    ends: (txt.match(/[.!?](\s|$)/g) || []).length,
  };
}

// 连贯英文散文：字母占比高、虚词多、数学符号少、有句末标点
function isProse(txt) {
  const m = metrics(txt);
  return m.words >= 12 && m.letter > 0.6 && m.stops >= 3 && m.math < 0.05 && m.digit < 0.2;
}

// ---------- 原始 PDF 取词 ----------

// 打开留底的 PDF，按页缓存文字与视口。渲染很贵，能不渲染就不渲染。
async function openSource(blob) {
  const pdfjs = await initPdfjs();
  const buf = await blob.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buf }).promise;
  const cache = new Map();
  const OC = typeof OffscreenCanvas !== 'undefined';
  const mk = (w, h) => OC ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const toBlob = (c, t, q) => OC ? c.convertToBlob({ type: t, quality: q })
    : new Promise(r => c.toBlob(r, t, q));

  async function get(pno) {
    if (cache.has(pno)) return cache.get(pno);
    const page = await pdf.getPage(pno + 1);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const tx = pdfjs.Util.transform(vp.transform, it.transform);
      const size = Math.hypot(tx[2], tx[3]);
      const x0 = tx[4];
      items.push({ str: it.str, size, x0, x1: x0 + (it.width || 0), y: tx[5] });
    }
    const e = { page, vp, items, ink: null, hi: null, hiScale: 0 };
    cache.set(pno, e);
    return e;
  }

  return { pdf, get, mk, toBlob, close: () => pdf.destroy().catch(() => {}) };
}

function itemsIn(items, bb, padY = 2, padX = 8) {
  return items.filter(it => it.y >= bb[1] - padY && it.y <= bb[3] + padY
                         && it.x1 > bb[0] - padX && it.x0 < bb[2] + padX);
}

// 把字符碎片还原成行，再拼成一段。PDF 里换行处的连字符要接回去。
function linesOf(its) {
  const rows = [];
  for (const it of [...its].sort((a, b) => a.y - b.y || a.x0 - b.x0)) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(it.y - last.y) <= Math.max(2.5, it.size * 0.6)) last.parts.push(it);
    else rows.push({ y: it.y, parts: [it] });
  }
  return rows.map(r => {
    const ps = r.parts.sort((a, b) => a.x0 - b.x0);
    // 行内最大空档。表格的列缝有十几到几十 pt，正文的词距顶多几 pt，
    // 这是"这块到底是段落还是表"最干脆的判据。
    let gap = 0;
    for (let i = 1; i < ps.length; i++) gap = Math.max(gap, ps[i].x0 - ps[i - 1].x1);
    return {
      y: r.y, gap,
      x0: ps[0].x0, x1: Math.max(...ps.map(p => p.x1)),
      size: ps[0].size,
      text: ps.map(p => p.str).join('').replace(/\s+/g, ' ').trim(),
    };
  }).filter(r => r.text);
}

function joinLines(ls) {
  let out = '';
  for (const l of ls) {
    if (!out) { out = l.text; continue; }
    if (/[-‐‑–]$/.test(out)) out = out.slice(0, -1) + l.text;
    else out += ' ' + l.text;
  }
  return out.replace(/\s+/g, ' ').trim();
}

// ---------- 墨迹 ----------

// 36dpi 重渲一遍只为拿逐行墨迹投影。比按区域在高分辨率画布上取像素快一个量级。
async function inkOf(e, mk) {
  if (e.ink) return e.ink;
  const W = Math.ceil(e.vp.width * INK_S), H = Math.ceil(e.vp.height * INK_S);
  const cv = mk(W, H);
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  await e.page.render({ canvasContext: ctx, viewport: e.page.getViewport({ scale: INK_S }) }).promise;
  const d = ctx.getImageData(0, 0, W, H).data;
  const rows = new Uint8Array(H);
  const minX = new Int16Array(H).fill(-1);
  const maxX = new Int16Array(H).fill(-1);
  for (let y = 0; y < H; y++) {
    const base = y * W * 4;
    let mn = -1, mx = -1;
    for (let x = 0; x < W; x++) {
      const i = base + x * 4;
      if (d[i] < 248 || d[i + 1] < 248 || d[i + 2] < 248) { if (mn < 0) mn = x; mx = x; }
    }
    rows[y] = mn >= 0 ? 1 : 0; minX[y] = mn; maxX[y] = mx;
  }
  e.ink = { rows, minX, maxX, W, H, s: INK_S };
  return e.ink;
}

// 哪些行已被别的块占住 —— 用来判断某段墨迹是不是"没人认领"的
function coverMap(ink, boxes) {
  const c = new Uint8Array(ink.H);
  for (const bb of boxes) {
    const a = Math.max(0, Math.floor(bb[1] * ink.s) - 1);
    const b = Math.min(ink.H - 1, Math.ceil(bb[3] * ink.s) + 1);
    for (let y = a; y <= b; y++) c[y] = 1;
  }
  return c;
}

// ---------- 截图 ----------

// maxW：给 AI 看的预览图限宽，避免把 200dpi 的整页大图塞进请求里
async function cropAt(e, bb, dpi, mk, toBlob, type, q, maxW) {
  const scale = dpi / 72;
  if (!e.hi || e.hiScale !== scale) {
    const vp = e.page.getViewport({ scale });
    const cv = mk(Math.ceil(vp.width), Math.ceil(vp.height));
    cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    await e.page.render({ canvasContext: ctx, viewport: vp }).promise;
    e.hi = cv; e.hiScale = scale;
  }
  const sw = Math.max(4, Math.round((bb[2] - bb[0]) * scale));
  const sh = Math.max(4, Math.round((bb[3] - bb[1]) * scale));
  const k = maxW && sw > maxW ? maxW / sw : 1;
  const w = Math.max(4, Math.round(sw * k)), h = Math.max(4, Math.round(sh * k));
  const out = mk(w, h);
  out.width = w; out.height = h;
  const c = out.getContext('2d');
  c.fillStyle = '#fff';
  c.fillRect(0, 0, w, h);
  c.drawImage(e.hi, Math.round(bb[0] * scale), Math.round(bb[1] * scale), sw, sh, 0, 0, w, h);
  return { blob: await toBlob(out, type || 'image/webp', q ?? 0.92),
           w: Math.round(bb[2] - bb[0]), h: Math.round(bb[3] - bb[1]) };
}

// ---------- 第一步：程序筛可疑块 ----------
//
// 四类毛病，都来自真实文档：
//   text-as-image  整段正文被当成图截走了（译文里凭空少一段）
//   split          一张表被中间几行"文字"劈成两三块
//   cut            图的边界紧贴着还有墨迹的地方，说明截少了
//   missing        有图注却找不到对应的图

function hOverlap(a, b) {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  return w <= 0 ? 0 : w / Math.min(a[2] - a[0], b[2] - b[0]);
}

// 从 y 出发朝 dir 走，统计"没人认领的墨迹"有多少行
function freeInk(ink, covered, yPt, dir, maxPt) {
  const lim = Math.round(maxPt * ink.s);
  let hits = 0;
  for (let k = 1; k <= lim; k++) {
    const y = Math.round(yPt * ink.s) + dir * k;
    if (y < 0 || y >= ink.H || covered[y]) break;
    if (ink.rows[y]) hits++;
  }
  return hits;
}

// 顺着墨迹把边界推出去，遇到别人的地盘或足够长的空白就停
function growEdge(ink, covered, bb, dir, maxPt) {
  const blankLim = Math.max(2, Math.round(7 * ink.s));
  const lim = Math.round(maxPt * ink.s);
  const from = dir > 0 ? bb[3] : bb[1];
  let blank = 0, edge = from, x0 = bb[0], x1 = bb[2];
  for (let k = 1; k <= lim; k++) {
    const y = Math.round(from * ink.s) + dir * k;
    if (y < 0 || y >= ink.H || covered[y]) break;
    if (ink.rows[y]) {
      blank = 0; edge = y / ink.s;
      if (ink.minX[y] >= 0) { x0 = Math.min(x0, ink.minX[y] / ink.s); x1 = Math.max(x1, ink.maxX[y] / ink.s); }
    } else if (++blank >= blankLim) break;
  }
  return dir > 0 ? [x0, bb[1], x1, edge + 2] : [x0, edge - 2, x1, bb[3]];
}

// 在一段 y 区间里找连续的、没人认领的墨迹带
function inkRuns(ink, covered, y0, y1, minHpt) {
  const a = Math.max(0, Math.round(y0 * ink.s)), b = Math.min(ink.H - 1, Math.round(y1 * ink.s));
  const minH = Math.max(3, Math.round(minHpt * ink.s));
  const out = [];
  let s = -1;
  for (let y = a; y <= b + 1; y++) {
    const on = y <= b && ink.rows[y] && !covered[y];
    if (on && s < 0) s = y;
    else if (!on && s >= 0) {
      if (y - s >= minH) {
        let x0 = ink.W, x1 = 0;
        for (let yy = s; yy < y; yy++) {
          if (ink.minX[yy] < 0) continue;
          x0 = Math.min(x0, ink.minX[yy]); x1 = Math.max(x1, ink.maxX[yy]);
        }
        if (x1 > x0 + 12) out.push([x0 / ink.s - 2, s / ink.s - 2, x1 / ink.s + 3, y / ink.s + 2]);
      }
      s = -1;
    }
  }
  return out;
}

export async function scanDoc(doc, src, onProgress) {
  const byPage = new Map();
  for (const b of doc.blocks) {
    if (!byPage.has(b.page)) byPage.set(b.page, []);
    byPage.get(b.page).push(b);
  }
  const pages = [...byPage.keys()].sort((a, b) => a - b)
    .filter(p => byPage.get(p).some(b => b.kind === 'graphic'
      || (b.kind === 'caption' && CAPTION_RE.test(b.text || ''))));

  const found = [];
  let n = 0;
  for (const pno of pages) {
    onProgress?.(++n, pages.length);
    const list = byPage.get(pno);
    const e = await src.get(pno);
    const gs = list.filter(b => b.kind === 'graphic' && b.bbox);
    const ts = list.filter(b => b.kind !== 'graphic' && b.bbox);
    const flagged = new Set();

    // A. 正文被截成图：把原始 PDF 里这块区域的字抠出来看是不是连贯英文
    for (const g of gs) {
      if (g.h < 24) continue;
      const ls = linesOf(itemsIn(e.items, g.bbox));
      if (ls.length < 2) continue;
      const txt = joinLines(ls);
      if (!isProse(txt)) continue;
      if (hardMath(txt) >= 2) continue;                    // 裹着行内公式，还原成文字必毁
      // 多数行里都有大空档 => 是表格，不是段落。附录那种"缩写 / 出处 / 说明"
      // 三列表，虚词多得完全像散文，只有列缝能把它和正文区分开。
      const wide = ls.filter(l => l.gap > Math.max(12, l.size * 1.2)).length;
      if (wide / ls.length > 0.34) continue;
      // 覆盖率太低说明图里只是夹了几行说明文字，主体仍是图
      const inkyRows = ls.reduce((s, l) => s + l.size * 1.2, 0);
      if (inkyRows < (g.bbox[3] - g.bbox[1]) * 0.55) continue;
      flagged.add(g.id);
      found.push({ type: 'text-as-image', page: pno, ids: [g.id], bbox: g.bbox,
                   text: txt, lines: ls, severity: Math.min(1, txt.length / 400) + 1 });
    }

    // B. 一张表被劈开：相邻图块之间只隔着非散文的短行
    const chain = [];
    for (let i = 0; i < gs.length - 1; i++) {
      const a = gs[i], b = gs[i + 1];
      if (flagged.has(a.id) || flagged.has(b.id)) continue;
      const gap = b.bbox[1] - a.bbox[3];
      if (gap < -2 || gap > 90) continue;
      if (hOverlap(a.bbox, b.bbox) < 0.55) continue;
      if (Math.max(a.bbox[3] - a.bbox[1], b.bbox[3] - b.bbox[1]) < 50) continue;
      // 上下两条独立公式本来就该分开，合并反而错。公式的标志是硬数学符号。
      if (hardMath(joinLines(linesOf(itemsIn(e.items, a.bbox)))) >= 2
          || hardMath(joinLines(linesOf(itemsIn(e.items, b.bbox)))) >= 2) continue;
      // 夹在中间的文本块常常和上下两块**部分重叠**（表头行被从中间劈开，上半截
      // 留在图里、下半截算成文字），用"完全落在缝隙里"去找会一个都找不到，
      // 合并后那半行字就孤零零地挂在两张图中间。改成按纵向重叠判断。
      const between = ts.filter(t => t.bbox[1] > a.bbox[1] && t.bbox[3] < b.bbox[3]
        && Math.min(t.bbox[3], b.bbox[1] + 8) - Math.max(t.bbox[1], a.bbox[3] - 8) > 0);
      // 中间夹着标题、成句的正文或图注，说明上下本就是两件事。尤其图注绝不能被吞掉 ——
      // 合并意味着它变成图片的一部分，从此永远不会被翻译。
      if (between.some(t => t.kind === 'heading' || t.kind === 'caption'
                         || CAPTION_RE.test(t.text || '') || isProse(t.text || ''))) continue;
      chain.push({ a, b, between });
    }
    // 连成一串的碎片合并成一个问题，别拆成两次提问
    const groups = [];
    for (const c of chain) {
      const last = groups[groups.length - 1];
      if (last && last.parts[last.parts.length - 1].id === c.a.id) {
        last.parts.push(c.b); last.mid.push(...c.between);
      } else groups.push({ parts: [c.a, c.b], mid: [...c.between] });
    }
    for (const g of groups) {
      const all = [...g.parts, ...g.mid];
      const bb = [Math.min(...all.map(x => x.bbox[0])), Math.min(...all.map(x => x.bbox[1])),
                  Math.max(...all.map(x => x.bbox[2])), Math.max(...all.map(x => x.bbox[3]))];
      g.parts.forEach(p => flagged.add(p.id));
      found.push({ type: 'split', page: pno, ids: g.parts.map(p => p.id),
                   midIds: g.mid.map(m => m.id), bbox: bb, severity: 2 + g.parts.length * 0.1 });
    }

    const needInk = gs.some(x => !flagged.has(x.id) && x.h >= 45)
      || ts.some(t => t.kind === 'caption' && CAPTION_RE.test(t.text || ''));
    if (!needInk) continue;
    const ink = await inkOf(e, src.mk);

    // C. 图被截断：边界外紧挨着还有没人认领的墨迹
    for (const g of gs) {
      if (flagged.has(g.id) || g.h < 45) continue;
      const covered = coverMap(ink, doc.blocks
        .filter(b => b.page === pno && b.id !== g.id && b.bbox).map(b => b.bbox));
      const up = freeInk(ink, covered, g.bbox[1], -1, 10);
      const down = freeInk(ink, covered, g.bbox[3], 1, 10);
      if (up < 2 && down < 2) continue;
      let bb = [...g.bbox];
      if (up >= 2) bb = growEdge(ink, covered, bb, -1, 220);
      if (down >= 2) bb = growEdge(ink, covered, bb, 1, 220);
      if ((bb[3] - bb[1]) - g.h < 6) continue;
      flagged.add(g.id);
      found.push({ type: 'cut', page: pno, ids: [g.id], bbox: bb, oldBbox: g.bbox,
                   severity: 1 + Math.min(1, ((bb[3] - bb[1]) - g.h) / 120) });
    }

    // D. 有图注没有图
    const caps = ts.filter(t => t.kind === 'caption' && CAPTION_RE.test(t.text || ''));
    for (const c of caps) {
      const near = gs.some(g => hOverlap(g.bbox, c.bbox) > 0.25
        && (c.bbox[1] - g.bbox[3] < 150 && g.bbox[1] - c.bbox[3] < 150));
      if (near) continue;
      const covered = coverMap(ink, doc.blocks.filter(b => b.page === pno && b.bbox).map(b => b.bbox));
      const above = ts.filter(t => t.bbox[3] <= c.bbox[1]).reduce((m, t) => Math.max(m, t.bbox[3]), 0);
      const below = ts.filter(t => t.bbox[1] >= c.bbox[3])
        .reduce((m, t) => Math.min(m, t.bbox[1]), e.vp.height);
      const runs = [...inkRuns(ink, covered, above, c.bbox[1], 36).map(r => ({ r, d: c.bbox[1] - r[3] })),
                    ...inkRuns(ink, covered, c.bbox[3], below, 36).map(r => ({ r, d: r[1] - c.bbox[3] }))]
        .filter(x => x.d < 40).sort((a, b) => a.d - b.d);
      if (!runs.length) continue;
      found.push({ type: 'missing', page: pno, ids: [], capId: c.id, bbox: runs[0].r,
                   caption: (c.text || '').slice(0, 80), severity: 2.5 });
    }
  }
  return found.sort((a, b) => b.severity - a.severity);
}

// ---------- 第二步：让 AI 判断 ----------

const SYS = '你是 PDF 版面校对助手。看图后只输出一个 JSON 对象：'
  + '{"verdict":"<选项之一>","reason":"<不超过20字的中文理由>"}。'
  + 'verdict 必须严格取自给定选项，不要输出 JSON 以外的任何内容，不要猜测坐标。';

function questionFor(s) {
  switch (s.type) {
    case 'text-as-image':
      return { opts: ['text', 'graphic'], ask:
        '这张截图是从一篇英文 PDF 里裁出来的。请判断它的主体内容是什么：\n'
        + '- text：普通正文段落、项目符号列表、参考文献等纯文字，本来就应该当文字来读\n'
        + '- graphic：图表、表格、公式、示意图、照片、代码块等，必须保持原样\n'
        + '只有整张图几乎全是连贯的句子时才回 text。' };
    case 'split':
      return { opts: ['one', 'two'], ask:
        '这块内容现在被切成了好几张图，中间还夹着文字，显示出来支离破碎。'
        + '现在要决定能不能把它整体截成一张图。请判断：\n'
        + '- one：整张截图从头到尾都属于图表区域（表头行、标题栏、数据行、图例、'
        + '同一个标题下并列的几个小表，都算），合成一张不会损失任何需要翻译的正文\n'
        + '- two：中间夹着独立的正文段落、章节标题或与图表无关的说明，'
        + '合并会把这些文字变成图片，从此无法翻译\n'
        + '注意：只要整块都是图表内容，哪怕里面有两三个并列的小表，也应该回 one；'
        + '只有当合并会吞掉真正的正文时才回 two。' };
    case 'cut':
      return { opts: ['yes', 'no'], ask:
        '第一张是当前截取的范围，第二张在它的基础上向外扩了一些。请判断：\n'
        + '- yes：第二张多出来的部分属于同一张图/表（比如被切掉的表头、坐标轴标签、图例、最后几行数据）\n'
        + '- no：多出来的是无关的正文、页眉页脚或另一张图，不该并进来' };
    case 'missing':
      return { opts: ['figure', 'no'], ask:
        `文档里有一条图注：「${s.caption}」，但没找到对应的图。这张截图是从图注附近截下来的。请判断：\n`
        + '- figure：它确实是一张图或表\n'
        + '- no：它是正文、空白或无意义的碎片' };
    default:
      return null;
  }
}

function parseVerdict(txt, opts) {
  const m = String(txt).match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      const v = String(j.verdict || '').trim().toLowerCase();
      if (opts.includes(v)) return { verdict: v, reason: String(j.reason || '').slice(0, 40) };
    } catch { /* 落到下面的兜底 */ }
  }
  // 模型没按格式回时，退回到找关键词。两个选项都出现就算没判断出来。
  const low = String(txt).toLowerCase();
  const hit = opts.filter(o => new RegExp(`\\b${o}\\b`).test(low));
  return hit.length === 1 ? { verdict: hit[0], reason: '' } : { verdict: null, reason: '' };
}

async function askVerdict(cfg, model, blobs, ask, opts) {
  const content = [{ type: 'text', text: ask }];
  for (const b of blobs) {
    content.push({ type: 'image_url', image_url: { url: await blobToDataUrl(b) } });
  }
  const txt = await chat(cfg, [{ role: 'system', content: SYS }, { role: 'user', content }],
                         { model, maxTokens: 300, temperature: 0, timeoutMs: 90000 });
  return parseVerdict(txt, opts);
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { error: e.message || String(e) }; }
    }
  }));
  return out;
}

// ---------- 第三步：按判断结果改版面 ----------

function nextId(doc) {
  return doc.blocks.reduce((m, b) => Math.max(m, b.id || 0), 0) + 1;
}

async function repair(doc, s, src, layout) {
  const e = await src.get(s.page);
  const dpi = layout.dpi || 200;
  const idx = id => doc.blocks.findIndex(b => b.id === id);
  const cut = (bb) => cropAt(e, bb, dpi, src.mk, src.toBlob, layout.imageType, layout.imageQuality);

  if (s.type === 'text-as-image') {
    const i = idx(s.ids[0]);
    if (i < 0) return null;
    const b = doc.blocks[i];
    const first = s.lines[0];
    delete b.blob; delete b.zh;
    b.kind = CAPTION_RE.test(s.text) ? 'caption' : 'para';
    b.text = s.text;
    b.size = Math.round((first?.size || 12) * 10) / 10;
    b.w = Math.round(s.bbox[2] - s.bbox[0]);
    b.h = Math.round(s.bbox[3] - s.bbox[1]);
    return { note: `第 ${s.page + 1} 页：一段正文被误截成图，已还原成文字`, retext: true };
  }

  if (s.type === 'split') {
    const i = idx(s.ids[0]);
    if (i < 0) return null;
    const img = await cut(s.bbox);
    const keep = doc.blocks[i];
    keep.bbox = s.bbox; keep.blob = img.blob; keep.w = img.w; keep.h = img.h;
    const drop = new Set([...s.ids.slice(1), ...(s.midIds || [])]);
    doc.blocks = doc.blocks.filter(b => !drop.has(b.id));
    return { note: `第 ${s.page + 1} 页：一张表/图被拆成 ${s.ids.length} 块，已合并` };
  }

  if (s.type === 'cut') {
    const i = idx(s.ids[0]);
    if (i < 0) return null;
    const img = await cut(s.bbox);
    const b = doc.blocks[i];
    const grew = Math.round((s.bbox[3] - s.bbox[1]) - (s.oldBbox[3] - s.oldBbox[1]));
    b.bbox = s.bbox; b.blob = img.blob; b.w = img.w; b.h = img.h;
    return { note: `第 ${s.page + 1} 页：图被截断，已补回 ${grew}pt` };
  }

  if (s.type === 'missing') {
    const img = await cut(s.bbox);
    const ci = idx(s.capId);
    const blk = { id: nextId(doc), kind: 'graphic', text: '', page: s.page,
                  bbox: s.bbox, blob: img.blob, w: img.w, h: img.h };
    // 图在图注上方就插在图注前，反之插在后面
    const at = ci < 0 ? doc.blocks.length
      : (s.bbox[3] <= doc.blocks[ci].bbox[1] ? ci : ci + 1);
    doc.blocks.splice(at, 0, blk);
    return { note: `第 ${s.page + 1} 页：补回了「${s.caption.slice(0, 24)}」缺失的图` };
  }
  return null;
}

// ---------- 编排 ----------

const PREVIEW_DPI = 110;      // 给 AI 看的图不需要 200dpi，够看清就行
const PREVIEW_W = 1100;

// doc 会被就地修改。返回一份报告，调用方据此提示用户、并补译还原出来的文字。
export async function auditDoc(doc, pdfBlob, cfg, layout, hooks = {}) {
  const { onStage, shouldStop } = hooks;
  const maxCalls = cfg.auditMaxCalls || 40;
  const model = cfg.visionModel && cfg.visionModel !== '-' ? cfg.visionModel : cfg.model;
  const canSee = cfg.visionModel !== '-';
  const report = { suspects: 0, asked: 0, fixed: [], skipped: 0, failed: 0, degraded: !canSee };

  const src = await openSource(pdfBlob);
  try {
    let all = await scanDoc(doc, src, (i, n) => onStage?.('scan', i, n));
    report.suspects = all.length;
    if (!all.length) return report;
    if (all.length > maxCalls) { report.skipped = all.length - maxCalls; all = all.slice(0, maxCalls); }
    if (shouldStop?.()) return report;

    // 没有读图能力时只做最有把握的一类：整段连贯英文被截成图。
    // 其余三类都依赖"看一眼就知道"的判断，没有模型就不动，宁可不改也不改坏。
    if (!canSee) {
      const sure = all.filter(s => s.type === 'text-as-image'
        && metrics(s.text).words >= 30 && metrics(s.text).ends >= 2);
      for (const s of sure) {
        const r = await repair(doc, s, src, layout);
        if (r) { report.fixed.push({ ...r, type: s.type, page: s.page }); }
      }
      return report;
    }

    let done = 0;
    const verdicts = await pool(all, Math.min(4, cfg.concurrency || 4), async (s) => {
      if (shouldStop?.()) return { verdict: null };
      const e = await src.get(s.page);
      const q = questionFor(s);
      const shot = bb => cropAt(e, bb, PREVIEW_DPI, src.mk, src.toBlob, 'image/webp', 0.85, PREVIEW_W);
      const imgs = s.type === 'cut'
        ? [(await shot(s.oldBbox)).blob, (await shot(s.bbox)).blob]
        : [(await shot(s.bbox)).blob];
      const v = await askVerdict(cfg, model, imgs, q.ask, q.opts);
      onStage?.('ask', ++done, all.length);
      return v;
    });

    const OK = { 'text-as-image': 'text', split: 'one', cut: 'yes', missing: 'figure' };
    for (let i = 0; i < all.length; i++) {
      const s = all[i], v = verdicts[i] || {};
      if (v.error) { report.failed++; continue; }
      if (!v.verdict) { report.failed++; continue; }
      report.asked++;
      if (v.verdict !== OK[s.type]) continue;
      try {
        const r = await repair(doc, s, src, layout);
        if (r) report.fixed.push({ ...r, type: s.type, page: s.page, reason: v.reason });
      } catch (e) { report.failed++; }
    }
    return report;
  } finally {
    src.close();
  }
}

export function auditSummary(r) {
  if (!r) return '';
  if (!r.suspects) return '版面自检：没发现问题';
  if (!r.fixed.length) {
    return `版面自检：核查了 ${r.asked || r.suspects} 处可疑的图，AI 判断都没问题`;
  }
  const by = {};
  for (const f of r.fixed) by[f.type] = (by[f.type] || 0) + 1;
  const name = { 'text-as-image': '误截成图的正文', split: '被拆开的图表', cut: '截断的图', missing: '漏掉的图' };
  const part = Object.entries(by).map(([k, n]) => `${n} 处${name[k] || k}`).join('、');
  return `版面自检：修正了 ${part}`;
}

// 对外包一层，保证解析期的渲染不被后台标签页的 rAF 节流卡死
export function runAudit(doc, pdfBlob, cfg, layout, hooks) {
  return withUnthrottledRaf(() => auditDoc(doc, pdfBlob, cfg, layout, hooks));
}

// 只跑程序筛查，不调模型、不改文档。调参和排查用。
export function scanOnly(doc, pdfBlob, onProgress) {
  return withUnthrottledRaf(async () => {
    const src = await openSource(pdfBlob);
    try { return await scanDoc(doc, src, onProgress); } finally { src.close(); }
  });
}
