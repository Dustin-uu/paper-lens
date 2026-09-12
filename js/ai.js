// 阅读中的 AI 问答：点公式/表格让它讲解、划词提问、就地追问。
// 两种入口共用一套会话对象，所以追问时上下文不会丢。
import { chatStream, blobToDataUrl } from './llm.js';

const SYS = `你是一位金融/数学/机器学习领域的论文精读助教，正在帮读者读一篇英文论文的中译本。
要求：
1. 用简体中文回答，直接切入要点，不说客套话；
2. 解释公式时逐个符号说明含义，再讲清整体在做什么、为什么这样设计；
3. 紧扣给定的上下文，不要脱离本文自由发挥；上下文没提到的，明确说"文中未给出"；
4. 可以使用 Markdown（标题、列表、行内代码）；
5. **所有数学内容必须写成 LaTeX**，前端会渲染：行内用 $...$，独立成行用 $$...$$。
   例如写 $\\ell(\\theta)$ 而不是 ℓ(θ)，写 $\\frac{1}{NT}\\sum_{i=1}^{N}\\sum_{t=1}^{T}$ 而不是 1/(NT) Σ...，
   写 $r_{i,t+1}$ 而不是 r_{i,t+1}。变量、下标、求和、分式、希腊字母一律用 LaTeX，不要用纯文本符号拼凑；
6. 逐符号解释时，每一条的符号本身也要用 $...$ 包起来；
7. 回答精炼，一般不超过 500 字，除非用户要求展开。`;

// 取某块前后的正文，作为问答的上下文
export function contextAround(blocks, index, radius = 3) {
  const out = [];
  const kinds = new Set(['para', 'caption', 'note', 'heading']);
  for (let i = Math.max(0, index - radius * 3); i < Math.min(blocks.length, index + radius * 3 + 1); i++) {
    const b = blocks[i];
    if (!kinds.has(b.kind) || !b.text) continue;
    out.push({ dist: Math.abs(i - index), text: b.text, zh: b.zh || '' });
  }
  out.sort((a, b) => a.dist - b.dist);
  const picked = out.slice(0, radius * 2).sort((a, b) => 0);
  return picked.map(p => p.zh ? `${p.zh}\n（原文：${p.text}）` : p.text).join('\n\n');
}

// 最近的章节标题，帮模型定位
export function sectionOf(blocks, index) {
  for (let i = index; i >= 0; i--) {
    if (blocks[i].kind === 'heading') return blocks[i].zh || blocks[i].text;
  }
  return '';
}

export class Conversation {
  constructor(cfg, { title, kind, contextText, section, imageBlob, docTitle }) {
    this.cfg = cfg;
    this.title = title;
    this.kind = kind;                 // 'formula' | 'selection'
    this.contextText = contextText;
    this.section = section;
    this.imageBlob = imageBlob || null;
    this.docTitle = docTitle || '';
    this.messages = [];               // 展示用：{role, content}
    this._primed = false;
  }

  async _firstUserContent(question) {
    const head = [
      this.docTitle ? `论文：《${this.docTitle}》` : '',
      this.section ? `所在章节：${this.section}` : '',
      this.contextText ? `\n【上下文】\n${this.contextText}` : '',
    ].filter(Boolean).join('\n');

    if (this.kind === 'formula') {
      const text = `${head}\n\n【任务】\n图中是本文的一处公式/表格/插图。${question}`;
      if (this.imageBlob && this.cfg.visionModel !== '-') {
        return [
          { type: 'text', text },
          { type: 'image_url', image_url: { url: await blobToDataUrl(this.imageBlob) } },
        ];
      }
      // 模型不支持读图时，退化成仅凭上下文讲解，并如实说明
      return `${head}\n\n【任务】\n此处原文是一个公式/表格（图片无法提供）。${question}\n请基于上下文推断它在表达什么；若信息不足请直言。`;
    }
    return `${head}\n\n【选中的内容】\n${this.title}\n\n【问题】\n${question}`;
  }

  // onDelta(增量, 全文) 用于流式渲染
  async ask(question, onDelta) {
    let userContent;
    if (!this._primed) { userContent = await this._firstUserContent(question); this._primed = true; }
    else userContent = question;

    this.messages.push({ role: 'user', content: question });
    const wire = [{ role: 'system', content: SYS }];
    // 历史里第一条要用带图/带上下文的版本
    this.messages.forEach((m, i) => {
      if (i === this.messages.length - 1) wire.push({ role: 'user', content: userContent });
      else wire.push({ role: m.role, content: m.content });
    });

    const model = (this.kind === 'formula' && this.cfg.visionModel && this.cfg.visionModel !== '-')
      ? this.cfg.visionModel : this.cfg.model;

    const idx = this.messages.push({ role: 'assistant', content: '' }) - 1;
    try {
      const full = await chatStream(this.cfg, wire, (d, f) => {
        this.messages[idx].content = f;
        onDelta?.(d, f);
      }, { model, maxTokens: 2000, temperature: 0.3 });
      this.messages[idx].content = full;
      return full;
    } catch (e) {
      const msg = `请求失败：${e.message || e}`;
      this.messages[idx].content = msg;
      onDelta?.('', msg);
      throw e;
    }
  }
}

export const PRESET_QUESTIONS = {
  formula: [
    '请逐个符号解释这个公式，并说明它在本文中的作用。',
    '这一步为什么要这样设计？换成别的做法会有什么问题？',
    '用一个具体的数值例子演示一下。',
  ],
  selection: [
    '这段话是什么意思？',
    '这里的关键假设是什么？有什么局限？',
    '结合上下文，这段和作者的核心论点是什么关系？',
  ],
};
