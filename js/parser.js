// PDF -> 版面块序列 + 公式/表格截图
// PDF.js 只给字符级 items（本文件用的那篇 85 页论文，单页就有 202 个），
// 不像 PyMuPDF 自带段落分组，所以行聚合和分块都要自己做。

let pdfjs = null;

export async function initPdfjs() {
  if (pdfjs) return pdfjs;
  pdfjs = await import('../vendor/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
  return pdfjs;
}

const CAPTION_RE = /^(Table|Figure|Panel)\s+[A-Z]?\.?\d+/i;
const PAGENO_RE = /^[ivxlcdm]{0,7}\d{0,4}$/i;
const HEAD_NUM_RE = /^([A-Z]\.)?\d+(\.\d+)*\s*[A-Z]/;
const ENG_START_RE = /^[A-Z][a-z]+[,;]?\s+[a-z]/;
const MATH_KW = /\b(arg\s*min|arg\s*max|s\.t\.|subject to)\b/i;
const MATH_CHARS = new Set('⋆⊤∈∀∃≤≥≠≈∂∇∑∏∫√∥⊙⊗←→⇒⇔∞λνθϕφηζγβαμσΣΩΛΦΨΓΔ⌊⌋⌈⌉ˆ˜');
const STOPWORDS = new Set(['the','of','a','an','is','are','was','we','in','to','for','that',
  'with','and','this','be','as','by','on','it','not','our','their','which','can','from','at',
  'or','has','have','these','its','but']);

function isMath(text) {
  const n = text.length;
  if (!n) return false;
  let m = 0;
  for (const ch of text) if (MATH_CHARS.has(ch)) m++;
  const dens = m / n;
  if (ENG_START_RE.test(text) && dens < 0.12) return false;   // 正常句式含行内符号，仍是正文
  if (n < 90 && MATH_KW.test(text)) return true;
  return dens > 0.04;
}

function isTabular(text) {
  const c = text.replace(/ /g, '');
  // 长度下限很关键：参考文献结尾的 "500–506." 数字密度高达 87%，会被误判成表格行再截成图
  if (c.length >= 14) {
    let d = 0;
    for (const ch of c) if ((ch >= '0' && ch <= '9') || ch === '.') d++;
    if (d / c.length > 0.32) return true;                      // 数字密度高 => 数据行
  }
  if (text.length >= 120) return false;
  const w = text.split(/\s+/).map(x => x.replace(/^[.,()%:;]+|[.,()%:;]+$/g, '').toLowerCase());
  if (w.length < 4) return false;
  if (/[.!?:;]\s*$/.test(text)) return false;
  return !w.some(x => STOPWORDS.has(x));                       // 无虚词无句末标点 => 表头
}

function dominant(arr, key) {
  const c = new Map();
  for (const s of arr) c.set(s[key], (c.get(s[key]) || 0) + Math.max(s.str.length, 1));
  let best = null, n = -1;
  for (const [k, v] of c) if (v > n) { n = v; best = k; }
  return best;
}

// ---------- items -> 行 -> 块 ----------

function toSpans(textContent, viewport, fontMap) {
  const out = [];
  for (const it of textContent.items) {
    if (!it.str || !it.str.trim()) continue;
    const tx = pdfjs.Util.transform(viewport.transform, it.transform);
    const size = Math.hypot(tx[2], tx[3]) / viewport.scale;
    const w = (it.width || 0);
    const x0 = tx[4] / viewport.scale;
    const yBase = tx[5] / viewport.scale;
    out.push({
      str: it.str, size: Math.round(size * 10) / 10,
      font: (fontMap[it.fontName] || it.fontName || '').split('+').pop(),
      x0, x1: x0 + w, yBase, yTop: yBase - size * 0.78, yBot: yBase + size * 0.24,
      eol: !!it.hasEOL,
    });
  }
  return out;
}

function groupLines(spans, tol) {
  const sorted = [...spans].sort((a, b) => a.yBase - b.yBase || a.x0 - b.x0);
  const lines = [];
  for (const s of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(s.yBase - last.yBase) <= Math.max(s.size, last.maxSize) * tol) {
      last.spans.push(s);
      last.x0 = Math.min(last.x0, s.x0); last.x1 = Math.max(last.x1, s.x1);
      last.yTop = Math.min(last.yTop, s.yTop); last.yBot = Math.max(last.yBot, s.yBot);
      last.maxSize = Math.max(last.maxSize, s.size);
    } else {
      lines.push({ spans: [s], yBase: s.yBase, x0: s.x0, x1: s.x1,
                   yTop: s.yTop, yBot: s.yBot, maxSize: s.size });
    }
  }
  for (const l of lines) {
    l.spans.sort((a, b) => a.x0 - b.x0);
    l.text = l.spans.map(s => s.str).join('').replace(/\s+/g, ' ').trim();
    l.size = Math.round((dominant(l.spans, 'size') || l.maxSize) * 10) / 10;
    l.font = dominant(l.spans, 'font') || '';
  }
  return lines;
}

