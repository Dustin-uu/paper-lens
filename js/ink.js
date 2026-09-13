// 墨迹投影：把渲染好的页面降到低分辨率，逐行记录"这一行有没有内容、内容的左右边界在哪"。
//
// 为什么需要它：图表里真正把各部分连成一体的是矢量线条（坐标轴、折线、分数线、
// 矩阵括号），这些东西 getTextContent() 一个都不返回。只看文字碎片，一张折线图
// 会碎成几条横带。所以直接去看渲染出来的像素。
//
// 注意别按区域在高分辨率画布上取 getImageData —— 实测 85 页会从 5 秒涨到 80 秒。
// 一次性降采样后整页取一遍，才是对的做法。

export const INK_SCALE = 0.5;          // 相对 72dpi，即 36dpi

// 从一张已经画好的高分辨率页面画布，算出低分辨率的逐行墨迹。
export function inkFrom(srcCanvas, pageW, pageH, mkCanvas, scale = INK_SCALE) {
  const W = Math.max(1, Math.ceil(pageW * scale));
  const H = Math.max(1, Math.ceil(pageH * scale));
  const cv = mkCanvas(W, H);
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(srcCanvas, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;

  const rows = new Uint8Array(H);
  const mask = new Uint8Array(W * H);      // 逐像素墨迹，二维覆盖判定要用
  const minX = new Int16Array(H).fill(-1);
  const maxX = new Int16Array(H).fill(-1);
  // 一次扫描同时拿到"有无墨迹"和"左右边界"。分两次扫会慢一倍，而定图形区时
  // 两样都要用。
  for (let y = 0; y < H; y++) {
    const base = y * W * 4;
    let mn = -1, mx = -1;
    for (let x = 0; x < W; x++) {
      const i = base + x * 4;
      if (d[i] < 248 || d[i + 1] < 248 || d[i + 2] < 248) {
        mask[y * W + x] = 1;
        if (mn < 0) mn = x; mx = x;
      }
    }
    rows[y] = mn >= 0 ? 1 : 0; minX[y] = mn; maxX[y] = mx;
  }
  return { rows, mask, minX, maxX, W, H, s: scale };
}

// 哪些行已经被认领了。boxes 是 [x0,y0,x1,y1]（pt）。
export function coverMap(ink, boxes, padPt = 1) {
  const c = new Uint8Array(ink.H);
  for (const bb of boxes) {
    const a = Math.max(0, Math.floor((bb[1] - padPt) * ink.s));
    const b = Math.min(ink.H - 1, Math.ceil((bb[3] + padPt) * ink.s));
    for (let y = a; y <= b; y++) c[y] = 1;
  }
  return c;
}

// 找出"有墨迹、却没人认领"的连续行段 —— 纯位图插图和无标注矢量图就是这么被发现的，
// 它们不产生任何文本碎块，靠文字聚类永远看不见。
export function freeInkRuns(ink, covered, minHpt, minWpt = 12) {
  const minH = Math.max(3, Math.round(minHpt * ink.s));
  const out = [];
  let start = -1;
  for (let y = 0; y <= ink.H; y++) {
    const on = y < ink.H && ink.rows[y] && !covered[y];
    if (on && start < 0) start = y;
    else if (!on && start >= 0) {
      if (y - start >= minH) {
        let x0 = ink.W, x1 = 0;
        for (let yy = start; yy < y; yy++) {
          if (ink.minX[yy] < 0) continue;
          if (ink.minX[yy] < x0) x0 = ink.minX[yy];
          if (ink.maxX[yy] > x1) x1 = ink.maxX[yy];
        }
        if (x1 > x0 + minWpt * ink.s) {
          out.push([Math.max(0, x0 - 2) / ink.s, Math.max(0, start - 2) / ink.s,
                    Math.min(ink.W, x1 + 3) / ink.s, Math.min(ink.H, y + 2) / ink.s]);
        }
      }
      start = -1;
    }
  }
  return out;
}

// 沿墨迹把上下边界推出去，直到撞上别人的地盘或足够长的空白。
// 截图边界差几个点就会切掉半行字形，这一步专门补那几个点。
export function growToInk(ink, covered, bb, maxGrowPt = 24) {
  const blankLim = Math.max(2, Math.round(5 * ink.s));
  const lim = Math.max(1, Math.round(maxGrowPt * ink.s));
  const out = [...bb];
  for (const dir of [-1, 1]) {
    const from = dir > 0 ? bb[3] : bb[1];
    let blank = 0, edge = from;
    for (let k = 1; k <= lim; k++) {
      const y = Math.round(from * ink.s) + dir * k;
      if (y < 0 || y >= ink.H || covered[y]) break;
      if (ink.rows[y]) {
        blank = 0; edge = y / ink.s;
        if (ink.minX[y] >= 0) {
          out[0] = Math.min(out[0], ink.minX[y] / ink.s);
          out[2] = Math.max(out[2], ink.maxX[y] / ink.s);
        }
      } else if (++blank >= blankLim) break;
    }
    if (dir > 0) out[3] = Math.max(out[3], edge + 1);
    else out[1] = Math.min(out[1], edge - 1);
  }
  return out;
}

// 二维版的"没人认领的墨迹"。
//
// 逐行投影在这里是不够的：一张带密集标注的多面板图，每一行都压着几个刻度标签，
// 整行都算"被文字认领"，于是绘图区完全看不见 —— 实测某篇论文的图页 free 行数为 0，
// 一张图都找不出来。
// 改成只遮文字框本身：曲线、坐标轴、色块这些落在标签之间的墨迹就露出来了。
export function freeInkRuns2D(ink, boxes, minHpt, minRatio = 0.04) {
  const { mask, W, H, s } = ink;
  const cov = new Uint8Array(W * H);
  for (const bb of boxes) {
    const y0 = Math.max(0, Math.floor(bb[1] * s) - 1), y1 = Math.min(H - 1, Math.ceil(bb[3] * s) + 1);
    const x0 = Math.max(0, Math.floor(bb[0] * s) - 1), x1 = Math.min(W - 1, Math.ceil(bb[2] * s) + 1);
    for (let y = y0; y <= y1; y++) { const base = y * W; for (let x = x0; x <= x1; x++) cov[base + x] = 1; }
  }
  const need = Math.max(4, Math.round(W * minRatio));
  const hot = new Uint8Array(H);
  const lo = new Int16Array(H).fill(-1), hi = new Int16Array(H).fill(-1);
  for (let y = 0; y < H; y++) {
    const base = y * W;
    let n = 0, mn = -1, mx = -1;
    for (let x = 0; x < W; x++) {
      if (mask[base + x] && !cov[base + x]) { n++; if (mn < 0) mn = x; mx = x; }
    }
    if (n >= need) { hot[y] = 1; lo[y] = mn; hi[y] = mx; }
  }
  // 容忍图中间几行空白（面板之间的间隔）
  const minH = Math.max(3, Math.round(minHpt * s));
  const gapTol = Math.max(2, Math.round(10 * s));
  const out = [];
  let start = -1, blank = 0;
  for (let y = 0; y <= H; y++) {
    const on = y < H && hot[y];
    if (on) { if (start < 0) start = y; blank = 0; }
    else if (start >= 0 && ++blank > gapTol) {
      const end = y - blank;
      if (end - start >= minH) {
        let x0 = W, x1 = 0;
        for (let yy = start; yy <= end; yy++) {
          if (lo[yy] < 0) continue;
          if (lo[yy] < x0) x0 = lo[yy];
          if (hi[yy] > x1) x1 = hi[yy];
        }
        if (x1 > x0 + 12 * s) {
          out.push([Math.max(0, x0 - 3) / s, Math.max(0, start - 3) / s,
                    Math.min(W, x1 + 4) / s, Math.min(H, end + 4) / s]);
        }
      }
      start = -1; blank = 0;
    }
  }
  return out;
}
