#!/usr/bin/env python3
# drawio → SVG 预览渲染器（只实现本项目用到的子集：rect / text / swimlane / orthogonal edge）
#
# 为什么需要它：交付物是 .drawio 源文件，但本机没装 draw.io Desktop，没法目视检查，
# 也没法让用户直接看。这个渲染器把 XML 直接画成 SVG，布局、换行、颜色都按 drawio 的
# 语义来，于是"图里有没有压字/错位"变成可截图验证的事，而不是靠猜。
#
# 只支持本项目实际用到的属性：fillColor / strokeColor / dashed / fontSize / fontStyle /
# align / verticalAlign / spacingLeft / spacingTop / startSize / edgeStyle + exit/entry + points。
# 不追求兼容任意 drawio 文件。
#
# 用法：python scripts/drawio-preview.py <in.drawio> <out.svg>

import sys
import re
import html as htmlmod
import xml.etree.ElementTree as ET

FONT = "Microsoft YaHei, PingFang SC, Hiragino Sans GB, system-ui, sans-serif"


def style_dict(s):
    d = {}
    for kv in (s or "").split(";"):
        if "=" in kv:
            k, v = kv.split("=", 1)
            d[k.strip()] = v.strip()
    return d


def num(d, k, default):
    try:
        return float(d.get(k, default))
    except (TypeError, ValueError):
        return float(default)


def load(path):
    root = ET.parse(path).getroot()
    cells, order = {}, []
    for c in root.iter("mxCell"):
        cid = c.get("id")
        cells[cid] = c
        order.append(cid)
    model = root.find(".//mxGraphModel")
    return cells, order, model


def geo(c):
    g = c.find("mxGeometry")
    if g is None:
        return None
    return {
        "x": num(g, "x", 0), "y": num(g, "y", 0),
        "w": num(g, "width", 0), "h": num(g, "height", 0),
        "points": [(num(p, "x", 0), num(p, "y", 0)) for p in g.findall(".//mxPoint")],
    }


def abs_xy(cid, cells, cache, seen=None):
    if cid in cache:
        return cache[cid]
    seen = seen or set()
    if cid in seen:
        return 0.0, 0.0
    seen.add(cid)
    c = cells.get(cid)
    if c is None:
        return 0.0, 0.0
    g = geo(c)
    if g is None:
        return 0.0, 0.0
    x, y = g["x"], g["y"]
    par = c.get("parent")
    if par and par in cells and cells[par].get("vertex") == "1":
        px, py = abs_xy(par, cells, cache, seen)
        x += px
        y += py
    cache[cid] = (x, y)
    return x, y


# 只剥离 drawio 真会产出的那几个标签。**不能用 <[^>]+> 通配**：
# 图里写的是 &lt;job&gt; 这种字面量尖括号，XML 解析后同样是 <job>，
# 通配会把它连同内容一起吃掉（实测 job_sent_<job>_<slot>_<日> 变成 job_sent___）。
TAG_RE = re.compile(r"</?(?:b|i|u|s|strong|em|font|br|div|span|a|p|sup|sub)\b[^>]*>", re.I)


def rich_lines(value):
    """把 drawio 的 html value 切成 [(文本, 颜色, 是否粗体)]，逐行。"""
    if value is None:
        return []
    out = []
    for raw in re.split(r"<br\s*/?>", value):
        color = None
        m = re.search(r"<font\s+color=['\"]([^'\"]+)['\"]", raw)
        if m:
            color = m.group(1)
        bold = "<b>" in raw
        txt = TAG_RE.sub("", raw)
        out.append((txt, color, bold))
    return out


