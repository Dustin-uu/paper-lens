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

const CAPTION_RE = /^(Table|Figure|Fig|Panel|Chart|Exhibit)\s*\.?\s*[A-Z]?\.?\s*\d+/i;
const PAGENO_RE = /^[ivxlcdm]{0,7}\d{0,4}$/i;
const HEAD_NUM_RE = /^([A-Z]\.)?\d+(\.\d+)*\s*[A-Z]/;
const ENG_START_RE = /^[A-Z][a-z]+[,;]?\s+[a-z]/;
const MATH_KW = /\b(arg\s*min|arg\s*max|s\.t\.|subject to)\b/i;
const MATH_CHARS = new Set('⋆⊤∈∀∃≤≥≠≈∂∇∑∏∫√∥⊙⊗←→⇒⇔∞λνθϕφηζγβαμσΣΩΛΦΨΓΔ⌊⌋⌈⌉ˆ˜');
// 粗体判定要跨字体体系：LaTeX 是 CMBX*，商业文档是 NVIDIASans-Bold / Arial-BoldMT 这类
// 页眉页脚在多页重复出现，把页码换成 # 后即可跨页比对
const hfKey = t => t.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 60);

function isHeaderFooter(line, L, pageH) {
  if (!L._skipTexts || !L._skipTexts.size) return false;
  if (line.yTop > pageH * 0.09 && line.yBot < pageH * 0.91) return false;
  return L._skipTexts.has(hfKey(line.text));
}

const BOLD_RE = /bold|black|heavy|semib|demib|[-_]bd\b|BX/i;

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
      const boldSame = BOLD_RE.test(ln.font) === BOLD_RE.test(prev.font); // 与正文同字号的小标题靠这条分出来
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

