// 默认配置与术语表。用户在设置面板里改的内容存 localStorage，覆盖这里的默认值。

export const DEFAULTS = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  visionModel: '',          // 留空 = 与 model 相同；不支持读图时填 '-' 表示禁用
  concurrency: 6,
  batchChars: 2200,
  maxTokens: 8000,
  temperature: 0.2,
  targetLang: '简体中文',
  timeoutMs: 180000,
  retry: 3,
  autoAudit: true,          // 翻译完让 AI 复核一遍版面（见 audit.js）
  auditMaxCalls: 40,        // 单篇最多问多少次，免得长文档把额度问光
};

// 常见服务商预设，设置面板里一键填入
export const PRESETS = [
  { name: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { name: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { name: '阿里通义', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { name: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
  { name: '本地 Ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
];

// 版面解析参数。换排版风格的 PDF 时在设置面板里调。
export const LAYOUT = {
  autoProfile: true,  // 先采样几页统计出正文字号与页边距，再据此推导各阈值
  dpi: 200,
  imageType: 'image/webp',  // PNG 无损编码在 85 页这个量级要 70s，WebP 快数倍且肉眼无差
  imageQuality: 0.92,
  bodySize: [11.4, 12.6],
  abstractSize: [10.6, 11.2],
  footnoteSize: [9.4, 10.4],
  headMinSize: 13.5,
  bodyX0Max: 96,     // "顶格"判定线。必须容得下 LaTeX 段落首行缩进(72+18=90)，
                     // 否则单行段落和整体缩进的项目符号列表会被当成图截出来
  bodyX1Min: 470,
  abstractX0Max: 165,
  abstractMinW: 350,
  graphicGap: 12,
  inkBridgeMax: 150,
  // 分栏检测：默认关闭。实现见 parser.js detectColumnZone()。
  // 它能修好真正的双栏页（侧边栏文字不再左右交错），但会把表格的列缝误判成栏缝——
  // 实测一篇学术论文有 22 页被误判，待译字符凭空涨 19%，内容被切碎。
  // 收益（少数页）远小于代价（多数页），所以默认关掉，想试的人自行打开。
  detectColumns: false,
  minColumnGap: 6,      // 栏间空白达到多少 pt 才算分栏
  findFigures: true,  // 主动发现纯位图插图（它们不产生文本碎块，聚类看不见）
  minFigureH: 40,     // 图形区最小高度，低于此值视为噪点
  stitchCrossPage: true, // 把被分页切断的大图/长表拼回一张
  expandFigures: true, // 大图/表按墨迹连通性补全边界，吸收被误判成文本的表头数据行     // 图形区最小高度，低于此值视为噪点  // 两个图形碎片间隔小于此值且中间无文字有墨迹时，视为同一张图
  graphicPad: 8,
  minGraphicH: 8,
  pageNoY: 690,
  lineTol: 0.62,     // 同行判定：y 差 < 字号 * 该系数。需容下上/下标的基线偏移，
                     // 否则 E_t[r̃_{i,t+1}] 的下标会被当成独立行、再被切成图插进段落中间
  blockGap: 1.65,    // 分块判定：行距 > 行高 * 该系数
};

// 学术／金融术语表。译文里强制统一，避免同一概念前后不一致。
export const GLOSSARY = {
  'end-to-end': '端到端', 'two-stage': '两阶段', 'predict-then-optimize': '先预测再优化',
  'expected return': '期望收益', 'cross-sectional': '截面', 'cross-section': '截面',
  'risk aversion': '风险厌恶', 'risk preference': '风险偏好', 'risk tolerance': '风险容忍度',
  'mean-variance': '均值-方差', 'efficient frontier': '有效前沿', 'tangency portfolio': '切点组合',
  'minimum-variance': '最小方差', 'long-only': '只做多', 'long-short': '多空',
  'short leg': '空头腿', 'long leg': '多头腿', 'turnover': '换手率',
  'transaction cost': '交易成本', 'market friction': '市场摩擦', 'drawdown': '回撤',
  'Sharpe ratio': '夏普比率', 'out-of-sample': '样本外', 'in-sample': '样本内',
  'rolling window': '滚动窗口', 'look-ahead bias': '前视偏差',
  'stochastic discount factor': '随机贴现因子', 'asset pricing': '资产定价',
  'pricing function': '定价函数', 'firm characteristics': '公司特征', 'predictor': '预测变量',
  'factor zoo': '因子动物园', 'anomaly': '异象', 'microcap': '微盘股',
  'shell-value premium': '壳价值溢价', 'A-share': 'A股', 'bilevel': '双层',
  'lower-level problem': '下层问题', 'upper-level problem': '上层问题',
  'decision loss': '决策损失', 'decision-aware': '决策感知', 'optimization layer': '优化层',
  'differentiable convex optimization': '可微凸优化', 'implicit function theorem': '隐函数定理',
  'KKT conditions': 'KKT 条件', 'complementary slackness': '互补松弛', 'dual variable': '对偶变量',
  'linear program': '线性规划', 'second-order cone program': '二阶锥规划',
  'backpropagation': '反向传播', 'gradient descent': '梯度下降',
  'parametric portfolio policy': '参数化组合策略', 'deep reinforcement learning': '深度强化学习',
  'neural network': '神经网络', 'equal-weighted': '等权', 'value-weighted': '市值加权',
  'basis points': '基点', 'estimation error': '估计误差', 'parameter uncertainty': '参数不确定性',
  'robust optimization': '稳健优化', 'shrinkage': '收缩', 'covariance matrix': '协方差矩阵',
  'utility': '效用', 'portfolio weights': '组合权重', 'rebalancing': '再平衡',
  'VWAP': '成交量加权平均价', 'limits to arbitrage': '套利限制',
};

const LS_KEY = 'pdfbt.settings';

export function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(LS_KEY) || '{}') };
  } catch { return { ...DEFAULTS }; }
}

export function saveSettings(s) {
  localStorage.setItem(LS_KEY, JSON.stringify(s));
}

export function loadLayout() {
  try {
    return { ...LAYOUT, ...JSON.parse(localStorage.getItem('pdfbt.layout') || '{}') };
  } catch { return { ...LAYOUT }; }
}

export function saveLayout(l) {
  localStorage.setItem('pdfbt.layout', JSON.stringify(l));
}