def escaped(t):
    return (t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def render(inp, outp):
    cells, order, model = load(inp)
    W = num(model, "pageWidth", 1200) if model is not None else 1200
    H = num(model, "pageHeight", 900) if model is not None else 900
    cache = {}
    out = []
    out.append(
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W:.0f} {H:.0f}" width="{W:.0f}" height="{H:.0f}">'
    )
    out.append(
        '<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" '
        'orient="auto-start-reverse"><path d="M1 1L9 5L1 9" fill="none" stroke="context-stroke" '
        'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>'
    )
    out.append(f'<rect x="0" y="0" width="{W:.0f}" height="{H:.0f}" fill="#ffffff"/>')

    # 1) 顶点
    for cid in order:
        c = cells[cid]
        if c.get("vertex") != "1":
            continue
        g = geo(c)
        if g is None:
            continue
        x, y = abs_xy(cid, cells, cache)
        w, h = g["w"], g["h"]
        st = style_dict(c.get("style"))
        fill = st.get("fillColor", "#ffffff")
        stroke = st.get("strokeColor", "#666666")
        dash = ' stroke-dasharray="4 4"' if st.get("dashed") == "1" else ""
        sw = num(st, "strokeWidth", 1)
        if st.get("swimlane") == "swimlane":
            out.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"{dash}/>')
            start = num(st, "startSize", 26)
            out.append(f'<line x1="{x:.1f}" y1="{y + start:.1f}" x2="{x + w:.1f}" y2="{y + start:.1f}" stroke="{stroke}" stroke-width="0.8"/>')
            fs = num(st, "fontSize", 11)
            out.append(
                f'<text x="{x + 10:.1f}" y="{y + start / 2 + fs * 0.36:.1f}" font-family="{FONT}" '
                f'font-size="{fs}" font-weight="600" fill="#1a1a1a">{escaped(htmlmod.unescape(TAG_RE.sub("", c.get("value") or "")))}</text>'
            )
            continue
        out.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"{dash}/>')

        lines = rich_lines(c.get("value"))
        if not lines:
            continue
        fs = num(st, "fontSize", 12)
        lh = fs * 1.55
        is_text = "text" in (c.get("style") or "").split(";")[0:1] or st.get("text") == "1"
        align = st.get("align", "center")
        valign = st.get("verticalAlign", "middle")
        padl = num(st, "spacingLeft", 0)
        padt = num(st, "spacingTop", 0)
        if valign == "top":
            baseline = y + padt + fs * 0.92
        else:
            block = len(lines) * lh
            baseline = y + (h - block) / 2 + fs * 0.92
        for i, (txt, color, bold) in enumerate(lines):
            if not txt.strip() and not lines[i][0]:
                baseline += lh
                continue
            fillc = color or st.get("fontColor", "#1a1a1a")
            weight = "600" if bold else "400"
            if align == "left":
                tx, anchor = x + (padl if padl else 10), "start"
            else:
                tx, anchor = x + w / 2, "middle"
            out.append(
                f'<text x="{tx:.1f}" y="{baseline:.1f}" text-anchor="{anchor}" font-family="{FONT}" '
                f'font-size="{fs}" font-weight="{weight}" fill="{fillc}">{escaped(txt)}</text>'
            )
            baseline += lh

    # 2) 边
    for cid in order:
        c = cells[cid]
        if c.get("edge") != "1":
            continue
        g = geo(c)
        st = style_dict(c.get("style"))
        src, tgt = c.get("source"), c.get("target")
        if src not in cells or tgt not in cells:
            continue
        sg, tg = geo(cells[src]), geo(cells[tgt])
        if sg is None or tg is None:
            continue
        sx, sy = abs_xy(src, cells, cache)
        tx, ty = abs_xy(tgt, cells, cache)
        p0 = (sx + sg["w"] * num(st, "exitX", 0.5), sy + sg["h"] * num(st, "exitY", 0.5))
        p1 = (tx + tg["w"] * num(st, "entryX", 0.5), ty + tg["h"] * num(st, "entryY", 0.5))
        pts = g["points"] if g else []
        path = [p0] + pts + [p1]
        d = " ".join(f"{'M' if i == 0 else 'L'}{px:.1f} {py:.1f}" for i, (px, py) in enumerate(path))
        color = st.get("strokeColor", "#666666")
        dash = ' stroke-dasharray="4 4"' if st.get("dashed") == "1" else ""
        out.append(
            f'<path d="{d}" fill="none" stroke="{color}" stroke-width="1.5"{dash} marker-end="url(#a)"/>'
        )
        label = c.get("value")
        if label:
            fs = num(st, "fontSize", 10)
            mx = (p0[0] + path[1][0]) / 2 if len(path) > 2 else (p0[0] + p1[0]) / 2
            my = (p0[1] + path[1][1]) / 2 if len(path) > 2 else (p0[1] + p1[1]) / 2
            txt = htmlmod.unescape(TAG_RE.sub("", label))
            tw = sum(fs if ord(ch) > 127 else fs * 0.56 for ch in txt) + 8
            out.append(f'<rect x="{mx - tw / 2:.1f}" y="{my - fs * 1.15:.1f}" width="{tw:.1f}" height="{fs * 1.5:.1f}" fill="#ffffff" opacity="0.92"/>')
            out.append(
                f'<text x="{mx:.1f}" y="{my + fs * 0.1:.1f}" text-anchor="middle" font-family="{FONT}" '
                f'font-size="{fs}" fill="{st.get("fontColor", "#444444")}">{escaped(txt)}</text>'
            )

    out.append("</svg>")
    open(outp, "w", encoding="utf-8").write("\n".join(out))
    print(f"写出 {outp}（{W:.0f}×{H:.0f}，{len([1 for i in order if cells[i].get('vertex') == '1'])} 顶点 / "
          f"{len([1 for i in order if cells[i].get('edge') == '1'])} 边）")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    render(sys.argv[1], sys.argv[2])
