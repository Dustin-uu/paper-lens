#!/usr/bin/env python3
"""把人工精读写出的稿子编译成 paper-lens 可以直接导入的文档。

这条路线和应用内的自动解析是两回事：那边是程序（或模型）去猜版面，这边是人
读完原文后直接写出块序列和译文，工具只负责按给定坐标裁图、打包。慢，但上限高 ——
公式该是什么就是什么，段落顺序也不会错。

稿子格式（纯文本，见 SKILL.md）:
    @meta
    title-en: ...
    title-zh: ...

    @page 3                     之后的块都算第 3 页

    @h1 / @h2 / @h3             标题
    @p                          正文段落
    @note                       脚注、小字
    @cap                        图题表题
    @math                       行间公式，只写 LaTeX，不译
    @ref                        参考文献条目，不译
    @fig x0,y0,x1,y1            按坐标从当前页裁一张图

    块内用一行 "--" 分隔原文与译文；没有 "--" 的块不带译文。
    行内公式直接写 \\( ... \\)，阅读器会用 KaTeX 渲染。

用法:  python3 tools/build.py <pdf> <稿子.txt> <输出.json>
"""
import base64
import io
import json
import re
import sys
import time

import fitz

DPI = 200
KIND = {'h1': 'heading', 'h2': 'heading', 'h3': 'heading', 'p': 'para',
        'note': 'note', 'cap': 'caption', 'math': 'math', 'ref': 'ref'}
LEVEL = {'h1': 1, 'h2': 2, 'h3': 3}


def parse_script(text):
    meta, blocks = {}, []
    page, cur = 1, None
    mode = None

    def flush():
        nonlocal cur
        if cur is None:
            return
        body = '\n'.join(cur['buf']).strip()
        if body:
            en, _, zh = body.partition('\n--\n')
            cur['text'] = en.strip()
            cur['zh'] = zh.strip()
            del cur['buf']
            blocks.append(cur)
        cur = None

    for raw in text.replace('\r', '').split('\n'):
        line = raw.rstrip()
        tag = re.match(r'^@(\w+)(?:\s+(.*))?$', line)
        if tag:
            flush()
            name, arg = tag.group(1), (tag.group(2) or '').strip()
            if name == 'meta':
                mode = 'meta'
                continue
            mode = None
            if name == 'page':
                page = int(arg)
                continue
            if name == 'fig':
                nums = [float(x) for x in re.split(r'[,\s]+', arg) if x]
                if len(nums) != 4:
                    raise SystemExit('@fig 需要四个坐标: %r' % line)
                blocks.append({'kind': 'graphic', 'page': page, 'bbox': nums})
                continue
            if name not in KIND:
                raise SystemExit('不认识的标记 @%s' % name)
            cur = {'kind': KIND[name], 'page': page, 'buf': []}
            if name in LEVEL:
                cur['level'] = LEVEL[name]
            continue
        if mode == 'meta':
            if ':' in line:
                k, _, v = line.partition(':')
                meta[k.strip()] = v.strip()
            continue
        if cur is not None:
            cur['buf'].append(line)
        elif line.strip():
            raise SystemExit('块外出现正文，忘了写 @p 吗: %r' % line[:60])
    flush()
    return meta, blocks


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        raise SystemExit(1)
    pdf_path, script_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
    meta, blocks = parse_script(open(script_path, encoding='utf-8').read())

    doc = fitz.open(pdf_path)
    scale = DPI / 72.0
    n_fig = 0
    for b in blocks:
        if b['kind'] != 'graphic':
            continue
        page = doc[b['page'] - 1]
        clip = fitz.Rect(*b['bbox'])
        pix = page.get_pixmap(dpi=DPI, clip=clip)
        buf = io.BytesIO()
        pix.pil_save(buf, format='WEBP', quality=92)
        b['img'] = 'data:image/webp;base64,' + base64.b64encode(buf.getvalue()).decode()
        b['w'], b['h'] = round(clip.width), round(clip.height)
        b['text'] = ''
        n_fig += 1
    pages = doc.page_count
    doc.close()

    for i, b in enumerate(blocks):
        b['id'] = i
        b.setdefault('text', '')

    out = {
        'format': 'paper-lens/doc@1',
        'title': meta.get('title-zh') or meta.get('title-en') or '未命名',
        'enTitle': meta.get('title-en', ''),
        'pages': pages,
        'created': int(time.time() * 1000),
        'fileName': meta.get('file', ''),
        'blocks': blocks,
    }
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False)

    kinds = {}
    for b in blocks:
        kinds[b['kind']] = kinds.get(b['kind'], 0) + 1
    size = len(json.dumps(out, ensure_ascii=False).encode()) / 1048576
    translated = sum(1 for b in blocks if b.get('zh'))
    print('%s  %d 块（%s）  %d 块有译文  %d 张图  %.1f MB'
          % (out_path, len(blocks),
             ' '.join('%s×%d' % kv for kv in sorted(kinds.items())),
             translated, n_fig, size))


if __name__ == '__main__':
    main()
