// 阅读器：渲染块序列、目录、划词高亮，以及"点公式"和"划词提问"两个 AI 入口。
// 高亮按「块内字符偏移」存储，不依赖 DOM 结构，重新渲染后可原样恢复。

function level(size) {
  if (size >= 19) return 1;
  if (size >= 16.5) return 2;
  if (size >= 13.5) return 3;
  return 4;
}

function slug(text, i) {
  const s = (text || '').trim().replace(/[^\w一-鿿.]+/g, '-').slice(0, 36).replace(/^-|-$/g, '');
  return s ? `s${i}-${s}` : `s${i}`;
}

// 文本节点在容器内的字符偏移
function offsetIn(root, node, off) {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let total = 0, n;
  while ((n = w.nextNode())) {
    if (n === node) return total + off;
    total += n.textContent.length;
  }
  return -1;
}

// 合并重叠区间，避免嵌套 <mark>
function mergeRanges(list) {
  const s = [...list].sort((a, b) => a.start - b.start);
  const out = [];
  for (const r of s) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
      last.ids.push(r.id);
    } else out.push({ start: r.start, end: r.end, ids: [r.id] });
  }
  return out;
}

function paintText(el, text, marks) {
  if (!marks || !marks.length) { el.textContent = text; return; }
  const frag = document.createDocumentFragment();
  let pos = 0;
  for (const m of mergeRanges(marks)) {
    const a = Math.max(0, Math.min(m.start, text.length));
    const b = Math.max(a, Math.min(m.end, text.length));
    if (a > pos) frag.appendChild(document.createTextNode(text.slice(pos, a)));
    const mk = document.createElement('mark');
    mk.className = 'hl';
    mk.dataset.hid = m.ids.join(',');
    mk.textContent = text.slice(a, b);
    frag.appendChild(mk);
    pos = b;
  }
  if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
  el.textContent = '';
  el.appendChild(frag);
}

export class Reader {
  constructor(root, { onFormula, onSelection, onChange }) {
    this.root = root;
    this.onFormula = onFormula;
    this.onSelection = onSelection;
    this.onChange = onChange;          // 高亮增删后回调，用于落盘
    this.urls = [];
    this.autoMark = localStorage.getItem('hl') !== 'off';
    this._buildBar();
    this._bindSelection();
  }

  destroy() {
    this.urls.forEach(u => URL.revokeObjectURL(u));
    this.urls = [];
    this._bar?.remove();
    if (this._onUp) document.removeEventListener('mouseup', this._onUp);
    if (this._onDown) document.removeEventListener('mousedown', this._onDown);
  }

  setAutoMark(on) {
    this.autoMark = on;
    localStorage.setItem('hl', on ? 'on' : 'off');
  }

  get highlights() { return this.doc?.highlights || []; }

