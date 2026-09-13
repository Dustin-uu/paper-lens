// 应用入口：三个界面（首页 / 处理中 / 阅读）+ 设置 + AI 侧栏。
import { loadSettings, saveSettings, loadLayout, saveLayout, LAYOUT, PRESETS, DEFAULTS } from './config.js';
import { parsePdf } from './parser.js';
import { parsePdfVL } from './parser-vl.js';
import * as docvl from './docvl.js';
import { translate, countPending } from './translator.js';
import { testConnection, listModels, testVision } from './llm.js';
import * as store from './store.js';
import { Reader, buildToc, pickTitle } from './reader.js';
import { Conversation, contextAround, sectionOf, PRESET_QUESTIONS } from './ai.js';
import { runAudit, auditSummary } from './audit.js';

const $ = s => document.querySelector(s);
const D = document.documentElement;
let cfg = loadSettings();
let doc = null;            // 当前文档
let convo = null;          // 当前 AI 会话
let stopFlag = false;

// ---------- 偏好 ----------
D.dataset.view = localStorage.getItem('v') || 'zh-first';
D.dataset.theme = localStorage.getItem('t') || 'light';
D.dataset.toc = localStorage.getItem('c') || 'on';
let fontSize = +(localStorage.getItem('f') || 17);
const applyFont = () => document.querySelectorAll('#content .zh')
  .forEach(e => e.style.fontSize = fontSize + 'px');
const syncViews = () => document.querySelectorAll('#views button')
  .forEach(b => b.setAttribute('aria-pressed', b.dataset.v === D.dataset.view));
syncViews();

$('#views').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  D.dataset.view = b.dataset.v; localStorage.setItem('v', b.dataset.v); syncViews();
};
$('#btheme').onclick = () => {
  D.dataset.theme = D.dataset.theme === 'light' ? 'dark' : 'light';
  localStorage.setItem('t', D.dataset.theme);
};
$('#btoc').onclick = () => {
  D.dataset.toc = D.dataset.toc === 'on' ? 'off' : 'on';
  localStorage.setItem('c', D.dataset.toc);
};
$('#fbig').onclick = () => { fontSize = Math.min(fontSize + 1, 24); localStorage.setItem('f', fontSize); applyFont(); };
$('#fsmall').onclick = () => { fontSize = Math.max(fontSize - 1, 13); localStorage.setItem('f', fontSize); applyFont(); };
$('#goHome').onclick = () => showHome();
$('#back').onclick = () => showHome();

// ---------- 设置 ----------
function fillSettings() {
  $('#fBase').value = cfg.baseUrl || '';
  $('#fKey').value = cfg.apiKey || '';
  $('#fModel').value = cfg.model || '';
  $('#fVision').value = cfg.visionModel || '';
  $('#fConc').value = cfg.concurrency;
  $('#fBatch').value = cfg.batchChars;
  $('#fLang').value = cfg.targetLang;
  $('#fAudit').checked = cfg.autoAudit !== false;
  $('#fAuditMax').value = cfg.auditMaxCalls ?? DEFAULTS.auditMaxCalls;
  $('#fOcrBase').value = cfg.ocrBaseUrl || '';
  $('#fOcrKey').value = cfg.ocrApiKey || '';
  $('#fOcrModel').value = cfg.ocrModel || '';
  $('#fOcrMax').value = cfg.ocrMaxCalls ?? DEFAULTS.ocrMaxCalls;
  store.estimateUsage().then(u => {
    store.cacheSize().then(n => {
      $('#usage').textContent = u
        ? `翻译缓存 ${n} 条 · 已用 ${(u.usage / 1048576).toFixed(1)} MB / 可用 ${(u.quota / 1073741824).toFixed(1)} GB`
        : `翻译缓存 ${n} 条`;
    });
  });
}
function fillLayout() {
  const L = loadLayout();
  $('#lDpi').value = L.dpi;
  $('#lLineTol').value = L.lineTol;
  $('#lBlockGap').value = L.blockGap;
  $('#lGraphicGap').value = L.graphicGap;
  $('#lInkBridge').value = L.inkBridgeMax;
  $('#lBodySize').value = L.bodySize.join('-');
}
function readLayout() {
  const L = loadLayout();
  const num = (id, key) => { const v = parseFloat($(id).value); if (!Number.isNaN(v)) L[key] = v; };
  num('#lDpi', 'dpi'); num('#lLineTol', 'lineTol'); num('#lBlockGap', 'blockGap');
  num('#lGraphicGap', 'graphicGap'); num('#lInkBridge', 'inkBridgeMax');
  const m = $('#lBodySize').value.split(/[-~,\s]+/).map(parseFloat).filter(x => !Number.isNaN(x));
  if (m.length === 2) L.bodySize = m;
  return L;
}
$('#btnResetLayout').onclick = () => { saveLayout({ ...LAYOUT }); fillLayout(); };

