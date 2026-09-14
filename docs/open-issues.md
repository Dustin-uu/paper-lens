# 未解决的问题

记在这里的是**已经定位清楚、但还没修**的问题。修掉一条就从这里删掉。

## 点公式问 AI，在导入的精读稿里拿不到公式内容

**现象**：导入手工精读稿后，点正文里的行间公式会打开 AI 侧栏，但 AI 看不到公式本身，
只能靠上下文猜。

**原因**：这条链路（`reader.js` 的 `onFormula` → `main.js` 的 `askFormula`）是为自动解析
设计的。自动解析下公式是一张截图，`askFormula` 把 `block.blob` 当图片发给读图模型。
而精读稿里的公式是 `kind: 'math'` 的 LaTeX 文本块，**没有 blob**：

- `imageBlob` 为空，读图模型收不到任何图；
- `ocrText` 取的是 `block.ocr`，而 math 块的内容在 `block.text` 里，也没传过去。

**怎么修**：`askFormula` 对 `kind === 'math'` 的块，把 `block.text`（LaTeX 源码）作为
`ocrText` 传给 `Conversation`，侧栏标题显示渲染后的公式而不是"公式/表格"。
`ai.js` 的 `_firstUserContent` 已经支持 `ocrText`，并且在没有图片时会降级到纯文本提示，
接上就行。

**影响**：只影响导入的精读稿，以及模型解析引擎里那些锚不到坐标、以 `math` 形式呈现的公式。
自动解析产出的截图公式不受影响。