function groupBlocks(lines, L) {
  const blocks = [];
  for (const ln of lines) {
    const b = blocks[blocks.length - 1];
    if (b) {
      const prev = b.lines[b.lines.length - 1];
      const gap = ln.yTop - prev.yBot;
      const lineH = Math.max(prev.size, ln.size);
      const prevFull = prev.x0 < L.bodyX0Max && prev.x1 > L.bodyX1Min;
      // 只有新行同样顶格时，才允许"上一行是满行"这条豁免 —— 否则居中的公式行会被并进正文
      const bothIndented = ln.x0 > L.bodyX0Max && prev.x0 > L.bodyX0Max;
      const overlapX = Math.min(ln.x1, prev.x1) - Math.max(ln.x0, prev.x0);
      const centered = bothIndented &&
        overlapX > Math.min(ln.x1 - ln.x0, prev.x1 - prev.x0) * 0.5;
      const sameCol = Math.abs(ln.x0 - prev.x0) < 26
                   || (prevFull && ln.x0 < L.bodyX0Max) || centered;
      const sizeSame = Math.abs(ln.size - prev.size) < 1.2;      // 脚注 10pt 与正文 12pt 必须分开
      const boldSame = ln.font.includes('BX') === prev.font.includes('BX'); // 12pt 的四级标题靠这条分出来
      const dispMath = (l) => l.x0 > L.bodyX0Max && isMath(l.text);
      const mathSame = dispMath(ln) === dispMath(prev);
      // 缩进突变 => 新段落/新条目。难点：正文是"首行缩进"、参考文献是"悬挂缩进"，
      // 同一个 x0 模式在两种排版下含义相反，所以先用块的第二行判断属于哪一种。
      const firstX0 = b.lines[0].x0;
      let indentBreak = false;
      if (b.lines.length >= 2) {
        const hanging = b.lines[1].x0 > firstX0 + 8;
        indentBreak = hanging
          ? Math.abs(ln.x0 - firstX0) < 3   // 悬挂缩进：回到首行水平 => 新条目
          : ln.x0 > b.x0 + 8;               // 首行缩进：出现缩进行 => 新段首行
      }
      if (gap <= lineH * L.blockGap && sameCol && sizeSame && boldSame && mathSame && !indentBreak) {
        b.lines.push(ln);
        b.x0 = Math.min(b.x0, ln.x0); b.x1 = Math.max(b.x1, ln.x1);
        b.yTop = Math.min(b.yTop, ln.yTop); b.yBot = Math.max(b.yBot, ln.yBot);
        continue;
      }
    }
    blocks.push({ lines: [ln], x0: ln.x0, x1: ln.x1, yTop: ln.yTop, yBot: ln.yBot });
  }
  for (const b of blocks) {
    let t = '';
    b.lines.forEach((l, i) => {
      if (i === 0) t = l.text;
      else if (t.endsWith('-')) t = t.slice(0, -1) + l.text;
      else t = t + ' ' + l.text;
    });
    b.text = t.replace(/\s+/g, ' ').trim();
    const all = b.lines.flatMap(l => l.spans);
    b.size = Math.round((dominant(all, 'size') || 12) * 10) / 10;
    b.font = dominant(all, 'font') || '';
  }
  return blocks;
}