function readSettings() {
  return {
    ...cfg,
    baseUrl: $('#fBase').value.trim(),
    apiKey: $('#fKey').value.trim(),
    model: $('#fModel').value.trim(),
    visionModel: $('#fVision').value.trim(),
    concurrency: Math.max(1, +$('#fConc').value || DEFAULTS.concurrency),
    batchChars: Math.max(500, +$('#fBatch').value || DEFAULTS.batchChars),
    targetLang: $('#fLang').value.trim() || '简体中文',
    autoAudit: $('#fAudit').checked,
    auditMaxCalls: Math.max(0, +$('#fAuditMax').value || DEFAULTS.auditMaxCalls),
    ocrBaseUrl: $('#fOcrBase').value.trim(),
    ocrApiKey: $('#fOcrKey').value.trim(),
    ocrModel: $('#fOcrModel').value.trim(),
    ocrMaxCalls: Math.max(0, +$('#fOcrMax').value || DEFAULTS.ocrMaxCalls),
  };
}
const chips = $('#presets');
PRESETS.forEach(p => {
  const b = document.createElement('button');
  b.textContent = p.name;
  b.onclick = () => { $('#fBase').value = p.baseUrl; $('#fModel').value = p.model; };
  chips.appendChild(b);
});
const setStatus = (msg, cls = '') => { const s = $('#setStatus'); s.textContent = msg; s.className = 'status ' + cls; };
$('#bset').onclick = () => { fillSettings(); fillLayout(); setStatus(''); $('#mask').classList.add('on'); };
$('#setClose').onclick = () => $('#mask').classList.remove('on');
$('#mask').onclick = e => { if (e.target.id === 'mask') $('#mask').classList.remove('on'); };
$('#btnSave').onclick = () => {
  cfg = readSettings(); saveSettings(cfg);
  saveLayout(readLayout());   // 版面参数下次解析生效
  $('#mask').classList.remove('on'); refreshKeyWarning();
};
$('#btnTest').onclick = async () => {
  setStatus('测试中…');
  try {
    const r = await testConnection(readSettings());
    setStatus(r.reply ? `连接正常 · ${r.ms}ms · 模型回复「${r.reply}」` : `连接正常 · ${r.ms}ms`, 'ok');
  } catch (e) {
    setStatus(String(e.message || e), 'bad');
  }
};
$('#btnModels').onclick = async () => {
  setStatus('拉取中…');
  try {
    const ms = await listModels(readSettings());
    $('#modelList').innerHTML = ms.map(m => `<option value="${m}">`).join('');
    setStatus(`找到 ${ms.length} 个模型，点输入框可选`, 'ok');
  } catch (e) { setStatus('拉取失败：' + (e.message || e), 'bad'); }
};
$('#btnClearCache').onclick = async () => {
  if (!confirm('清空翻译缓存？已保存的文档不受影响，但重新翻译时需要再次调用接口。')) return;
  await store.clearCache(); fillSettings();
};
function refreshKeyWarning() {
  $('#noKey').style.display = (cfg.apiKey && cfg.baseUrl) ? 'none' : 'block';
  refreshEngineBar();
}

