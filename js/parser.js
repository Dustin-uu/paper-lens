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


// 分栏检测。按 y 聚行的前提是单栏；一旦页面分栏，左右两栏同一水平位置的行会被
// 当成一行，正文就此左右交错。
// 难点是混合布局：一页里往往上半是通栏段落、下半才分栏，对整页做 x 投影时通栏段落
// 会把栏间空隙填满。所以改为按 y 分带逐带找空隙，再取众数，并只在真正分栏的那段
// y 区间里分栏。
function findGapCenter(items, pageW, minGap) {
  const cover = new Uint16Array(Math.ceil(pageW) + 2);
  for (const it of items) {
    const a = Math.max(0, Math.floor(it.x0)), b = Math.min(cover.length - 1, Math.ceil(it.x1));
    for (let x = a; x <= b; x++) cover[x]++;
  }
  let best = null, bestW = 0, start = -1;
  for (let x = 0; x < cover.length; x++) {
    if (!cover[x]) { if (start < 0) start = x; }
    else {
      if (start >= 0 && x - start >= minGap && start > pageW * 0.25 && x < pageW * 0.75
          && x - start > bestW) { bestW = x - start; best = (start + x) / 2; }
      start = -1;
    }
  }
  return best;
}

function detectColumnZone(spans, pageW, pageH, minGap) {
  if (spans.length < 40) return null;
  const BAND = 36;
  const n = Math.ceil(pageH / BAND);
  const perBand = [];
  for (let i = 0; i < n; i++) {
    const inBand = spans.filter(sp => sp.yBase >= i * BAND && sp.yBase < (i + 1) * BAND);
    perBand.push(inBand.length >= 4 ? findGapCenter(inBand, pageW, minGap) : null);
  }
  // 取出现最多的切分位置（±16pt 视为同一处）
  const groups = [];
  for (const c of perBand) {
    if (c == null) continue;
    const g = groups.find(x => Math.abs(x.c - c) < 16);
    if (g) { g.n++; g.c = (g.c * (g.n - 1) + c) / g.n; } else groups.push({ c, n: 1 });
  }
  const top = groups.sort((a, b) => b.n - a.n)[0];
  if (!top || top.n < 3) return null;              // 至少连续几带都分栏才算数
  let y0 = Infinity, y1 = -Infinity;
  perBand.forEach((c, i) => {
    if (c != null && Math.abs(c - top.c) < 16) {
      y0 = Math.min(y0, i * BAND); y1 = Math.max(y1, (i + 1) * BAND);
    }
  });
  // 真正的分栏，绝大多数行都只落在某一侧；如果多数行横跨分界线，那条"空隙"
  // 其实是表格列缝或公式间距，按分栏处理反而会把正文顺序打乱。
  const M = 10;
  const crosses = sp => sp.x0 < top.c - M && sp.x1 > top.c + M;
  const cross = spans.filter(crosses).length;
  const leftSp = spans.filter(sp => !crosses(sp) && (sp.x0 + sp.x1) / 2 < top.c);
  const rightSp = spans.filter(sp => !crosses(sp) && (sp.x0 + sp.x1) / 2 >= top.c);
  const total = spans.length;
  if (cross > total * 0.45) return null;
  if (leftSp.length < total * 0.15 || rightSp.length < total * 0.15) return null;

  // 表格的列缝和分栏的栏缝，光看空白是一模一样的 —— 这正是分栏检测以前误伤 22 页的原因。
  // 真正能分开两者的是基线：表格每一行在缝隙两侧都有单元格，基线严丝合缝地对齐；
  // 而两栏正文各走各的行距，左右基线几乎从不重合。
  // 实测：NVIDIA 那两页真双栏重合率 0.08 / 0.14，两份文档里 25 个表格页全在 0.54 以上。
  const rset = new Set(rightSp.map(sp => Math.round(sp.yBase * 2) / 2));
  const lrows = [...new Set(leftSp.map(sp => Math.round(sp.yBase * 2) / 2))];
  if (lrows.length < 6) return null;
  let both = 0;
  for (const y of lrows) if (rset.has(y) || rset.has(y + 0.5) || rset.has(y - 0.5)) both++;
  if (both / lrows.length > 0.35) return null;              // 基线对齐 => 是表格，不是分栏
  return { cut: top.c, y0, y1 };
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
      // 与正文同字号的小标题靠这条分出来。但判据必须是"整行都粗"而不是"主导字体是粗体"：
      // 学术论文里大量段落以粗体引导词开头（"What we add. 正文正文…"），那一行粗体字数
      // 往往过半，于是每个列表项的第一行都被单独切成一块，再因为不顶格而变成一张一行字的图片。
      // 判据是"这行以粗体收尾"，不是"粗体字多"：真正的小标题整行都粗、收尾也粗；
      // 段首引导词后面必然跟着正体（"…with complete proofs. Proposi-"），按字数算
      // 粗体能占到八成以上，只看比例分不开。
      const headingish = (l) => {
        const sp = l.spans;
        if (!sp.length || !BOLD_RE.test(sp[sp.length - 1].font)) return false;
        let bold = 0, all = 0;
        for (const x of sp) { all += x.str.length; if (BOLD_RE.test(x.font)) bold += x.str.length; }
        return all > 0 && bold / all >= 0.5;
      };
      const boldSame = headingish(ln) === headingish(prev);
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

// 行内最大空档。表格的列缝有十几到几十 pt，正文的词距顶多几 pt。
function maxGapIn(line) {
  const sp = line.spans;
  let g = 0;
  for (let i = 1; i < sp.length; i++) g = Math.max(g, sp[i].x0 - sp[i - 1].x1);
  return g;
}

// "这读着像不像一段话"：够长、虚词够多、有句末标点。
function looksProse(text) {
  const w = text.toLowerCase().match(/[a-z][a-z'-]+/g) || [];
  if (w.length < 12) return false;
  let n = 0;
  for (const x of w) if (STOPWORDS.has(x)) n++;
  return n >= 3 && /[.!?]/.test(text);
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

  // 兜底：多行、左边界齐、读着像话 —— 那就是正文，不管它多宽、缩进多少。
  // 上面每条规则都挂着一个硬编码的宽度或缩进阈值，换一份文档就失效：
  // 某篇 arXiv 论文的摘要宽 325pt（abstractMinW 是 350）、编号列表缩进到 x=89
  // （学出来的顶格线是 81），两处都整段被截成图，整页读不了。
  // 这里只看三件与版面无关的事：分了几行、左边界齐不齐、像不像人话。
  // 单行的也要救：列表项开头那行"1. 粗体小标题。正文正文"会被 splitMixed 切成独立块，
  // 一行、又不顶格，于是整行变成一张图片卡。但单行证据弱，额外要求它铺满正文宽度 ——
  // 图例、坐标轴标签不会有这么长。
  const bodyW = Math.max(120, L.bodyX1Min - L.bodyX0Max);
  const longEnough = b.lines.length >= 2 || (b.x1 - b.x0) > bodyW * 0.85;
  if (longEnough && size >= L.footnoteSize[0] - 0.8 && size <= L.bodySize[1] + 0.8
      && !isMath(text) && !isTabular(text) && looksProse(text)) {
    const xs = b.lines.map(l => l.x0);
    const wide = b.lines.filter(l => maxGapIn(l) > Math.max(12, l.size * 1.2)).length;
    // 列缝是区分"附录三列表"和"段落"的唯一可靠信号：那种表虚词多得完全像散文
    if (Math.max(...xs) - Math.min(...xs) < 26 && wide / b.lines.length <= 0.34) {
      return size > L.footnoteSize[1] ? 'para' : 'note';
    }
  }

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
export async function withUnthrottledRaf(fn) {
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
  const ink = mkCanvas(8, 8);                 // 墨迹检测用的低分辨率副本
  const ictx = ink.getContext('2d', { willReadFrequently: true });

  // 图片编码是整个解析里最贵的一环（单张 WebP 约 50ms，一篇论文七八十张）。
  // convertToBlob 本身在主线程外跑，串行 await 等于白白排队：实测 20 张
  // 串行 1022ms、并行 359ms。所以攒够一批再一起等，让编码和下一页的渲染重叠。
  // 不无限攒是因为每张在飞的裁图都占着一块 200dpi 画布，几十 MB 起步。
  // 按张数和像素双重封顶：整页大图一张就有上千万像素，只数张数会把内存吃爆。
  const ENC_BATCH = 16, ENC_PIXELS = 24e6;
  let inflight = [], inflightPx = 0;
  const flushEncodes = async () => {
    const b = inflight; inflight = []; inflightPx = 0; await Promise.all(b);
  };
  const encodeInto = async (canvas, blk) => {
    inflight.push(toBlob(canvas).then(b => { blk.blob = b; }));
    inflightPx += canvas.width * canvas.height;
    if (inflight.length >= ENC_BATCH || inflightPx >= ENC_PIXELS) await flushEncodes();
  };

  const lastPage = Math.min(doc.numPages, maxPages || doc.numPages);
  for (let pno = 1; pno <= lastPage; pno++) {
    const page = await doc.getPage(pno);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale });
    pageSize[pno - 1] = { w: vp1.width, h: vp1.height };
    cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
    ctx.clearRect(0, 0, cv.width, cv.height);
    // 取文字和渲染互不依赖，同时发出去省掉每页约 40ms 的串行等待。
    // 但字体名要等渲染完才在 commonObjs 里，所以 fontMap 仍放在后面。
    const tcPromise = page.getTextContent();
    await page.render({ canvasContext: ctx, viewport: vp }).promise;   // 渲染同时让字体就绪

    const fontMap = {};
    const tc = await tcPromise;
    for (const it of tc.items) {
      if (it.fontName && !(it.fontName in fontMap)) {
        try {
          fontMap[it.fontName] = page.commonObjs.has(it.fontName)
            ? (page.commonObjs.get(it.fontName)?.name || '') : '';
        } catch { fontMap[it.fontName] = ''; }
      }
    }

    const spans = toSpans(tc, vp1, fontMap);
    // 分栏必须在聚行之前判定：一旦按整页 y 聚行，左右两栏的行就被并成一行了
    const zone = L.detectColumns === false ? null
      : detectColumnZone(spans, vp1.width, vp1.height, L.minColumnGap || 6);
    let lines;
    if (zone) {
      // 分栏区之外（通栏部分）仍按整页聚行，区内左右两栏各自聚行
      const groupsOf = [];
      // 用"是否横跨分界线"来分，而不是用检测到 gap 的 y 范围 —— 后者往往只覆盖
      // 部分带，栏内其余段落会漏回通栏，又被整页聚行搅在一起。
      // 通栏的行必然横跨分界线，栏内的行必然只在一侧。
      const M = 10;
      const outside = spans.filter(sp => sp.x0 < zone.cut - M && sp.x1 > zone.cut + M);
      const inLeft = spans.filter(sp => !(sp.x0 < zone.cut - M && sp.x1 > zone.cut + M)
                                     && (sp.x0 + sp.x1) / 2 < zone.cut);
      const inRight = spans.filter(sp => !(sp.x0 < zone.cut - M && sp.x1 > zone.cut + M)
                                      && (sp.x0 + sp.x1) / 2 >= zone.cut);
      groupsOf.push([outside, undefined], [inLeft, 0], [inRight, 1]);
      lines = [];
      for (const [sp, col] of groupsOf) {
        if (!sp.length) continue;
        const ls = groupLines(sp, L.lineTol);
        ls.forEach(l => { l._col = col; });
        lines.push(...ls);
      }
    } else {
      lines = groupLines(spans, L.lineTol);
    }
    // 页眉页脚要剔除，但不能就此当它们不存在：它们的墨迹还留在页面上，
    // 一旦没有任何文本块认领，findFigureRegions 就会把这行字当成"无标注插图"截成图片。
    // 所以剔除的同时把位置记下来占位。
    const hfBoxes = [];
    lines = lines.filter(l => {
      if (!isHeaderFooter(l, L, vp1.height)) return true;
      hfBoxes.push({ kind: 'skip', bbox: [l.x0, l.yTop, l.x1, l.yBot] });
      return false;
    });
    // "顶格线"和"满行线"是整页的常数，可分栏之后右栏的左边界在页面中间，
    // 右栏没有任何一行能算顶格、也没有一行能算满行 —— classify 于是把整栏正文
    // 全判成 graphic，右半页凭空消失。所以分栏后每栏都要用自己的边界重新算。
    const colBox = {};
    if (zone) {
      for (const c of [0, 1]) {
        const ls = lines.filter(l => l._col === c);
        if (ls.length) colBox[c] = [Math.min(...ls.map(l => l.x0)), Math.max(...ls.map(l => l.x1))];
      }
    }
    const indentTol = Math.max(18, L.bodyX0Max - (L._profile?.bodyX0 ?? 54));
    const layoutFor = (col) => {
      const cb = col === undefined ? null : colBox[col];
      if (!cb) return L;
      return { ...L, bodyX0Max: cb[0] + indentTol, bodyX1Min: cb[0] + (cb[1] - cb[0]) * 0.72 };
    };

    let raw;
    if (zone) {
      raw = [];
      for (const col of [undefined, 0, 1]) {
        const ls = lines.filter(l => l._col === col);
        if (!ls.length) continue;
        const blocks = groupBlocks(ls, layoutFor(col));
        blocks.forEach(b => { b._col = col; });
        raw.push(...blocks);
      }
    } else {
      raw = groupBlocks(lines, L);
    }

    const texts = [], gRects = [];
    for (const b0 of raw) {
      const BL = layoutFor(b0._col);
      for (const b of splitMixed(b0, BL)) {
        const kind = classify(b, BL, vp1.height);
        if (!kind) continue;
        const bbox = [b.x0, b.yTop, b.x1, b.yBot];
        // 分节页眉（"Introduction" / "DLSS 4" / "APPENDIX A: …"）每隔几页就换一次内容，
        // 跨页比对的黑名单按定义抓不住它们；而一行右对齐的小字又匹配不上任何正文规则，
        // 最后一路落进 graphic，被当成插图截图出来 —— 正文里于是凭空多出一张张
        // 只写着章节名的白卡片。实测这份白皮书 86 张图里有 16 张是这么来的。
        // 判据只看形状，不看内容：页边带内、单行、短、不宽。真正的插图不长这样。
        if (kind === 'graphic' && b.text && b.lines.length === 1 && b.text.length <= 60
            && (b.x1 - b.x0) < vp1.width * 0.6
            && (b.yTop < vp1.height * 0.09 || b.yBot > vp1.height * 0.91)) {
          hfBoxes.push({ kind: 'skip', bbox });
          continue;
        }
        if (kind === 'graphic') gRects.push(bbox);
        else texts.push({ kind, text: b.text, size: b.size, font: b.font, bbox, page: pno - 1,
                          _col: b0._col });
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
      const extra = findFigureRegions(texts.concat(hfBoxes), regions, getInk(), L.minFigureH || 40);
      regions = regions.concat(extra);
      regions.sort((a, b) => a[1] - b[1]);
    }

    // 只有顶格的正文能作为图形区的边界；表头、数据行这些是可以被吸收的
    // 页眉页脚同样是硬边界：图不该越过它们长上去
    const bodyLines = texts.filter(t =>
      t.kind === 'caption' || t.kind === 'heading'
      || ((t.kind === 'para' || t.kind === 'note') && t.bbox[0] < L.bodyX0Max)).concat(hfBoxes);
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
      // 与某个文本块大面积重叠时，先试着把边界收到它外面；收不动才放弃这一块
      for (const t of textOnly) {
        if (overlapRatio(t.bbox, r) <= 0.6) continue;
        if (t.bbox[1] > r[1] + 20) r[3] = Math.min(r[3], t.bbox[1] - 1);
        else if (t.bbox[3] < r[3] - 20) r[1] = Math.max(r[1], t.bbox[3] + 1);
      }
      if (r[3] - r[1] < L.minGraphicH) continue;
      if (textOnly.some(t => overlapRatio(t.bbox, r) > 0.6)) continue;
      // 只丢弃"矮于一行且落在段落内"的碎片（上下标）。原来按重叠比例一刀切，
      // 会把夹在两段之间的独立公式整个误杀，表现为公式凭空消失。
      if ((r[3] - r[1]) < 30
          && textOnly.some(t => t.kind !== 'graphic' && overlapRatio(r, t.bbox) > 0.55)) continue;
      const w = Math.round((r[2] - r[0]) * scale), h = Math.round((r[3] - r[1]) * scale);
      if (w < 4 || h < 4) continue;
      // 每张裁图用一块独立画布：共用一块就必须等编码完才能画下一张，等于串行。
      const crop = mkCanvas(w, h);
      crop.width = w; crop.height = h;
      const cctx = crop.getContext('2d');
      cctx.drawImage(cv, Math.round(r[0] * scale), Math.round(r[1] * scale), w, h, 0, 0, w, h);
      gi++;
      const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2;
      const gcol = !zone ? undefined
        : (r[0] < zone.cut - 10 && r[2] > zone.cut + 10) ? undefined
        : (cx < zone.cut ? 0 : 1);
      const blk = { kind: 'graphic', text: '', page: pno - 1, bbox: r, _col: gcol,
                    blob: null,
                    w: Math.round(r[2] - r[0]), h: Math.round(r[3] - r[1]) };
      await encodeInto(crop, blk);
      out.push(blk);
    }

    // 分栏页要先读完一栏再读下一栏，不能按整页的 y 排
    // 通栏内容按原位置排；分栏区内先读完左栏再读右栏
    const ck = v => v === undefined ? -1 : v;
    out.sort((a, b) => (ck(a._col) - ck(b._col))
      || Math.round(a.bbox[1] / 3) - Math.round(b.bbox[1] / 3) || a.bbox[0] - b.bbox[0]);
    blocks.push(...out);
    page.cleanup();
    if (onProgress) onProgress(pno, lastPage);
  }

  // 收尾阶段也要报进度：否则最后一页跑完到翻译开始之间界面一动不动，看着像卡死
  onProgress?.(lastPage, lastPage, '正在合并跨页图…');
  await flushEncodes();          // 最后一批不足 ENC_BATCH，这里收尾
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
