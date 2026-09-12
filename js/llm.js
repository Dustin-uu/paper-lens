// 统一的 LLM 调用层：翻译和问答都走这里。兼容任何 OpenAI 格式的服务。

export function endpoint(baseUrl, path = '/chat/completions') {
  let u = (baseUrl || '').trim().replace(/\/+$/, '');
  if (!u) {
    throw new Error('还没填 API 地址。打开右上角「设置」填写，例如 https://api.deepseek.com/v1');
  }
  // 用户常直接粘贴完整端点，去掉尾巴避免拼成 /chat/completions/chat/completions
  u = u.replace(/\/(chat\/completions|completions|responses)$/i, '');
  if (!/^https?:\/\//i.test(u)) {
    throw new Error(`API 地址必须以 http:// 或 https:// 开头，当前填的是「${u}」`);
  }
  return u + path;
}

// 把"返回了网页而不是 JSON"这类问题翻译成人话，否则用户只会看到
// "Unexpected token '<'"，完全看不出是地址填错了。
function explain(raw, url, status) {
  const head = raw.slice(0, 200).trim();
  if (/^\s*<(!doctype|html)/i.test(head)) {
    return `接口返回的是网页而不是 JSON，说明这个地址不是 OpenAI 格式的 API 端点：\n${url}\n`
         + `常见原因：① 地址少了或多了 /v1；② 填成了官网/控制台地址；③ 被网关或登录页拦截。`;
  }
  if (!head) return `接口返回空响应（HTTP ${status}）：${url}`;
  return head;
}

async function parseOrExplain(res, url) {
  const raw = await res.text();                 // 只读一次，避免 body 重复消费
  let data = null;
  try { data = JSON.parse(raw); } catch { /* 非 JSON，下面统一解释 */ }
  if (!res.ok) {
    const msg = data?.error?.message || data?.message || explain(raw, url, res.status);
    throw new Error(`HTTP ${res.status} · ${msg}`);
  }
  if (!data) throw new Error(explain(raw, url, res.status));
  return data;
}

export async function chat(cfg, messages, opts = {}) {
  const url = endpoint(cfg.baseUrl);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || cfg.timeoutMs || 180000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: opts.model || cfg.model,
        messages,
        max_tokens: opts.maxTokens || cfg.maxTokens,
        temperature: opts.temperature ?? cfg.temperature,
        ...(opts.stream ? { stream: true } : {}),
      }),
      signal: ctrl.signal,
    });
    if (opts.stream) {
      // 流式：不能先读 text，否则流就没了。只在明显不是流时才回退到报错分支。
      const ct = res.headers.get('content-type') || '';
      if (!res.ok || !/event-stream/i.test(ct)) {
        if (!res.ok || !/json/i.test(ct)) await parseOrExplain(res, url);
        throw new Error('接口未按流式返回，请在设置里换一个支持 stream 的模型。');
      }
      return res;
    }
    const d = await parseOrExplain(res, url);
    const c = d?.choices?.[0]?.message?.content;
    if (typeof c !== 'string') {
      throw new Error(`响应里没有 choices[0].message.content，实际收到：${JSON.stringify(d).slice(0, 200)}`);
    }
    return c.trim();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('请求超时，可以在设置里调低并发或换更快的模型。');
    if (String(e.message).includes('Failed to fetch')) {
      throw new Error(`连不上 ${url}\n可能是：① 地址写错或服务没开；② 接口没放行浏览器跨域(CORS)；③ https 页面调用了 http 接口被浏览器拦截。`);
    }
    throw e;
  } finally { clearTimeout(timer); }
}

// 流式输出，onDelta 拿到增量文本。用于 AI 问答，让回答逐字出现。
export async function chatStream(cfg, messages, onDelta, opts = {}) {
  const res = await chat(cfg, messages, { ...opts, stream: true });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', full = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const j = JSON.parse(payload);
        const d = j?.choices?.[0]?.delta?.content;
        if (d) { full += d; onDelta(d, full); }
      } catch { /* 半包，等下一轮 */ }
    }
  }
  return full;
}

export async function listModels(cfg) {
  const url = endpoint(cfg.baseUrl, '/models');
  let res;
  try {
    res = await fetch(url, { headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {} });
  } catch (e) {
    throw new Error(`连不上 ${url}（可能是 CORS 未放行或地址有误）`);
  }
  const d = await parseOrExplain(res, url);
  return (d?.data || []).map(m => m.id).filter(Boolean).sort();
}

export async function testConnection(cfg) {
  const t0 = performance.now();
  // 给足 token：推理模型会先花掉一批在思考上，给太少会返回空正文，看着像"通了但没反应"
  const txt = await chat(cfg, [{ role: 'user', content: '回复两个字：正常' }],
                         { maxTokens: 500, timeoutMs: 40000 });
  return { ok: true, ms: Math.round(performance.now() - t0), reply: txt.slice(0, 40) };
}

// 图片能力探测：拿一张 1x1 PNG 试一次，失败说明该模型不支持读图
export async function testVision(cfg, model) {
  const px = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  try {
    await chat(cfg, [{ role: 'user', content: [
      { type: 'text', text: 'ok?' },
      { type: 'image_url', image_url: { url: px } },
    ] }], { model: model || cfg.model, maxTokens: 16, timeoutMs: 40000 });
    return true;
  } catch { return false; }
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}