// 把"这次会用哪个引擎"摆到首页上。
// 之前 engine:'auto' 在没配解析模型时会静默退回本地几何规则 —— 用户看到的是
// 同样糟糕的结果，却完全不知道自己压根没跑在模型上，只会以为"还是不行"。
function refreshEngineBar() {
  const bar = $('#engineBar');
  if (!bar) return;
  const vl = cfg.engine === 'docvl' || (cfg.engine !== 'local' && docvl.configured(cfg));
  bar.className = 'engine' + (vl ? '' : ' weak');
  bar.innerHTML = '';
  const line = document.createElement('div');
  if (vl) {
    line.innerHTML = '解析引擎：<b>模型</b>（' + (cfg.ocrModel || '') + '）'
      + ' —— 整页交给它读，版面、双栏、表格、公式都由模型还原；插图仍按原坐标截图。'
      + '<br>注意：每页图像会发往你配置的解析接口。';
  } else {
    line.innerHTML = '解析引擎：<b>本地几何规则</b>（离线、免费）。'
      + '它看不见页面，只能从字符坐标倒推版面 —— 遇到公式多、双栏或文本层损坏的 PDF，'
      + '正文会被整段截成图片，译文里就是一串乱码。<br>'
      + '想要好结果，请在<a id="engineSetup">设置 → 文档解析模型</a>里填一个端点。';
  }
  bar.appendChild(line);
  const go = bar.querySelector('#engineSetup');
  if (go) go.onclick = () => { $('#bset').click(); $('#fOcrBase')?.focus(); };
}

// ---------- 首页 / 文档库 ----------
async function showHome() {
  D.dataset.screen = 'home';
  D.dataset.ai = 'off';
  D.dataset.notes = 'off';
  $('#bnotes').classList.remove('on');
  reader?._hideBar();
  $('#docTitle').textContent = '';
  refreshKeyWarning();
  const docs = await store.listDocs();
  const lib = $('#lib');
  if (!docs.length) { lib.innerHTML = ''; return; }
  lib.innerHTML = '<h3>我的文档</h3>';
  for (const d of docs) {
    const row = document.createElement('div');
    row.className = 'doc-row';
    row.innerHTML = `<div class="nm"><b></b><span></span></div><button class="del" title="删除">删除</button>`;
    row.querySelector('b').textContent = d.title;
    row.querySelector('span').textContent =
      `${d.pages} 页 · 已译 ${d.translated}/${d.blocks} 块 · ${new Date(d.created).toLocaleString('zh-CN')}`;
    row.onclick = async () => { const full = await store.getDoc(d.id); openDoc(full); };
    row.querySelector('.del').onclick = async ev => {
      ev.stopPropagation();
      if (confirm(`删除《${d.title}》？`)) { await store.deleteDoc(d.id); showHome(); }
    };
    lib.appendChild(row);
  }
}