function classify(b, L, pageH) {
  const text = b.text;
  if (!text) return null;
  const { size, font, x0, x1 } = b;
  if (b.yTop > (pageH || 792) * 0.88 && PAGENO_RE.test(text) && text.length <= 5) return null;  // 页码

  const indented = x0 < L.bodyX0Max;
  const fullWidth = indented && x1 > L.bodyX1Min;
  const words = text.split(/\s+/).length;

  // 目录条目（"标题........12"）。点线是可靠标志。整段译出来只是一堆点线和页码，
  // 而且侧栏已有自动生成的目录，所以保留原文不译。
  if (/\.{4,}/.test(text) && /\d/.test(text)) return 'ref';
  // 图题常是粗体且字号不小，必须先于标题判定，否则 "Figure1.xxx" 会被当成章节标题
  if (CAPTION_RE.test(text)) return 'caption';
  if (BOLD_RE.test(font) && size >= L.headMinSize) return 'heading';
  if (BOLD_RE.test(font) && size >= L.bodySize[0] && HEAD_NUM_RE.test(text) && words <= 14) return 'heading';
  if (size >= L.headMinSize && x0 < L.bodyX0Max + 175 && text.length < 90) return 'heading';
  // 居中的无编号粗体小标题：Abstract / Acknowledgements / Appendix。字号与正文相当，
  // 靠"粗体 + 不顶格 + 首字母大写的少数几个英文词"识别，避免误伤公式里的 \max、s.t.
  if (BOLD_RE.test(font) && !fullWidth && text.length < 30
      && /^[A-Z][A-Za-z]{2,}(\s+[A-Za-z]+){0,3}$/.test(text)) return 'heading';
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


// 版面自适应：默认值是按 LaTeX 论文（正文 12pt、页边距 72pt）调的，换成商业白皮书
// （正文 11pt、页边距 50pt）会全盘失配 —— 正文字号一旦落在区间外，整篇都会被当成图。
// 与其让用户去猜参数，不如先采样几页，从 PDF 自己的排版统计里把这些值推出来。
export async function profileDocument(doc, L, maxSample = 14) {
  let pageWidth = 612;
  const sizeHist = new Map(), xHist = new Map(), edgeHist = new Map();
  const total = doc.numPages;
  // 跳过封面/目录，从正文区域采样
  const start = total > 6 ? Math.floor(total * 0.2) : 0;
  const n = Math.min(total - start, maxSample);
  for (let i = 0; i < n; i++) {
    const page = await doc.getPage(start + i + 1);
    const vp = page.getViewport({ scale: 1 });
    pageWidth = vp.width;
    const tc = await page.getTextContent();
    // 先按基线聚行，再取每行最左的 x —— 直接统计片段的 x 会被行中间的片段带偏
    const rows = new Map();
    for (const it of tc.items) {
      if (!it.str.trim()) continue;
      const t = pdfjs.Util.transform(vp.transform, it.transform);
      const size = Math.round(Math.hypot(t[2], t[3]) * 10) / 10;
      if (size < 4 || size > 40) continue;
      sizeHist.set(size, (sizeHist.get(size) || 0) + it.str.length);
      const key = Math.round(t[5]);
      const r = rows.get(key) || { x: Infinity, y: t[5], txt: '' };
      r.x = Math.min(r.x, t[4]); r.txt += it.str;
      rows.set(key, r);
    }
    for (const r of rows.values()) {
      const b = Math.round(r.x / 2) * 2;
      xHist.set(b, (xHist.get(b) || 0) + 1);
      // 页面上下边缘的行，登记文本以便跨页比对
      if (r.y < vp.height * 0.09 || r.y > vp.height * 0.91) {
        const k = hfKey(r.txt);
        if (k.length >= 3) edgeHist.set(k, (edgeHist.get(k) || 0) + 1);
      }
    }
    page.cleanup();
  }
  if (!sizeHist.size) return L;

  // 正文字号 = 字符数最多的字号
  const bodySize = [...sizeHist.entries()].sort((a, b) => b[1] - a[1])[0][0];
  // 正文左边界 = 最靠左的那个显著峰（正文行首远多于缩进行、居中行）
  const xs = [...xHist.entries()].sort((a, b) => a[0] - b[0]);
  const rowTotal = xs.reduce((s, [, c]) => s + c, 0);
  let bodyX0 = xs[0][0];
  for (const [x, c] of xs) if (c / rowTotal > 0.06) { bodyX0 = x; break; }
  // 正文常有多级缩进（首行缩进、项目符号、引用块）。缩进量因文档而异——LaTeX 论文
  // 是 18pt，这份白皮书是 36pt——靠字号推容差会漏，直接从直方图里把左侧的次峰学出来。
  let indentMax = bodyX0;
  for (const [x, c] of xs) {
    if (x > pageWidth * 0.35) break;          // 只看左半部分，避开居中标题和右栏
    if (c / rowTotal > 0.03) indentMax = x;
  }

  const out = { ...L };
  out.bodySize = [Math.round((bodySize - 0.6) * 10) / 10, Math.round((bodySize + 0.8) * 10) / 10];
  out.abstractSize = [Math.round((bodySize - 1.4) * 10) / 10, Math.round((bodySize - 0.7) * 10) / 10];
  out.footnoteSize = [Math.round((bodySize - 2.2) * 10) / 10, Math.round((bodySize - 1.5) * 10) / 10];
  out.headMinSize = Math.round((bodySize + 1.4) * 10) / 10;
  out.bodyX0Max = Math.round(indentMax + bodySize * 0.6);   // 容得下最深一级正文缩进
  out.abstractX0Max = Math.round(bodyX0 + bodySize * 8);
  out._indentMax = indentMax;
  // 在采样页里重复出现 3 次以上的边缘行，判定为页眉/页脚
  out._skipTexts = new Set([...edgeHist.entries()]
    .filter(([, c]) => c >= Math.min(3, Math.max(2, Math.floor(n / 3))))
    .map(([t]) => t));
  out._profile = { bodySize, bodyX0, sampled: n, headerFooters: out._skipTexts.size };
  return out;
}


// 有墨迹、却没有任何文本块覆盖的连续行段 = 纯图形（位图插图、无标注的矢量图）。
// PDF.js 的 textContent 对这类内容一无所知，只能从渲染结果里找。
function findFigureRegions(texts, known, ink, minHpt) {
  const { rows, minX, maxX, W, H, s } = ink;
  const minH = Math.max(4, Math.round(minHpt * s));
  const covered = new Uint8Array(H);
  const mark = bb => {
    const a = Math.max(0, Math.floor(bb[1] * s) - 1), b = Math.min(H - 1, Math.ceil(bb[3] * s) + 1);
    for (let y = a; y <= b; y++) covered[y] = 1;
  };
  for (const t of texts) mark(t.bbox);
  for (const r of known) mark(r);

  const out = [];
  let start = -1;
  for (let y = 0; y <= H; y++) {
    const isFig = y < H && rows[y] && !covered[y];
    if (isFig && start < 0) start = y;
    else if (!isFig && start >= 0) {
      if (y - start >= minH) {
        let x0 = W, x1 = 0;
        for (let yy = start; yy < y; yy++) {
          if (minX[yy] < 0) continue;
          if (minX[yy] < x0) x0 = minX[yy];
          if (maxX[yy] > x1) x1 = maxX[yy];
        }
        if (x1 > x0 + 12) out.push([Math.max(0, x0 - 2) / s, Math.max(0, start - 2) / s,
                                    Math.min(W, x1 + 3) / s, Math.min(H, y + 2) / s]);
      }
      start = -1;
    }
  }
  return out;
}


// 表格/大图里常有若干行被判成了文本块（表头、数据行），结果图被截断、文字又重复出现。
// 按墨迹连通性把大图形区向上下扩展：遇到足够高的空白带、或遇到顶格正文才停。
function expandRegion(r, ink, bodyLines, L, maxGrow = 260) {
  if (r[3] - r[1] < 80) return r;               // 小公式不动
  const { rows, minX, maxX, H, s } = ink;
  const out = [...r];
  const hitsBody = yPt => bodyLines.some(t => t.bbox[1] - 2 <= yPt && t.bbox[3] + 2 >= yPt);
  const BLANK = Math.max(2, Math.round(7 * s));  // 连续空白多少像素算到边
  const grow = Math.round(maxGrow * s);

  let blank = 0;
  for (let y = Math.ceil(r[3] * s); y < H && y - r[3] * s < grow; y++) {
    if (hitsBody(y / s)) break;
    if (rows[y]) { blank = 0; out[3] = y / s; if (minX[y] >= 0) { out[0] = Math.min(out[0], minX[y] / s); out[2] = Math.max(out[2], maxX[y] / s); } }
    else if (++blank >= BLANK) break;
  }
  blank = 0;
  for (let y = Math.floor(r[1] * s); y >= 0 && r[1] * s - y < grow; y--) {
    if (hitsBody(y / s)) break;
    if (rows[y]) { blank = 0; out[1] = y / s; if (minX[y] >= 0) { out[0] = Math.min(out[0], minX[y] / s); out[2] = Math.max(out[2], maxX[y] / s); } }
    else if (++blank >= BLANK) break;
  }
  return out;
}


// 大图和长表格常被分页切成两半。PDF 里它们是两页上的独立对象，但对读者是一张图。
// 判据：前页那块贴着页底、后页那块贴着页顶、两者横向范围大致重合。
async function stitchCrossPage(blocks, pageSize, mkCanvas, toBlob, scale) {
  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    const a = blocks[i], b = blocks[i + 1];
    const pa = pageSize[a?.page], pb = pageSize[b?.page];
    if (a?.kind === 'graphic' && b?.kind === 'graphic' && pa && pb
        && b.page === a.page + 1 && a.blob && b.blob) {
      // 阈值要容得下页脚区：这份白皮书的图距页底有 100pt 以上。
      // "a 是前页最后一个块、b 是后页第一个块" 由遍历顺序天然保证，误合并风险已经很低。
      const gapBottom = pa.h - a.bbox[3];          // 前页那块离页底多远
      const gapTop = b.bbox[1];                    // 后页那块离页顶多远
      const ov = Math.min(a.bbox[2], b.bbox[2]) - Math.max(a.bbox[0], b.bbox[0]);
      const un = Math.max(a.bbox[2], b.bbox[2]) - Math.min(a.bbox[0], b.bbox[0]);
      if (gapBottom < 135 && gapTop < 135 && un > 0 && ov / un > 0.55
          && a.h > 50 && b.h > 50) {
        try {
          const [ia, ib] = await Promise.all([createImageBitmap(a.blob), createImageBitmap(b.blob)]);
          const x0 = Math.min(a.bbox[0], b.bbox[0]);
          const offA = Math.round((a.bbox[0] - x0) * scale);
          const offB = Math.round((b.bbox[0] - x0) * scale);
          const W = Math.max(offA + ia.width, offB + ib.width);
          const H = ia.height + ib.height;
          const c = mkCanvas(W, H);
          const cx = c.getContext('2d');
          cx.fillStyle = '#fff'; cx.fillRect(0, 0, W, H);
          cx.drawImage(ia, offA, 0);
          cx.drawImage(ib, offB, ia.height);
          ia.close?.(); ib.close?.();
          out.push({ ...a, blob: await toBlob(c),
                     w: Math.round(W / scale), h: Math.round(H / scale),
                     stitched: true });
          i++;                                     // b 已被并入，跳过
          continue;
        } catch { /* 拼接失败就保持原样 */ }
      }
    }
    out.push(a);
  }
  return out;
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
  let L = layout;
  if (L.autoProfile !== false) {
    L = await profileDocument(doc, L);
    const p0 = await doc.getPage(1);
    const w0 = p0.getViewport({ scale: 1 }).width;
    if (L._profile) L.bodyX1Min = Math.round(w0 - L._profile.bodyX0 - w0 * 0.12);
    p0.cleanup();
    if (onProgress && L._profile) {
      console.info('[paper-lens] 版面自适应:', JSON.stringify({
        正文字号: L._profile.bodySize, 正文左边界: L._profile.bodyX0,
        推出的字号区间: L.bodySize, 顶格线: L.bodyX0Max, 满行线: L.bodyX1Min,
      }));
    }
  }
  const scale = L.dpi / 72;
  const blocks = [];
  const pageSize = {};
  let gi = 0;

  // OffscreenCanvas 不受页面可见性节流影响 —— 用户切走标签页时解析仍继续
  const OC = typeof OffscreenCanvas !== 'undefined';
  const mkCanvas = (w, h) => OC ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const IMG_TYPE = layout.imageType || 'image/webp';
  const IMG_Q = layout.imageQuality ?? 0.92;
  const toBlob = (c) => OC ? c.convertToBlob({ type: IMG_TYPE, quality: IMG_Q })
    : new Promise(r => c.toBlob(r, IMG_TYPE, IMG_Q));

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
    pageSize[pno - 1] = { w: vp1.width, h: vp1.height };
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
    const lines = groupLines(spans, L.lineTol).filter(l => !isHeaderFooter(l, L, vp1.height));
    const raw = groupBlocks(lines, L);

    const texts = [], gRects = [];
    for (const b0 of raw) {
      for (const b of splitMixed(b0, L)) {
        const kind = classify(b, L, vp1.height);
        if (!kind) continue;
        const bbox = [b.x0, b.yTop, b.x1, b.yBot];
        if (kind === 'graphic') gRects.push(bbox);
        else texts.push({ kind, text: b.text, size: b.size, font: b.font, bbox, page: pno - 1 });
      }
    }

    // 墨迹投影：把已渲染的大图缩到 72dpi 再一次性取像素，逐行记录有没有内容。
    // 直接在 200dpi 画布上按区域取 getImageData 会慢 15 倍，实测 85 页从 5s 涨到 80s。
    // 且多数页面根本没有图，所以延迟到第一次真正需要时才计算。
    let inkCache = null;
    const INK_S = 0.5;                     // 墨迹检测分辨率（相对 72dpi）
    const getInk = () => {
      if (inkCache) return inkCache;
      const W = Math.ceil(vp1.width * INK_S), H = Math.ceil(vp1.height * INK_S);
      ink.width = W; ink.height = H;
      ictx.fillStyle = '#fff';
      ictx.fillRect(0, 0, W, H);
      ictx.drawImage(cv, 0, 0, W, H);
      const d = ictx.getImageData(0, 0, W, H).data;
      const rows = new Uint8Array(H);
      const minX = new Int16Array(H).fill(-1);
      const maxX = new Int16Array(H).fill(-1);
      // 一次扫描同时得到：该行有无墨迹、墨迹的左右边界。后面定图形区的 x 范围直接查表，
      // 不必再对每个区域做一次整块列投影（那样 85 页会从 11s 涨到近 60s）。
      for (let y = 0; y < H; y++) {
        const base = y * W * 4;
        let mn = -1, mx = -1;
        for (let x = 0; x < W; x++) {
          const i = base + x * 4;
          if (d[i] < 248 || d[i + 1] < 248 || d[i + 2] < 248) { if (mn < 0) mn = x; mx = x; }
        }
        rows[y] = mn >= 0 ? 1 : 0; minX[y] = mn; maxX[y] = mx;
      }
      inkCache = { d, rows, minX, maxX, W, H, s: INK_S };
      return inkCache;
    };
    const getInkRows = () => getInk().rows;

    // 间隙里若夹着正文，说明本来就是两块内容，不桥接；否则看这段空白里有没有墨迹
    const bridge = (band) => {
      if (band[3] - band[1] <= 0) return false;
      if (texts.some(t => t.bbox[3] > band[1] + 1 && t.bbox[1] < band[3] - 1)) return false;
      const ik = getInk();
      const rows = ik.rows;
      const y0 = Math.max(0, Math.floor(band[1] * ik.s));
      const y1 = Math.min(rows.length - 1, Math.ceil(band[3] * ik.s));
      for (let y = y0; y <= y1; y++) if (rows[y]) return true;
      return false;
    };

    let regions = mergeGraphics(gRects, L, vp1.width, vp1.height, bridge);
    // 纯位图/无标注矢量图不会产生任何文本碎块，聚类看不见它们，得靠墨迹主动找
    if (L.findFigures !== false) {
      const extra = findFigureRegions(texts, regions, getInk(), L.minFigureH || 40);
      regions = regions.concat(extra);
      regions.sort((a, b) => a[1] - b[1]);
    }

    // 只有顶格的正文能作为图形区的边界；表头、数据行这些是可以被吸收的
    const bodyLines = texts.filter(t => (t.kind === 'para' || t.kind === 'note')
                                     && t.bbox[0] < L.bodyX0Max);
    if (L.expandFigures !== false) {
      regions = regions.map(r => expandRegion(r, getInk(), bodyLines, L));
    }

    // 被图形区吞掉的文本块要从正文里摘掉，否则表格内容会在译文里重复一遍
    const inside = new Set();
    for (const r of regions) {
      if (r[3] - r[1] < 80) continue;
      texts.forEach((t, i) => {
        if (t.bbox[1] >= r[1] - 2 && t.bbox[3] <= r[3] + 2
            && t.bbox[0] >= r[0] - 8 && t.bbox[2] <= r[2] + 8) inside.add(i);
      });
    }
    const out = texts.filter((_, i) => !inside.has(i));
    const textOnly = out.slice();

    for (const r0 of regions) {
      // 外扩的 padding 会吃进相邻正文行，截出来就是"图 + 半行被裁的字"。这里按上下
      // 最近的文本块回缩边界。
      const r = [...r0];
      for (const t of textOnly) {
        if (t.bbox[1] >= r0[3] - 1 && t.bbox[1] < r[3]) r[3] = t.bbox[1] - 1;
        if (t.bbox[3] <= r0[1] + 1 && t.bbox[3] > r[1]) r[1] = t.bbox[3] + 1;
      }
      if (r[3] - r[1] < L.minGraphicH) continue;
      // 与正文块重叠度过高 => 会把正文重复截一遍
      if (textOnly.some(t => overlapRatio(t.bbox, r) > 0.6)) continue;
      // 只丢弃"矮于一行且落在段落内"的碎片（上下标）。原来按重叠比例一刀切，
      // 会把夹在两段之间的独立公式整个误杀，表现为公式凭空消失。
      if ((r[3] - r[1]) < 30
          && textOnly.some(t => t.kind !== 'graphic' && overlapRatio(r, t.bbox) > 0.55)) continue;
      const w = Math.round((r[2] - r[0]) * scale), h = Math.round((r[3] - r[1]) * scale);
      if (w < 4 || h < 4) continue;
      crop.width = w; crop.height = h;
      cctx.clearRect(0, 0, w, h);
      cctx.drawImage(cv, Math.round(r[0] * scale), Math.round(r[1] * scale), w, h, 0, 0, w, h);
      gi++;
      out.push({ kind: 'graphic', text: '', page: pno - 1, bbox: r,
                   blob: await toBlob(crop),
                   w: Math.round(r[2] - r[0]), h: Math.round(r[3] - r[1]) });
    }

    out.sort((a, b) => Math.round(a.bbox[1] / 3) - Math.round(b.bbox[1] / 3) || a.bbox[0] - b.bbox[0]);
    blocks.push(...out);
    page.cleanup();
    if (onProgress) onProgress(pno, lastPage);
  }

  const stitched = (L.stitchCrossPage !== false)
    ? await stitchCrossPage(blocks, pageSize, mkCanvas, toBlob, scale)
    : blocks;
  return finalize(stitched);
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