// 一个块里粘了两级标题（"2 Context" + "2.1 Asset pricing"）时按行拆开
function splitMixed(b, L) {
  if (b.lines.length < 2) return [b];
  const sizes = b.lines.map(l => l.size);
  const mx = Math.max(...sizes), mn = Math.min(...sizes);
  if (mx < L.headMinSize || mx - mn < 2.0) return [b];
  const groups = []; let cur = [], curSz = sizes[0];
  b.lines.forEach((l, i) => {
    if (cur.length && Math.abs(sizes[i] - curSz) >= 2.0) { groups.push(cur); cur = []; curSz = sizes[i]; }
    cur.push(l);
  });
  groups.push(cur);
  // 拆出的碎片若没有实质内容（如只有上标字母 a,b,c），说明不是真的两级标题，不拆
  const solid = g => g.map(l => l.text).join('').replace(/[^A-Za-z\u4e00-\u9fff]/g, '').length >= 8;
  if (groups.length > 1 && !groups.every(solid)) return [b];
  return groups.map(g => {
    const nb = { lines: g,
      x0: Math.min(...g.map(l => l.x0)), x1: Math.max(...g.map(l => l.x1)),
      yTop: Math.min(...g.map(l => l.yTop)), yBot: Math.max(...g.map(l => l.yBot)) };
    nb.text = g.map(l => l.text).join(' ').replace(/\s+/g, ' ').trim();
    const all = g.flatMap(l => l.spans);
    nb.size = Math.round((dominant(all, 'size') || 12) * 10) / 10;
    nb.font = dominant(all, 'font') || '';
    return nb;
  });
}

function classify(b, L) {
  const text = b.text;
  if (!text) return null;
  const { size, font, x0, x1 } = b;
  if (b.yTop > L.pageNoY && PAGENO_RE.test(text) && text.length <= 5) return null;  // 页码

  const indented = x0 < L.bodyX0Max;
  const fullWidth = indented && x1 > L.bodyX1Min;
  const words = text.split(/\s+/).length;

  if (font.includes('BX') && size >= L.headMinSize) return 'heading';
  if (font.includes('BX') && size >= 11.5 && HEAD_NUM_RE.test(text) && words <= 14) return 'heading';
  if (size >= L.headMinSize && x0 < L.bodyX0Max + 175 && text.length < 90) return 'heading';
  // 居中的无编号粗体小标题：Abstract / Acknowledgements / Appendix。字号与正文相当，
  // 靠"粗体 + 不顶格 + 首字母大写的少数几个英文词"识别，避免误伤公式里的 \max、s.t.
  if (font.includes('BX') && !fullWidth && text.length < 30
      && /^[A-Z][A-Za-z]{2,}(\s+[A-Za-z]+){0,3}$/.test(text)) return 'heading';
  if (CAPTION_RE.test(text)) return 'caption';

  const bodySized = size >= L.bodySize[0] && size <= L.bodySize[1];
  const absSized = size >= L.abstractSize[0] && size <= L.abstractSize[1];
  if (bodySized || absSized) {
    const bad = isMath(text) || isTabular(text);
    if (fullWidth && !bad) return 'para';
    if (indented && words >= 4 && !bad) return 'para';
    // 居中缩进的成段文字（摘要、机构地址）——不顶格但确是正文
    if (absSized && x0 < L.abstractX0Max && (x1 - x0) > L.abstractMinW
        && b.lines.length >= 4 && !bad) return 'para';
  }
  if (fullWidth && size >= L.footnoteSize[0] && size <= L.footnoteSize[1]) return 'note';
  return 'graphic';
}

// 图表里真正把各部分连成一体的是矢量线条（折线、坐标轴、分数线、根号、矩阵括号），
// 而这些不在文本流里，PDF.js 的 textContent 完全抓不到。解析 getOperatorList 要自己
// 模拟图形状态栈才能还原坐标，太重；改为直接看渲染结果：两个碎片之间若没有文字、
// 却有墨迹，说明中间就是这些线条，应当合并回同一张图。
function mergeGraphics(rects, L, pageW, pageH, bridge) {
  if (!rects.length) return [];
  const s = [...rects].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const cl = []; let cur = [...s[0]];
  for (let i = 1; i < s.length; i++) {
    const [x0, y0, x1, y1] = s[i];
    const gap = y0 - cur[3];
    let join = gap <= L.graphicGap;
    if (!join && gap < L.inkBridgeMax && bridge) {
      join = bridge([Math.min(cur[0], x0), cur[3], Math.max(cur[2], x1), y0]);
    }
    if (join) {
      cur = [Math.min(cur[0], x0), Math.min(cur[1], y0), Math.max(cur[2], x1), Math.max(cur[3], y1)];
    } else { cl.push(cur); cur = [x0, y0, x1, y1]; }
  }
  cl.push(cur);
  const p = L.graphicPad;
  return cl.filter(c => c[3] - c[1] >= L.minGraphicH)
           .map(c => [Math.max(c[0] - p, 0), Math.max(c[1] - p, 0),
                      Math.min(c[2] + p, pageW), Math.min(c[3] + p, pageH)]);
}