const drop = $('#drop');
drop.onclick = () => $('#file').click();
$('#file').onchange = e => { if (e.target.files[0]) handleFile(e.target.files[0]); };
['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => {
  e.preventDefault(); drop.classList.add('over');
}));
['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => {
  e.preventDefault(); drop.classList.remove('over');
}));
drop.addEventListener('drop', e => {
  const f = [...e.dataTransfer.files].find(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (f) handleFile(f);
});

// ---------- 处理流程 ----------
function setWork(stage, detail, pct) {
  $('#wkStage').textContent = stage;
  $('#wkDetail').textContent = detail || '';
  if (pct != null) $('#wkBar').style.width = Math.round(pct * 100) + '%';
}
$('#wkStop').onclick = () => { stopFlag = true; setWork('正在停止…', '当前批次完成后中断'); };

async function handleFile(file) {
  stopFlag = false;
  D.dataset.screen = 'work';
  setWork('正在解析版面…', file.name, 0);
  let blocks;
  try {
    const useVL = cfg.engine === 'docvl'
      || (cfg.engine !== 'local' && docvl.configured(cfg));
    blocks = useVL
      ? await parsePdfVL(file, loadLayout(), cfg, (p, n, tail) =>
          setWork('模型正在读版面…', `${tail || ''} ${p} / ${n}`.trim(), (p / n) * 0.4))
      : await parsePdf(file, loadLayout(), (p, n, tail) =>
          setWork('正在解析版面…', tail || `第 ${p} / ${n} 页`, (p / n) * 0.4));
  } catch (e) {
    alert('解析失败：' + (e.message || e)); showHome(); return;
  }

  const enTitle = (pickTitle(blocks)?.text || file.name).replace(/\*+$/, '');
  const pages = Math.max(...blocks.map(b => b.page)) + 1;
  doc = { id: store.newId(), title: enTitle, enTitle, pages, blocks,
          created: Date.now(), fileName: file.name };

  if (!cfg.apiKey || !cfg.baseUrl) {
    alert('尚未配置模型接口，先只生成原文版面。配置后可在文档库里重新打开继续翻译。');
    await store.saveDoc(doc); await store.savePdf(doc.id, file); openDoc(doc); return;
  }

  const cache = store.makeCache(cfg.model);
  const t0 = performance.now();
  await translate(blocks, cfg, cache, ({ phase, done, total, cached, failed }) => {
    if (phase === 'cache') {
      setWork('正在查翻译缓存…', `${done} / ${total} 块`, 0.4);
      return;
    }
    const el = performance.now() - t0;
    const pct = total ? done / total : 1;
    const eta = pct > 0.02 ? ((el / pct - el) / 1000).toFixed(0) + 's' : '—';
    setWork('正在翻译…',
      `${done}/${total} 批${cached ? ` · 缓存命中 ${cached} 块` : ''}${failed ? ` · 失败 ${failed} 块` : ''} · 预计剩 ${eta}`,
      0.4 + pct * 0.6);
  }, () => stopFlag);

  // 译出标题
  const th = blocks.find(b => b.kind === 'heading' && typeof b.zh === 'string' && b.zh.trim());
  if (th) doc.title = th.zh.replace(/\*+$/, '');

  await store.savePdf(doc.id, file);       // 留底，供自检时重新截图
  const rep = stopFlag ? null : await audit(file);

  setWork('正在保存…', '', 1);
  await store.saveDoc(doc);
  openDoc(doc);
  if (rep) toast(auditSummary(rep), rep.fixed);
}

// 翻译完自动让 AI 复核一遍版面：每张图是不是截对了，有没有正文被当成图。
async function audit(pdfBlob) {
  if (cfg.autoAudit === false || !cfg.apiKey || !pdfBlob) return null;
  setWork('AI 正在复核版面…', '正在挑出可疑的图', 0);
  let rep = null;
  try {
    rep = await runAudit(doc, pdfBlob, cfg, loadLayout(), {
      onStage: (st, i, n) => setWork('AI 正在复核版面…',
        st === 'ocr' ? `识别第 ${i} / ${n} 块图中的文字`
          : st === 'scan' ? `扫描第 ${i} / ${n} 页` : `核查第 ${i} / ${n} 处`,
        st === 'ocr' ? (i / n) * 0.4
          : st === 'scan' ? 0.4 + (i / n) * 0.2 : 0.6 + (i / n) * 0.4),
      shouldStop: () => stopFlag,
    });
  } catch (e) {
    console.warn('[paper-lens] 版面自检失败：', e);
    return null;
  }
  doc.audited = true;
  // 还原出来的正文是新的待译内容，顺手补译掉
  if (rep.fixed.some(f => f.retext) && countPending(doc.blocks)) {
    setWork('正在补译还原出来的正文…', '', 1);
    await translate(doc.blocks, cfg, store.makeCache(cfg.model), () => {}, () => stopFlag);
  }
  return rep;
}

let toastTimer = null;
function toast(msg, details) {
  if (!msg) return;
  const el = $('#toast');
  el.innerHTML = '';
  const line = document.createElement('div');
  line.className = 'tmsg';
  line.textContent = msg;
  el.appendChild(line);
  if (details?.length) {
    const ul = document.createElement('ul');
    // 一次修十几处很常见，全列出来会糊满半屏。只给前几条，其余折成一行。
    details.slice(0, 6).forEach(d => {
      const li = document.createElement('li');
      li.textContent = d.note + (d.reason ? `（${d.reason}）` : '');
      ul.appendChild(li);
    });
    if (details.length > 6) {
      const li = document.createElement('li');
      li.className = 'more';
      li.textContent = `另有 ${details.length - 6} 处，详见控制台`;
      ul.appendChild(li);
    }
    el.appendChild(ul);
    if (details.length > 6) console.info('[paper-lens] 版面自检修正明细：', details.map(d => d.note));
  }
  const x = document.createElement('button');
  x.className = 'tx';
  x.textContent = '知道了';
  x.onclick = () => el.classList.remove('on');
  el.appendChild(x);
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 14000);
}

