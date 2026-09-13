#!/usr/bin/env python3
"""勘察一份 PDF：每页有多少文本块、多少矢量绘图、多少位图。

用途是在人工精读之前判断哪几页真有插图 —— 只有那几页需要在稿子里写 @fig，
其余页面是纯文字加公式，直接转录即可。

矢量绘图的数量是最有用的信号：正文页通常是 0（偶尔几条分隔线），
而一张折线图在 PDF 里是几百条独立线段。

用法:  python3 tools/survey.py <pdf>
"""
import sys

import fitz


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        raise SystemExit(1)
    doc = fitz.open(sys.argv[1])
    print('页数 %d   页面尺寸 %s' % (doc.page_count, doc[0].rect))
    print('%-6s %-8s %-8s %-6s' % ('页', '文本块', '矢量绘图', '位图'))
    for i in range(doc.page_count):
        page = doc[i]
        texts = [b for b in page.get_text('dict')['blocks'] if b['type'] == 0]
        draws = page.get_drawings()
        imgs = page.get_images(full=True)
        mark = ''
        if imgs or len(draws) > 40:
            ys = [d['rect'] for d in draws if not d['rect'].is_empty]
            span = ''
            if ys:
                span = '  绘图纵向范围 y=%d..%d' % (min(r.y0 for r in ys), max(r.y1 for r in ys))
            mark = '   <== 很可能有插图' + span
        print('p%-5d %-8d %-8d %-6d%s' % (i + 1, len(texts), len(draws), len(imgs), mark))
    doc.close()


if __name__ == '__main__':
    main()