function overlapRatio(a, b) {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.max((a[2] - a[0]) * (a[3] - a[1]), 1);
}

// ---------- 主流程 ----------

// PDF.js 的渲染调度走 requestAnimationFrame，而浏览器在标签页隐藏时会冻结 rAF，
// 导致切走标签页解析就卡死（OffscreenCanvas 也绕不过）。离屏渲染并不需要跟屏幕刷新
// 同步，解析期间换成 setTimeout：既能后台继续跑，也不再被 60fps 限速。
async function withUnthrottledRaf(fn) {
  const orig = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0);
  try { return await fn(); }
  finally { globalThis.requestAnimationFrame = orig; }
}

export function parsePdf(file, layout, onProgress, maxPages) {
  return withUnthrottledRaf(() => parsePdfInner(file, layout, onProgress, maxPages));
}

async function parsePdfInner(file, layout, onProgress, maxPages) {
  await initPdfjs();
  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const L = layout;
  const scale = L.dpi / 72;
  const blocks = [];
  let gi = 0;

  // OffscreenCanvas 不受页面可见性节流影响 —— 用户切走标签页时解析仍继续
  const OC = typeof OffscreenCanvas !== 'undefined';
  const mkCanvas = (w, h) => OC ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const toBlob = (c) => OC ? c.convertToBlob({ type: 'image/png' })
    : new Promise(r => c.toBlob(r, 'image/png'));

  const cv = mkCanvas(8, 8);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const crop = mkCanvas(8, 8);
  const cctx = crop.getContext('2d');
  const ink = mkCanvas(8, 8);                 // 墨迹检测用的低分辨率副本
  const ictx = ink.getContext('2d', { willReadFrequently: true });

  const lastPage = Math.min(doc.numPages, maxPages || doc.numPages);
  for (let pno = 1; pno <= lastPage; pno++) {
    const page = await doc.getPage(pno);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale });
    cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
    ctx.clearRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;   // 渲染同时让字体就绪

    const fontMap = {};
    const tc = await page.getTextContent();
    for (const it of tc.items) {
      if (it.fontName && !(it.fontName in fontMap)) {
        try {
          fontMap[it.fontName] = page.commonObjs.has(it.fontName)
            ? (page.commonObjs.get(it.fontName)?.name || '') : '';
        } catch { fontMap[it.fontName] = ''; }
      }
    }

    const spans = toSpans(tc, vp1, fontMap);
    const lines = groupLines(spans, L.lineTol);
    const raw = groupBlocks(lines, L);

    const texts = [], gRects = [];
    for (const b0 of raw) {
      for (const b of splitMixed(b0, L)) {
        const kind = classify(b, L);
        if (!kind) continue;
        const bbox = [b.x0, b.yTop, b.x1, b.yBot];
        if (kind === 'graphic') gRects.push(bbox);
        else texts.push({ kind, text: b.text, size: b.size, font: b.font, bbox, page: pno - 1 });
      }
    }

    // 墨迹投影：把已渲染的大图缩到 72dpi 再一次性取像素，逐行记录有没有内容。
    // 直接在 200dpi 画布上按区域取 getImageData 会慢 15 倍，实测 85 页从 5s 涨到 80s。
    // 且多数页面根本没有图，所以延迟到第一次真正需要时才计算。
    let inkRows = null;
    const getInkRows = () => {
      if (inkRows) return inkRows;
      const W = Math.ceil(vp1.width), H = Math.ceil(vp1.height);
      ink.width = W; ink.height = H;
      ictx.fillStyle = '#fff';
      ictx.fillRect(0, 0, W, H);
      ictx.drawImage(cv, 0, 0, W, H);
      const d = ictx.getImageData(0, 0, W, H).data;
      inkRows = new Uint8Array(H);
      for (let y = 0; y < H; y++) {
        const base = y * W * 4;
        for (let x = 0; x < W; x++) {
          const i = base + x * 4;
          if (d[i] < 248 || d[i + 1] < 248 || d[i + 2] < 248) { inkRows[y] = 1; break; }
        }
      }
      return inkRows;
    };

    // 间隙里若夹着正文，说明本来就是两块内容，不桥接；否则看这段空白里有没有墨迹
    const bridge = (band) => {
      if (band[3] - band[1] <= 0) return false;
      if (texts.some(t => t.bbox[3] > band[1] + 1 && t.bbox[1] < band[3] - 1)) return false;
      const rows = getInkRows();
      const y0 = Math.max(0, Math.floor(band[1]));
      const y1 = Math.min(rows.length - 1, Math.ceil(band[3]));
      for (let y = y0; y <= y1; y++) if (rows[y]) return true;
      return false;
    };

    for (const r0 of mergeGraphics(gRects, L, vp1.width, vp1.height, bridge)) {
      // 外扩的 padding 会吃进相邻正文行，截出来就是"图 + 半行被裁的字"。这里按上下
      // 最近的文本块回缩边界。
      const r = [...r0];
      for (const t of texts) {
        if (t.bbox[1] >= r0[3] - 1 && t.bbox[1] < r[3]) r[3] = t.bbox[1] - 1;
        if (t.bbox[3] <= r0[1] + 1 && t.bbox[3] > r[1]) r[1] = t.bbox[3] + 1;
      }
      if (r[3] - r[1] < L.minGraphicH) continue;
      // 与正文块重叠度过高 => 会把正文重复截一遍
      if (texts.some(t => overlapRatio(t.bbox, r) > 0.6)) continue;
      // 只丢弃"矮于一行且落在段落内"的碎片（上下标）。原来按重叠比例一刀切，
      // 会把夹在两段之间的独立公式整个误杀，表现为公式凭空消失。
      if ((r[3] - r[1]) < 30
          && texts.some(t => t.kind !== 'graphic' && overlapRatio(r, t.bbox) > 0.55)) continue;
      const w = Math.round((r[2] - r[0]) * scale), h = Math.round((r[3] - r[1]) * scale);
      if (w < 4 || h < 4) continue;
      crop.width = w; crop.height = h;
      cctx.clearRect(0, 0, w, h);
      cctx.drawImage(cv, Math.round(r[0] * scale), Math.round(r[1] * scale), w, h, 0, 0, w, h);
      gi++;
      texts.push({ kind: 'graphic', text: '', page: pno - 1, bbox: r,
                   blob: await toBlob(crop),
                   w: Math.round(r[2] - r[0]), h: Math.round(r[3] - r[1]) });
    }

    texts.sort((a, b) => Math.round(a.bbox[1] / 3) - Math.round(b.bbox[1] / 3) || a.bbox[0] - b.bbox[0]);
    blocks.push(...texts);
    page.cleanup();
    if (onProgress) onProgress(pno, lastPage);
  }

  return finalize(blocks);
}