// ---------- 阅读 ----------
let reader = null;
async function openDoc(d) {
  await katexReady;
  doc = d;
  D.dataset.screen = 'read';
  $('#docTitle').textContent = d.title;
  reader?.destroy();
  reader = new Reader($('#content'), {
    onFormula: askFormula, onSelection: askSelection,
    onChange: () => { saveHighlights(); renderNotes(); },
  });
  syncMarkBtn();
  const toc = reader.render(d);
  buildToc(toc, $('#toc'));
  renderNotes();
  reader.bindScrollSpy($('#toc'), $('#prog'));
  applyFont();
  scrollTo(0, 0);
  const pending = countPending(d.blocks);
  if (pending) setTimeout(() => {
    if (confirm(`这篇还有 ${pending} 块未翻译，现在继续翻译吗？`)) resumeTranslate();
  }, 400);
}

async function resumeTranslate() {
  if (!cfg.apiKey) { alert('请先在设置里配置 API'); return; }
  stopFlag = false;
  D.dataset.screen = 'work';
  const cache = store.makeCache(cfg.model);
  await translate(doc.blocks, cfg, cache, ({ phase, done, total, failed }) =>
    setWork(phase === 'cache' ? '正在查翻译缓存…' : '正在补译…',
      phase === 'cache' ? `${done} / ${total} 块`
        : `${done}/${total} 批${failed ? ` · 失败 ${failed}` : ''}`,
      total ? done / total : 1),
    () => stopFlag);
  await store.saveDoc(doc);
  openDoc(doc);
}

// 图片灯箱（AI 侧栏里的图也能放大）
const lb = $('#lb');
document.addEventListener('click', e => {
  const img = e.target.closest('#ai .subject img');
  if (img) { lb.querySelector('img').src = img.src; lb.classList.add('on'); }
});
lb.onclick = () => lb.classList.remove('on');
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { lb.classList.remove('on'); $('#mask').classList.remove('on'); }
});


// ---------- AI 侧栏 ----------
// KaTeX 按需加载：它是 UMD 包，用 script 标签引，挂到 window.katex
let katex = null;
// 正文里的行内公式也要 KaTeX（模型版解析引擎会把数学原样交出 LaTeX），
// 所以渲染阅读界面之前必须等它加载完，否则读者看到的是一串反斜杠。
const katexReady = new Promise((resolve) => {
  const el = document.createElement('script');
  el.src = 'vendor/katex/katex.min.js';
  el.onload = () => { katex = window.katex; resolve(true); };
  el.onerror = () => resolve(false);
  document.head.appendChild(el);
});

// 轻量 Markdown + LaTeX。关键顺序：先把公式整段抽走再做 Markdown 转换，
// 否则 ** 和 _ 这类规则会把 \frac{}{} \sum_{i=1}^{N} 之类的源码啃坏。
function md(src) {
  const maths = [];
  const stash = (e, d) => `\u0000M${maths.push([e, d]) - 1}\u0000`;
  const t = String(src)
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, e) => stash(e, true))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, e) => stash(e, true))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, e) => stash(e, false))
    .replace(/\$([^\s$][^$\n]*?)\$/g, (_, e) => stash(e, false));

  const esc = x => x.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const inline = x => esc(x)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');

  const out = [];
  let list = null;
  for (const raw of t.split('\n')) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
    if (h) { close(); out.push(`<h3>${inline(h[2])}</h3>`); }
    else if (ul) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(ul[1])}</li>`); }
    else if (ol) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(ol[2])}</li>`); }
    else if (!line.trim()) { close(); }
    else { close(); out.push(`<p>${inline(line)}</p>`); }
  }
  if (list) out.push(`</${list}>`);

  // 回填公式。流式输出时公式可能只写了一半，此时正则不成对、压根不会被抽走，
  // 保持原样即可，等它写完下一帧自然就渲染出来了。
  return out.join('').replace(/\u0000M(\d+)\u0000/g, (_, i) => {
    const [e, d] = maths[+i] || ['', false];
    if (!katex) return esc(d ? `$$${e}$$` : `$${e}$`);
    try {
      return katex.renderToString(e.trim(), { displayMode: d, throwOnError: false, output: 'html' });
    } catch { return esc(d ? `$$${e}$$` : `$${e}$`); }
  });
}

