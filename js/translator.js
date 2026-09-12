// 块 -> 译文。按字符数打包成批 + 并发 + 缓存，编号错位时降级为逐块翻译。
import { chat } from './llm.js';
import { GLOSSARY } from './config.js';
import { TRANSLATE_KINDS } from './parser.js';

const SEP_RE = /^<<<(\d+)>>>\s*$/m;
const SEP_SPLIT = /^<<<(\d+)>>>\s*$/gm;
const SEP_STRIP = /<<<\s*\d+\s*>>>\s*/g;

function glossaryFor(texts) {
  const blob = texts.join(' ').toLowerCase();
  const hits = [];
  for (const [k, v] of Object.entries(GLOSSARY)) {
    if (blob.includes(k.toLowerCase())) hits.push(`${k} → ${v}`);
    if (hits.length >= 40) break;
  }
  return hits.join('；');
}

function sysPrompt(terms, lang) {
  let p = `你是学术论文翻译专家，把英文译成${lang}。要求：
1. 术语准确、语体正式，符合中文学术写作习惯；
2. 人名、机构名、期刊名、文献引用（如 Gu et al. (2020)）保留原文不译；
3. 数学符号、变量名、公式编号（如 (6)）原样保留；
4. 不要添加任何解释、注释或译者按；不要输出原文；
5. 严格保持输入的 <<<编号>>> 分段结构，逐段对应输出译文。`;
  if (terms) p += `\n\n本批术语对照（必须遵循）：\n${terms}`;
  return p;
}

function splitNumbered(out, n) {
  const parts = out.split(SEP_SPLIT);
  const res = new Map();
  for (let i = 1; i + 1 < parts.length + 1 && i < parts.length; i += 2) {
    const idx = parseInt(parts[i], 10);
    if (!Number.isNaN(idx)) res.set(idx, (parts[i + 1] || '').trim());
  }
  if (res.size !== n) return null;
  for (let i = 1; i <= n; i++) if (!res.has(i)) return null;
  return Array.from({ length: n }, (_, i) => res.get(i + 1));
}

async function callWithRetry(cfg, messages, opts, retry) {
  let last;
  for (let i = 0; i < retry; i++) {
    try { return await chat(cfg, messages, opts); }
    catch (e) { last = e; await new Promise(r => setTimeout(r, 1200 * (i + 1))); }
  }
  throw last;
}

async function doBatch(cfg, batch) {
  const texts = batch.map(b => b.text);
  const terms = glossaryFor(texts);
  const sys = sysPrompt(terms, cfg.targetLang || '简体中文');
  const ask = async (userText, maxTokens) => callWithRetry(cfg,
    [{ role: 'system', content: sys }, { role: 'user', content: userText }],
    { maxTokens }, cfg.retry || 3);

  if (batch.length === 1) {
    const zh = await ask(texts[0], cfg.maxTokens);
    return new Map([[batch[0].id, zh.replace(SEP_STRIP, '').trim()]]);
  }
  const user = texts.map((t, i) => `<<<${i + 1}>>>\n${t}`).join('\n');
  const budget = Math.min(cfg.maxTokens, Math.round(user.length * 1.6) + 2000);
  const out = await ask(user, budget);
  const got = splitNumbered(out, batch.length);
  if (!got) {                                  // 编号错位 -> 逐块重来
    const res = new Map();
    for (const b of batch) {
      const zh = await ask(b.text, cfg.maxTokens);
      res.set(b.id, zh.replace(SEP_STRIP, '').trim());
    }
    return res;
  }
  return new Map(batch.map((b, i) => [b.id, got[i].replace(SEP_STRIP, '').trim()]));
}

/**
 * @param cache  {get(text):Promise<string|null>, put(text,zh):Promise<void>} 可为 null
 * @param onProgress ({done,total,cached,failed}) => void
 */
export async function translate(blocks, cfg, cache, onProgress, shouldStop) {
  const todo = [];
  let cached = 0;
  for (const b of blocks) {
    if (!TRANSLATE_KINDS.has(b.kind) || !b.text.trim()) continue;
    if (b.zh) { cached++; continue; }
    const hit = cache ? await cache.get(b.text) : null;
    if (hit != null) { b.zh = hit; cached++; } else todo.push(b);
  }

  const batches = [];
  let cur = [], curLen = 0;
  for (const b of todo) {
    if (cur.length && curLen + b.text.length > cfg.batchChars) { batches.push(cur); cur = []; curLen = 0; }
    cur.push(b); curLen += b.text.length;
  }
  if (cur.length) batches.push(cur);

  const byId = new Map(blocks.map(b => [b.id, b]));
  let done = 0, failed = 0;
  onProgress?.({ done: 0, total: batches.length, cached, failed: 0 });

  const queue = batches.slice();
  const worker = async () => {
    while (queue.length) {
      if (shouldStop?.()) return;
      const batch = queue.shift();
      try {
        const res = await doBatch(cfg, batch);
        for (const [id, zh] of res) {
          byId.get(id).zh = zh;
          if (cache) await cache.put(byId.get(id).text, zh);
        }
      } catch (e) {
        failed += batch.length;
        for (const b of batch) { b.zh = ''; b.err = String(e.message || e).slice(0, 120); }
      }
      done++;
      onProgress?.({ done, total: batches.length, cached, failed });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, cfg.concurrency) }, worker));
  return blocks;
}

export function countPending(blocks) {
  return blocks.filter(b => TRANSLATE_KINDS.has(b.kind) && b.text.trim() && !b.zh).length;
}
