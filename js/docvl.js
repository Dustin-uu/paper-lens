// 文档解析模型（PaddleOCR-VL 这类）客户端。
//
// 它只干一件事：把一块裁图还原成干净文本/表格。这恰好是本项目最弱的一环 ——
// PDF.js 的 getTextContent 只给字符和坐标，双栏页和表格区域抠出来的字是左右交错的
// 乱码（"control how graphics are rendered andHere's a brief overview of"），
// 拿去翻译等于翻译垃圾。
//
// 但实测也划出了它的边界，这些边界在下面都写成了代码：
//   1. 公式会错。KKT 那页结构对、下标错、脚注号被吸进公式。所以公式区一律不碰，
//      只把识别结果当附注存起来给 AI 侧栏用，绝不拿来替换截图。
//   2. 插图会丢或会炸。一张折线图它直接当不存在；一张多面板图它去 OCR 每个标注，
//      冲到 6000 token 上限吐一堆重复。所以要限 token，并且检测复读。
//   3. 它毕竟是生成模型，会编。所以每个结果都要和 PDF 自带文本层对一遍，
//      对不上就只当附注、绝不拿来替换截图。

import { chat, blobToDataUrl } from './llm.js';

export const TASK_PARSE = 'Document Parsing';

// 只按字母数字比对：模型会规范化空格、接回连字符、把 ﬁ 拆开，这些差异不该算分歧
const norm = t => String(t).toLowerCase().replace(/[^a-z0-9]/g, '');

export function configured(cfg) {
  return !!(cfg.ocrBaseUrl && cfg.ocrModel);
}

// 端点可以和翻译用的是两家，所以自己拼一份 cfg
function ocrCfg(cfg) {
  return {
    baseUrl: cfg.ocrBaseUrl,
    apiKey: cfg.ocrApiKey || cfg.apiKey,
    model: cfg.ocrModel,
    timeoutMs: 120000,
  };
}

// 复读检测：模型在图里迷路时会一行一行重复。去重后剩不到四成，判定为跑飞。
function runaway(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 4);
  if (lines.length < 8) return false;
  return new Set(lines).size / lines.length < 0.4;
}

// 和 PDF 文本层对账：模型认出来的东西，原文里得确实有。
// 用"原文有多少字在识别结果里出现"来算，因为模型可能多识别（图里的标注），
// 但不该少识别，更不该凭空造。
function agrees(ocrText, pdfText) {
  const a = norm(ocrText), b = norm(pdfText);
  if (b.length < 20) return { ok: false, cover: 0 };
  // 逐段比对：把原文切成 24 字一段，看有多少段能在识别结果里找到
  let hit = 0, n = 0;
  for (let i = 0; i + 24 <= b.length; i += 24) {
    n++;
    if (a.includes(b.slice(i, i + 24))) hit++;
  }
  return { ok: n > 0 && hit / n >= 0.6, cover: n ? hit / n : 0 };
}

// 表格它用的是 OTSL 标记而不是 markdown：<fcel> 单元格、<lcel>/<ucel> 合并占位、<nl> 换行。
// 原样存下来给 AI 看就是一串噪声，先翻成 "a | b | c" 的行。
const OTSL_RE = /<(fcel|ecel|lcel|ucel|xcel|nl|ched|rhed|srow)>/;
function fromOtsl(t) {
  return t
    .replace(/<(lcel|ucel|xcel)>/g, '<fcel>')        // 合并单元格：占个空位，别错列
    .replace(/<nl>/g, '\n')
    .replace(/<(ched|rhed|srow)>/g, '')
    .split('\n')
    .map(line => line.split(/<(?:fcel|ecel)>/).map(c => c.trim()).filter((c, i, a) => !(i === 0 && !c))
      .join(' | ').trim())
    .filter(Boolean)
    .join('\n');
}

const TABLE_RE = /^\s*\S.*\|.*\|/m;                 // markdown 风格的 "a | b | c" 行
const MATH_RE = /\\\[|\\begin\{|\\frac|\\sum|\$\$/;

// 识别结果是什么东西：表格 / 公式 / 纯文字。决定后面怎么用它。
export function shapeOf(text) {
  const rows = (text.match(/^.*\|.*\|.*$/gm) || []).length;
  if (rows >= 2 || TABLE_RE.test(text) && rows >= 1) return 'table';
  if (MATH_RE.test(text)) return 'math';
  return 'text';
}

/**
 * 识别一块裁图。
 * @returns {{ok:boolean, text?:string, shape?:string, cover?:number, why?:string}}
 */
export async function recognize(cfg, blob, pdfText, opts = {}) {
  let raw;
  try {
    const url = await blobToDataUrl(blob);
    raw = await chat(ocrCfg(cfg), [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url } },
        { type: 'text', text: opts.task || TASK_PARSE },
      ],
    }], {
      model: cfg.ocrModel,
      // 限死上限：插图区会让它一路复读到天亮，实测能冲到 6000
      maxTokens: opts.maxTokens || 2200,
      temperature: 0,
      timeoutMs: 120000,
    });
  } catch (e) {
    return { ok: false, why: '调用失败：' + (e.message || e) };
  }

  let text = String(raw || '').trim();
  if (OTSL_RE.test(text)) text = fromOtsl(text);
  if (!text) return { ok: false, why: '空结果' };
  if (runaway(text)) return { ok: false, why: '模型复读跑飞' };

  // ok 的含义很窄：**能不能拿它替换掉截图**。对不上账就不能替换。
  // 但不等于这份识别结果没用 —— 公式区尤其典型：PDF 自带文本层把
  // "∥μ₂−μ₀∥ ≥ γ" 存成 "∥μ−μ∥−1≥γ >0. 20Σ"，拿这种乱码去对账必然不过，
  // 而模型给出的 LaTeX 恰恰比文本层准得多。所以照样把结果带回去，
  // 只当附注挂在图上给 AI 侧栏用，绝不替换正文。
  const { ok, cover } = agrees(text, pdfText || '');
  return {
    ok, text, shape: shapeOf(text), cover,
    why: ok ? '' : `与原文对不上（覆盖 ${(cover * 100).toFixed(0)}%），只作附注不替换`,
  };
}

// 并发池。逐个发太慢（一页 3~5s），但也不能放开 —— 这是别人的网关。
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k], k); }
      catch (e) { out[k] = { ok: false, why: String(e.message || e) }; }
    }
  }));
  return out;
}