// 独立公式比侧栏宽时等比缩小，避免右半截被裁。先清掉旧 transform 再测量。
function fitMath(root) {
  root.querySelectorAll('.katex-display').forEach(disp => {
    const k = disp.querySelector('.katex');
    if (!k) return;
    k.style.transform = ''; disp.style.height = '';
    const avail = disp.clientWidth;
    const w = k.getBoundingClientRect().width;
    if (avail > 0 && w > avail + 1) {
      const sc = Math.max(0.5, avail / w);
      k.style.transformOrigin = 'left top';
      k.style.transform = `scale(${sc})`;
      disp.style.height = Math.ceil(k.getBoundingClientRect().height) + 'px';
    }
  });
}

function setMd(el, text) { el.innerHTML = md(text); fitMath(el); }

function renderConvo() {
  const body = $('#aiBody');
  const subject = body.querySelector('.subject');
  const presets = body.querySelector('.presets');
  body.querySelectorAll('.msg').forEach(e => e.remove());
  for (const m of convo.messages) {
    const el = document.createElement('div');
    el.className = 'msg ' + m.role;
    if (m.role === 'assistant') {
      el.innerHTML = '<div class="who">AI</div><div class="md"></div>';
      setMd(el.querySelector('.md'), m.content || '');
    } else {
      el.textContent = m.content;
    }
    body.appendChild(el);
  }
  if (presets && convo.messages.length) presets.remove();
  body.scrollTop = body.scrollHeight;
}

function openAi(title, subjectNode, presetList) {
  D.dataset.ai = 'on';
  D.dataset.notes = 'off';
  $('#bnotes').classList.remove('on');
  $('#aiTitle').textContent = title;
  const body = $('#aiBody');
  body.innerHTML = '';
  if (subjectNode) body.appendChild(subjectNode);
  const box = document.createElement('div');
  box.className = 'presets';
  presetList.forEach(q => {
    const b = document.createElement('button');
    b.textContent = q;
    b.onclick = () => send(q);
    box.appendChild(b);
  });
  body.appendChild(box);
  $('#aiInput').focus();
}

$('#aiClose').onclick = () => { D.dataset.ai = 'off'; };
$('#bai').onclick = () => {
  D.dataset.ai = D.dataset.ai === 'on' ? 'off' : 'on';
  if (D.dataset.ai === 'on' && !convo) {
    convo = new Conversation(cfg, { title: doc?.title || '', kind: 'selection',
      contextText: '', section: '', docTitle: doc?.title || '' });
    openAi('AI 助读', null, ['这篇论文的核心论点是什么？', '作者的方法和传统做法有什么不同？']);
  }
};

let busy = false;
async function send(question) {
  if (!question.trim() || busy || !convo) return;
  if (!cfg.apiKey || !cfg.baseUrl) { alert('请先在设置里配置 API'); return; }
  busy = true;
  $('#aiSend').disabled = true;
  $('#aiInput').value = '';
  renderConvo();
  const body = $('#aiBody');
  const el = document.createElement('div');
  el.className = 'msg assistant';
  el.innerHTML = '<div class="who">AI</div><div class="md typing"></div>';
  body.appendChild(el);
  const target = el.querySelector('.md');
  body.scrollTop = body.scrollHeight;
  try {
    await convo.ask(question, (_d, full) => {
      setMd(target, full);
      body.scrollTop = body.scrollHeight;
    });
  } catch { /* 错误已写进 messages */ }
  finally {
    busy = false; $('#aiSend').disabled = false;
    renderConvo();
  }
}

$('#aiForm').onsubmit = e => { e.preventDefault(); send($('#aiInput').value); };
$('#aiInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send($('#aiInput').value); }
});
$('#aiInput').addEventListener('input', e => {
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
});