  render(doc) {
    this.doc = doc;
    doc.highlights = doc.highlights || [];
    this.urls.forEach(u => URL.revokeObjectURL(u));
    this.urls = [];
    const toc = [];
    const wrap = document.createElement('div');
    wrap.className = 'wrap';

    const h1 = document.createElement('h1');
    h1.className = 'doc';
    h1.textContent = doc.title;
    if (doc.enTitle && doc.enTitle !== doc.title) {
      const sp = document.createElement('span');
      sp.className = 'en'; sp.textContent = doc.enTitle;
      h1.appendChild(sp);
    }
    wrap.appendChild(h1);

    const meta = document.createElement('p');
    meta.className = 'meta';
    const nG = doc.blocks.filter(b => b.kind === 'graphic').length;
    const nT = doc.blocks.filter(b => b.zh).length;
    meta.textContent = `共 ${doc.pages} 页 · ${doc.blocks.length} 个版面块 · 已译 ${nT} 段 · ${nG} 处公式/表格/插图保留原始版面`;
    wrap.appendChild(meta);

    let lastPage = -1, skipId = null;
    const firstHead = doc.blocks.find(b => b.kind === 'heading');
    if (firstHead && level(firstHead.size || 12) === 1) skipId = firstHead.id;

    for (const b of doc.blocks) {
      if (b.id === skipId) continue;
      let pageMark = null;
      if (b.page !== lastPage) { lastPage = b.page; pageMark = b.page + 1; }

      if (b.kind === 'heading') {
        const lv = level(b.size || 12);
        const tag = lv <= 2 ? 'h2' : (lv === 3 ? 'h3' : 'h4');
        const el = document.createElement(tag);
        el.id = slug(b.zh || b.text, b.id);
        el.dataset.blockId = b.id;
        if (pageMark) el.appendChild(this._pageTag(pageMark));
        const zh = document.createElement('span');
        zh.className = 'zh'; zh.dataset.field = 'zh';
        paintText(zh, b.zh || b.text, this._marksOf(b.id, 'zh'));
        const en = document.createElement('span');
        en.className = 'en'; en.dataset.field = 'en';
        paintText(en, b.text, this._marksOf(b.id, 'en'));
        el.append(zh, en);
        wrap.appendChild(el);
        toc.push({ level: lv, anchor: el.id, text: b.zh || b.text });
      } else if (b.kind === 'graphic') {
        const fig = document.createElement('figure');
        if (b.h && b.h < 46) fig.classList.add('inline');
        const img = document.createElement('img');
        const url = URL.createObjectURL(b.blob);
        this.urls.push(url);
        img.src = url; img.loading = 'lazy'; img.alt = '公式或表格';
        const hint = document.createElement('span');
        hint.className = 'ask-hint'; hint.textContent = '点击让 AI 讲解';
        fig.append(img, hint);
        fig.addEventListener('click', () => this.onFormula?.(b));
        wrap.appendChild(fig);
      } else if (b.kind === 'ref') {
        const el = document.createElement('div');
        el.className = 'blk ref'; el.dataset.blockId = b.id;
        const sp = document.createElement('span');
        sp.className = 'en'; sp.dataset.field = 'en';
        paintText(sp, b.text, this._marksOf(b.id, 'en'));
        el.appendChild(sp);
        wrap.appendChild(el);
      } else {
        const el = document.createElement('div');
        el.className = `blk ${b.kind}`;
        el.dataset.blockId = b.id;
        if (pageMark) el.appendChild(this._pageTag(pageMark));
        const zh = document.createElement('div');
        zh.className = 'zh'; zh.dataset.field = 'zh';
        if (!b.zh) zh.classList.add('untranslated');
        paintText(zh, b.zh || (b.err ? `未翻译：${b.err}` : ''), this._marksOf(b.id, 'zh'));
        const en = document.createElement('div');
        en.className = 'en'; en.dataset.field = 'en';
        paintText(en, b.text, this._marksOf(b.id, 'en'));
        el.append(zh, en);
        wrap.appendChild(el);
      }
    }

    this.root.innerHTML = '';
    this.root.appendChild(wrap);
    this.toc = toc;
    return toc;
  }

  _marksOf(blockId, field) {
    return this.highlights.filter(h => h.blockId === blockId && h.field === field);
  }

  _pageTag(n) {
    const s = document.createElement('span');
    s.className = 'pg'; s.textContent = `p.${n}`;
    return s;
  }

  // 只重绘受影响的那个字段，避免整篇重渲染丢失滚动位置
  _repaint(blockId, field) {
    const host = this.root.querySelector(`[data-block-id="${blockId}"]`);
    if (!host) return;
    const el = host.querySelector(`[data-field="${field}"]`);
    if (!el) return;
    const b = this.doc.blocks.find(x => x.id === blockId);
    const text = field === 'zh' ? (b.zh || (b.kind === 'heading' ? b.text : '')) : b.text;
    paintText(el, text, this._marksOf(blockId, field));
  }
}