function finalize(blocks) {
  // 跨页续段合并
  const out = [];
  for (const b of blocks) {
    // 跨页续段：页底常夹着脚注，所以要跳过 note/graphic 往回找最近的正文块
    if (b.kind === 'para' && /^[a-z(,;]/.test(b.text)) {
      let j = out.length - 1;
      while (j >= 0 && out[j].kind !== 'para') j--;
      if (j >= 0 && out[j].page !== b.page && !/[.!?:;)"”]\s*$/.test(out[j].text)) {
        out[j].text = out[j].text.replace(/\s+$/, '') + ' ' + b.text;
        continue;
      }
    }
    out.push(b);
  }
  // References ~ 附录之间不翻译
  const rs = out.findIndex(b => b.kind === 'heading' && b.text.trim().replace(/\*+$/, '') === 'References');
  if (rs >= 0) {
    let end = out.length;
    for (let i = rs + 1; i < out.length; i++) {
      if (out[i].kind === 'heading' && (out[i].size || 0) >= 17) { end = i; break; }
    }
    for (let i = rs + 1; i < end; i++) {
      if (out[i].kind === 'para' || out[i].kind === 'note') out[i].kind = 'ref';
      else if (out[i].kind === 'graphic') out[i].kind = 'drop';   // 参考文献里不可能有公式图
    }
  }
  // 首页作者署名行不翻译
  for (let i = 0; i < Math.min(8, out.length); i++) {
    const b = out[i];
    if (b.kind === 'heading' && (b.text.match(/,/g) || []).length >= 3) b.kind = 'ref';
  }
  const kept = out.filter(b => b.kind !== 'drop');
  kept.forEach((b, i) => { b.id = i; });
  return kept;
}

export const TRANSLATE_KINDS = new Set(['heading', 'para', 'caption', 'note']);