function askFormula(block) {
  const idx = doc.blocks.findIndex(b => b.id === block.id);
  convo = new Conversation(cfg, {
    title: '公式/表格', kind: 'formula',
    contextText: contextAround(doc.blocks, idx),
    section: sectionOf(doc.blocks, idx),
    imageBlob: block.blob, ocrText: block.ocr, docTitle: doc.title,
  });
  const sub = document.createElement('div');
  sub.className = 'subject';
  const img = document.createElement('img');
  img.src = URL.createObjectURL(block.blob);
  sub.appendChild(img);
  openAi(`第 ${block.page + 1} 页 · 公式/表格`, sub, PRESET_QUESTIONS.formula);
}

function askSelection(text, blockId) {
  const idx = blockId != null ? doc.blocks.findIndex(b => b.id === blockId) : 0;
  convo = new Conversation(cfg, {
    title: text, kind: 'selection',
    contextText: contextAround(doc.blocks, Math.max(0, idx)),
    section: sectionOf(doc.blocks, Math.max(0, idx)),
    docTitle: doc.title,
  });
  const sub = document.createElement('div');
  sub.className = 'subject';
  const q = document.createElement('div');
  q.className = 'q'; q.textContent = text;
  sub.appendChild(q);
  openAi('选中的内容', sub, PRESET_QUESTIONS.selection);
  getSelection().removeAllRanges();
}

// 启动。走到这里说明整个模块都求值成功了 —— index.html 里的兜底提示据此判断。
window.__pdfbtReady = true;
showHome();

// ---------- 标注 ----------
let saveTimer = null;
function saveHighlights() {
  // 高亮改动很频繁，合并成一次写入
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { if (doc) store.saveDoc(doc); }, 400);
}

function syncMarkBtn() {
  const b = $('#bmark');
  if (!b || !reader) return;
  b.classList.toggle('on', reader.autoMark);
  b.title = reader.autoMark ? '选中文字自动标黄（点击关闭）' : '选中后手动标黄（点击开启自动）';
}

$('#bmark').onclick = () => {
  if (!reader) return;
  reader.setAutoMark(!reader.autoMark);
  syncMarkBtn();
};

function renderNotes() {
  const body = $('#notesBody');
  const hs = (doc?.highlights || []).slice();
  if (!hs.length) {
    body.innerHTML = '<div class="empty">还没有标注。<br>在正文里选中文字即可标黄。</div>';
    return;
  }
  // 按正文顺序排，而不是按标注时间
  const order = new Map(doc.blocks.map((b, i) => [b.id, i]));
  hs.sort((a, b) => (order.get(a.blockId) ?? 0) - (order.get(b.blockId) ?? 0) || a.start - b.start);
  body.innerHTML = '';
  for (const h of hs) {
    const blk = doc.blocks.find(b => b.id === h.blockId);
    const item = document.createElement('div');
    item.className = 'note-item';
    const tx = document.createElement('div');
    tx.className = 'tx'; tx.textContent = h.text;
    const mt = document.createElement('div');
    mt.className = 'mt';
    const pg = document.createElement('span');
    pg.textContent = `p.${(blk?.page ?? 0) + 1} · ${h.field === 'zh' ? '译文' : '原文'}`;
    const del = document.createElement('button');
    del.textContent = '删除';
    del.onclick = ev => {
      ev.stopPropagation();
      doc.highlights = doc.highlights.filter(x => x.id !== h.id);
      reader._repaint(h.blockId, h.field);
      saveHighlights(); renderNotes();
    };
    mt.append(pg, del);
    item.append(tx, mt);
    item.onclick = () => reader.scrollToHighlight(h.id);
    body.appendChild(item);
  }
}

$('#bnotes').onclick = () => {
  const on = D.dataset.notes === 'on';
  D.dataset.notes = on ? 'off' : 'on';
  if (!on) { D.dataset.ai = 'off'; renderNotes(); }
  $('#bnotes').classList.toggle('on', !on);
};
$('#notesClose').onclick = () => {
  D.dataset.notes = 'off';
  $('#bnotes').classList.remove('on');
};