// ---------- 划词：自动标黄 + 工具条 ----------
Object.assign(Reader.prototype, {
  _buildBar() {
    const bar = document.createElement('div');
    bar.className = 'sel-bar';
    bar.style.display = 'none';
    bar.innerHTML = `
      <button data-act="mark">标黄</button>
      <button data-act="unmark">取消标黄</button>
      <button data-act="ask">问 AI</button>`;
    document.body.appendChild(bar);
    this._bar = bar;
    bar.addEventListener('mousedown', e => e.preventDefault());  // 别让按钮抢走选区
    bar.addEventListener('click', e => {
      const act = e.target.closest('button')?.dataset.act;
      if (!act) return;
      const p = this._pending;
      if (!p) return;
      if (act === 'mark') this._addMark(p);
      else if (act === 'unmark') this._removeMarks(p);
      else if (act === 'ask') this.onSelection?.(p.text, p.blockId);
      this._hideBar();
    });
  },

  _hideBar() {
    if (this._bar) this._bar.style.display = 'none';
    this._pending = null;
  },

  _showBar(rect, { canMark, canUnmark }) {
    const bar = this._bar;
    bar.querySelector('[data-act="mark"]').style.display = canMark ? '' : 'none';
    bar.querySelector('[data-act="unmark"]').style.display = canUnmark ? '' : 'none';
    bar.style.display = 'flex';
    const w = bar.offsetWidth || 200;
    bar.style.left = Math.max(8, Math.min(innerWidth - w - 8, rect.left + rect.width / 2 - w / 2)) + 'px';
    bar.style.top = (rect.top > 64 ? rect.top - 44 : rect.bottom + 10) + 'px';
  },

  _addMark(p) {
    const id = 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    this.doc.highlights.push({ id, blockId: p.blockId, field: p.field,
                               start: p.start, end: p.end, text: p.text, created: Date.now() });
    this._repaint(p.blockId, p.field);
    getSelection().removeAllRanges();
    this.onChange?.();
  },

  _removeMarks(p) {
    const before = this.doc.highlights.length;
    this.doc.highlights = this.doc.highlights.filter(h =>
      !(h.blockId === p.blockId && h.field === p.field && h.start < p.end && h.end > p.start));
    if (this.doc.highlights.length !== before) {
      this._repaint(p.blockId, p.field);
      getSelection().removeAllRanges();
      this.onChange?.();
    }
  },

  _bindSelection() {
    // 点已有高亮 -> 工具条（删除 / 问 AI）
    this._onDown = e => {
      const mk = e.target.closest?.('mark.hl');
      if (mk && this.root.contains(mk)) {
        const host = mk.closest('[data-block-id]');
        const field = mk.closest('[data-field]')?.dataset.field;
        const ids = mk.dataset.hid.split(',');
        const hs = this.doc.highlights.filter(h => ids.includes(h.id));
        if (hs.length) {
          this._pending = { blockId: +host.dataset.blockId, field, text: mk.textContent,
                            start: Math.min(...hs.map(h => h.start)), end: Math.max(...hs.map(h => h.end)) };
          this._showBar(mk.getBoundingClientRect(), { canMark: false, canUnmark: true });
          e.preventDefault();
          return;
        }
      }
      if (!e.target.closest?.('.sel-bar')) this._hideBar();
    };
    document.addEventListener('mousedown', this._onDown);

    // 松开鼠标才判定选区，避免拖动过程中反复触发
    this._onUp = () => setTimeout(() => this._onSelectEnd(), 10);
    document.addEventListener('mouseup', this._onUp);
  },

  _onSelectEnd() {
    const sel = getSelection();
    const text = sel?.toString().trim();
    if (!text || text.length < 2 || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const field = range.startContainer.parentElement?.closest('[data-field]');
    const host = field?.closest('[data-block-id]');
    if (!field || !host || !this.root.contains(host)) return;
    // 跨块选择无法用单个偏移表示，只支持问 AI
    if (!field.contains(range.endContainer)) {
      this._pending = { blockId: +host.dataset.blockId, field: field.dataset.field, text, start: 0, end: 0 };
      this._showBar(range.getBoundingClientRect(), { canMark: false, canUnmark: false });
      return;
    }
    const start = offsetIn(field, range.startContainer, range.startOffset);
    const end = offsetIn(field, range.endContainer, range.endOffset);
    if (start < 0 || end <= start) return;
    const p = { blockId: +host.dataset.blockId, field: field.dataset.field, text, start, end };
    const overlapped = this._marksOf(p.blockId, p.field).some(h => h.start < end && h.end > start);
    const rect = range.getBoundingClientRect();
    this._pending = p;
    if (this.autoMark && !overlapped) {
      this._addMark(p);
      this._showBar(rect, { canMark: false, canUnmark: true });
    } else {
      this._showBar(rect, { canMark: !overlapped, canUnmark: overlapped });
    }
  },

  bindScrollSpy(tocEl, progEl) {
    const heads = [...this.root.querySelectorAll('h2[id],h3[id],h4[id]')];
    const links = new Map([...tocEl.querySelectorAll('a')].map(a => [a.getAttribute('href').slice(1), a]));
    let tick = false;
    const onScroll = () => {
      if (tick) return; tick = true;
      requestAnimationFrame(() => {
        const h = document.body.scrollHeight - innerHeight;
        if (progEl) progEl.style.width = (h > 0 ? (scrollY / h) * 100 : 0) + '%';
        let cur = null;
        for (const el of heads) { if (el.getBoundingClientRect().top <= 92) cur = el; else break; }
        links.forEach(a => a.classList.remove('on'));
        if (cur && links.has(cur.id)) {
          const a = links.get(cur.id);
          a.classList.add('on');
          const r = a.getBoundingClientRect(), t = tocEl.getBoundingClientRect();
          if (r.top < t.top + 40 || r.bottom > t.bottom - 40) a.scrollIntoView({ block: 'center' });
        }
        tick = false;
      });
    };
    addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  },

  scrollToHighlight(id) {
    const mk = [...this.root.querySelectorAll('mark.hl')]
      .find(m => m.dataset.hid.split(',').includes(id));
    if (!mk) return;
    mk.scrollIntoView({ block: 'center' });
    mk.classList.add('flash');
    setTimeout(() => mk.classList.remove('flash'), 1200);
  },
});

export function buildToc(toc, el) {
  el.innerHTML = '<h4>目录</h4>';
  for (const t of toc) {
    const a = document.createElement('a');
    a.href = '#' + t.anchor;
    a.className = 'l' + t.level;
    a.textContent = t.text;
    el.appendChild(a);
  }
}
