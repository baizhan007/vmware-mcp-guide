#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
纯代码宣传视频生成器
1920x1080 / 30fps / 30 秒 / 900 帧，全部由 Python + Pillow 绘制。

用法:
    python make_video.py                 # 渲染全部帧
    python make_video.py --preview 0 150 # 只渲染指定帧（调试用）
"""

import os
import sys
import math
import argparse
from PIL import Image, ImageDraw, ImageFont, ImageFilter

# ----------------------------------------------------------------- 基础参数 ---
W, H = 1920, 1080
FPS = 30
DUR = 30.0
NFRAMES = int(FPS * DUR)

HERE = os.path.dirname(os.path.abspath(__file__))
FRAME_DIR = os.path.join(HERE, "frames")
ASSET_DIR = os.path.join(HERE, "assets")

F_CJK = "C:/Windows/Fonts/msyh.ttc"
F_CJK_BD = "C:/Windows/Fonts/msyhbd.ttc"
F_MONO = "C:/Windows/Fonts/consola.ttf"
F_MONO_BD = "C:/Windows/Fonts/consolab.ttf"

# ------------------------------------------------------------------- 配色 ---
BG_TOP = (10, 13, 19)
BG_BOT = (17, 22, 33)
FG = (230, 237, 243)
DIM = (120, 133, 150)
FAINT = (74, 85, 100)
GREEN = (63, 185, 80)
ORANGE = (255, 166, 87)
RED = (248, 81, 73)
BLUE = (88, 166, 255)
PURPLE = (188, 140, 255)
CYAN = (57, 210, 192)
YELLOW = (255, 210, 110)

# --------------------------------------------------------------- 字体缓存 ---
_font_cache = {}


def font(path, size):
    key = (path, size)
    if key not in _font_cache:
        _font_cache[key] = ImageFont.truetype(path, size)
    return _font_cache[key]


def is_wide(ch):
    """判断是否为全角/中日韩字符。"""
    o = ord(ch)
    return (
        0x2E80 <= o <= 0x9FFF
        or 0xF900 <= o <= 0xFAFF
        or 0xFE30 <= o <= 0xFE4F
        or 0xFF00 <= o <= 0xFF60
        or 0xFFE0 <= o <= 0xFFE6
        or 0x3000 <= o <= 0x303F
    )


def has_cjk(text):
    return any(is_wide(ch) for ch in text)


def pick_font(text, size, bold=False):
    """纯 ASCII 用等宽字体（代码感），含中文则整行用中文字体（间距均匀）。"""
    if has_cjk(text):
        return font(F_CJK_BD if bold else F_CJK, size)
    return font(F_MONO_BD if bold else F_MONO, size)


def measure(text, size, bold=False):
    return pick_font(text, size, bold).getlength(text)


def draw_mixed(d, xy, text, size, fill, bold=False, anchor_left=True):
    """绘制文本，自动选择字体（整行统一，避免中英间距不均）。"""
    f = pick_font(text, size, bold)
    d.text(xy, text, font=f, fill=fill)
    return xy[0] + f.getlength(text)


def draw_center(d, cy, text, size, fill, bold=False):
    """按给定中心 y 绘制水平居中的文本。"""
    w = measure(text, size, bold)
    x = (W - w) / 2
    return draw_mixed(d, (x, cy), text, size, fill, bold)


# ----------------------------------------------------------------- 缓动函数 ---
def clamp(v, a=0.0, b=1.0):
    return max(a, min(b, v))


def ease_out(t):
    t = clamp(t)
    return 1 - (1 - t) ** 3


def ease_in_out(t):
    t = clamp(t)
    return 3 * t * t - 2 * t * t * t


def ease_back(t):
    t = clamp(t)
    c = 1.70158
    return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2


def typed(text, t, start, cps):
    """打字机效果：返回已显示的文本和是否仍在打字。"""
    n = int(max(0.0, t - start) * cps)
    n = max(0, min(len(text), n))
    return text[:n], n < len(text)


def blink(t, period=1.0):
    return (t % period) < (period * 0.5)


# --------------------------------------------------------------- 背景预渲染 ---
def build_background():
    """渐变 + 网格 + 柔光，只渲染一次，每帧复制。"""
    img = Image.new("RGB", (W, H), BG_TOP)
    d = ImageDraw.Draw(img)
    for y in range(H):
        k = y / (H - 1)
        d.line(
            [(0, y), (W, y)],
            fill=(
                int(BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * k),
                int(BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * k),
                int(BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * k),
            ),
        )

    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    for x in range(0, W, 64):
        od.line([(x, 0), (x, H)], fill=(120, 160, 255, 9))
    for y in range(0, H, 64):
        od.line([(0, y), (W, y)], fill=(120, 160, 255, 9))

    # 左上角柔光
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((-500, -620, 1100, 780), fill=(70, 110, 255, 26))
    glow = glow.filter(ImageFilter.GaussianBlur(180))
    overlay = Image.alpha_composite(overlay, glow)

    # 右下角暖色
    glow2 = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    g2 = ImageDraw.Draw(glow2)
    g2.ellipse((1250, 620, 2500, 1700), fill=(255, 140, 60, 16))
    glow2 = glow2.filter(ImageFilter.GaussianBlur(200))
    overlay = Image.alpha_composite(overlay, glow2)

    img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")
    return img


# --------------------------------------------------------------- 组件：终端 ---
def draw_terminal(d, box, title="root@centos:~", scale=1.0):
    """画一个带标题栏的终端窗口。"""
    x0, y0, x1, y1 = box
    r = int(14 * scale)

    # 阴影
    d.rounded_rectangle(
        (x0 + 8, y0 + 14, x1 + 8, y1 + 16), radius=r, fill=(0, 0, 0)
    )
    # 窗体
    d.rounded_rectangle(box, radius=r, fill=(12, 16, 22), outline=(52, 59, 70), width=2)
    # 标题栏
    bar_h = int(48 * scale)
    d.rounded_rectangle((x0, y0, x1, y0 + bar_h), radius=r, fill=(24, 30, 39))
    d.rectangle((x0, y0 + bar_h - r, x1, y0 + bar_h), fill=(24, 30, 39))
    d.line([(x0, y0 + bar_h), (x1, y0 + bar_h)], fill=(52, 59, 70), width=1)

    cy = y0 + bar_h // 2
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        cx = x0 + int(28 * scale) + i * int(26 * scale)
        rr = int(7 * scale)
        d.ellipse((cx - rr, cy - rr, cx + rr, cy + rr), fill=c)

    tw = measure(title, int(22 * scale))
    draw_mixed(
        d,
        ((x0 + x1) / 2 - tw / 2, cy - int(15 * scale)),
        title,
        int(22 * scale),
        FAINT,
    )
    return y0 + bar_h


def draw_cursor(d, x, y, size, color=FG, t=0.0, period=1.0):
    """闪烁光标。"""
    if blink(t, period):
        d.rectangle((x, y + size * 0.12, x + size * 0.52, y + size * 0.92), fill=color)


# ------------------------------------------------------------------- 场景 1 ---
def scene_pain(t, dur):
    """痛点：一份实验报告要多久。"""
    img = base_img.copy()
    d = ImageDraw.Draw(img)

    box = (330, 300, 1590, 780)
    appear = ease_out(t / 0.5)
    if appear < 1.0:
        # 轻微上浮 + 淡入
        dy = int((1 - appear) * 26)
        d = ImageDraw.Draw(img)
        draw_terminal(d, (box[0], box[1] + dy, box[2], box[3] + dy))
        base_y = box[1] + dy + 48
    else:
        draw_terminal(d, box)
        base_y = box[1] + 48

    x = box[0] + 46
    y = base_y + 62
    size = 40

    # 第 1 行：问题
    line1 = "$ 一份大数据实验报告，要花多久？"
    txt, typing = typed(line1, t, 0.5, 22)
    draw_mixed(d, (x, y), txt, size, FG)
    if typing:
        draw_cursor(d, x + measure(txt, size), y, size, GREEN, t)

    # 第 2 行：答案（放大弹入）
    y2 = y + 96
    if t > 2.0:
        k = ease_back((t - 2.0) / 0.45)
        ans = "4 ~ 6 小时"
        s2 = int(64 * (0.82 + 0.18 * k))
        alpha = clamp((t - 2.0) / 0.3)
        col = tuple(int(DIM[i] + (ORANGE[i] - DIM[i]) * alpha) for i in range(3))
        draw_mixed(d, (x + 26, y2), ans, s2, col, bold=True)

    # 第 3 行：归因
    y3 = y2 + 116
    if t > 2.9:
        txt3, typing3 = typed("其中 70% 花在重复劳动上", t, 2.9, 24)
        draw_mixed(d, (x + 26, y3), txt3, 36, DIM)
        if typing3:
            draw_cursor(d, x + 26 + measure(txt3, 36), y3, 36, DIM, t)

    # 第 4 行：具体劳动
    y4 = y3 + 78
    if t > 3.7:
        a = clamp((t - 3.7) / 0.4)
        col = tuple(int(BG_BOT[i] + (FAINT[i] - BG_BOT[i]) * a) for i in range(3))
        draw_mixed(d, (x + 26, y4), "敲命令  ·  截图  ·  粘进 Word  ·  调格式", 30, col)

    return img


# ------------------------------------------------------------------- 场景 2 ---
def scene_idea(t, dur):
    """思路：如果 AI 能直接操作虚拟机。"""
    img = base_img.copy()
    d = ImageDraw.Draw(img)

    # 标题打字
    title = "如果 AI 能直接操作虚拟机"
    txt, typing = typed(title, t, 0.3, 14)
    ts = 68
    tw = measure(txt, ts, bold=True)
    draw_mixed(d, ((W - tw) / 2, 260), txt, ts, FG, bold=True)
    if typing:
        draw_cursor(d, (W - tw) / 2 + tw, 260, ts, CYAN, t)

    # 流水线节点
    nodes = [
        ("你", "说一句话", FG),
        ("MCP", "DSH · Claude", BLUE),
        ("server.js", "vmrun · SSH", PURPLE),
        ("虚拟机", "CentOS 7", GREEN),
    ]
    bw, bh, gap = 300, 116, 118
    total = len(nodes) * bw + (len(nodes) - 1) * gap
    x0 = (W - total) / 2
    cy = 560

    for i, (name, sub, color) in enumerate(nodes):
        st = 1.4 + i * 0.32
        if t < st:
            continue
        k = ease_back((t - st) / 0.45)
        bx = x0 + i * (bw + gap)
        scale = 0.7 + 0.3 * k
        w2, h2 = bw * scale, bh * scale
        cx, cyy = bx + bw / 2, cy + bh / 2
        box = (cx - w2 / 2, cyy - h2 / 2, cx + w2 / 2, cyy + h2 / 2)
        alpha = clamp((t - st) / 0.25)
        fill = tuple(int(BG_BOT[j] + (color[j] * 0.16 - BG_BOT[j]) * alpha) for j in range(3))
        d.rounded_rectangle(box, radius=16, fill=fill, outline=color, width=2)

        nw = measure(name, 40, bold=True)
        draw_mixed(d, (cx - nw / 2, cyy - 46), name, 40, color, bold=True)
        sw = measure(sub, 22)
        draw_mixed(d, (cx - sw / 2, cyy + 14), sub, 22, DIM)

    # 箭头
    for i in range(len(nodes) - 1):
        st = 1.4 + i * 0.32 + 0.3
        if t < st:
            continue
        k = ease_out((t - st) / 0.4)
        ax0 = x0 + (i + 1) * bw + i * gap + 12
        ax1 = ax0 + (gap - 24) * k
        ay = cy + bh / 2
        d.line([(ax0, ay), (ax1, ay)], fill=FAINT, width=3)
        if k > 0.7:
            d.polygon(
                [(ax1, ay), (ax1 - 12, ay - 7), (ax1 - 12, ay + 7)], fill=FAINT
            )

    # 副标题
    if t > 3.3:
        sub = "不是远程桌面 —— 是 25 个可调用的工具"
        txt2, typing2 = typed(sub, t, 3.3, 26)
        sw = measure(txt2, 32)
        draw_mixed(d, ((W - sw) / 2, 770), txt2, 32, DIM)
        if typing2:
            draw_cursor(d, (W - sw) / 2 + sw, 770, 32, CYAN, t)

    # 底部标签
    if t > 4.6:
        a = clamp((t - 4.6) / 0.4)
        label = "开机关机  ·  跑命令  ·  传文件  ·  打快照  ·  截图"
        col = tuple(int(BG_BOT[i] + (FAINT[i] - BG_BOT[i]) * a) for i in range(3))
        lw = measure(label, 26)
        draw_mixed(d, ((W - lw) / 2, 850), label, 26, col)

    return img


# ------------------------------------------------------------------- 场景 3 ---
SCENE3_LINES = [
    (0.00, "$ vmrun -T ws start centos.vmx nogui", FG),
    (0.55, "  [ok] powered on", GREEN),
    (1.10, "", FG),
    (1.15, '$ ssh root@192.168.7.128 "start-dfs.sh"', FG),
    (1.70, "  Starting namenodes on [localhost]", DIM),
    (2.05, "  Starting datanodes", DIM),
    (2.40, "  Starting secondary namenodes", DIM),
    (2.75, "", FG),
    (2.80, '$ hive -e "select count(*) from student2"', FG),
    (3.35, "  Total jobs = 1", DIM),
    (3.70, "  Stage-1: Map: 1  Reduce: 1   SUCCESS", GREEN),
    (4.05, "  Time taken: 82.297 seconds", DIM),
    (4.45, "  15", YELLOW),
    (4.95, "", FG),
    (5.00, "  [ok] 3 个 MR 任务全部 SUCCEEDED", GREEN),
]


def scene_exec(t, dur):
    """真实执行：终端输出。"""
    img = base_img.copy()
    d = ImageDraw.Draw(img)

    box = (230, 150, 1690, 900)
    draw_terminal(d, box, "root@centos — 真实执行，不是模拟")

    x = box[0] + 44
    y = box[1] + 48 + 40
    size = 31
    lh = 45

    shown = 0
    for delay, text, color in SCENE3_LINES:
        if t < delay:
            break
        shown += 1
        # 逐字出现（每条 0.18 秒打完）
        n = int(clamp((t - delay) / 0.16) * len(text))
        part = text[:n]
        if text.startswith("$"):
            draw_mixed(d, (x, y), part, size, CYAN, bold=False)
        else:
            draw_mixed(d, (x, y), part, size, color)
        if n < len(text):
            draw_cursor(d, x + measure(part, size), y, size, color, t, 0.4)
        y += lh

    # 底部强调
    if t > 5.5:
        k = ease_out((t - 5.5) / 0.5)
        msg = "全部真实执行 · 输出可追溯"
        ms = 34
        mw = measure(msg, ms, bold=True)
        bx = (W - mw) / 2
        by = 960
        col = tuple(int(BG_TOP[i] + (GREEN[i] - BG_TOP[i]) * k) for i in range(3))
        draw_mixed(d, (bx, by), msg, ms, col, bold=True)

    return img


# ------------------------------------------------------------------- 场景 4 ---
def scene_output(t, dur):
    """产出：截图 + 报告。"""
    img = base_img.copy()
    d = ImageDraw.Draw(img)

    # 标题
    if t > 0.15:
        a = clamp((t - 0.15) / 0.4)
        col = tuple(int(BG_BOT[i] + (FG[i] - BG_BOT[i]) * a) for i in range(3))
        draw_center(d, 96, "截图和排版，也是自动的", 60, col, bold=True)

    def card(img, box, path, label, start, from_dx):
        """卡片滑入。"""
        if t < start:
            return
        k = ease_out((t - start) / 0.6)
        dx = int(from_dx * (1 - k))
        x0, y0, x1, y1 = box
        box2 = (x0 + dx, y0, x1 + dx, y1)

        # 阴影
        sh = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        sd = ImageDraw.Draw(sh)
        sd.rounded_rectangle(
            (box2[0] + 6, box2[1] + 18, box2[2] + 6, box2[3] + 18),
            radius=12,
            fill=(0, 0, 0, 170),
        )
        sh = sh.filter(ImageFilter.GaussianBlur(18))
        img.paste(Image.alpha_composite(img.convert("RGBA"), sh).convert("RGB"), (0, 0))

        d2 = ImageDraw.Draw(img)
        d2.rounded_rectangle(box2, radius=12, fill=(20, 26, 35), outline=(60, 68, 80), width=2)

        # 图片按比例塞进卡片
        try:
            pic = Image.open(path).convert("RGB")
        except Exception:
            return
        pad = 12
        avail_w = (box2[2] - box2[0]) - pad * 2
        avail_h = (box2[3] - box2[1]) - pad * 2
        sc = min(avail_w / pic.width, avail_h / pic.height)
        nw, nh = int(pic.width * sc), int(pic.height * sc)
        pic = pic.resize((nw, nh), Image.LANCZOS)
        px = int((box2[0] + box2[2]) / 2 - nw / 2)
        py = int((box2[1] + box2[3]) / 2 - nh / 2)
        img.paste(pic, (px, py))

        # 标签
        d2 = ImageDraw.Draw(img)
        lw = measure(label, 26)
        draw_mixed(d2, ((box2[0] + box2[2]) / 2 - lw / 2, box2[3] + 22), label, 26, DIM)

    card(img, (120, 210, 900, 790), os.path.join(ASSET_DIR, "report", "page-0001.png"),
         "自动生成 · A4 排版 · 9 页", 0.45, -260)
    card(img, (1020, 210, 1800, 790), os.path.join(ASSET_DIR, "yarn-final.png"),
         "自动截取 · 1400×1200", 0.75, 260)

    # 底部结论
    if t > 2.0:
        a = clamp((t - 2.0) / 0.5)
        col = tuple(int(BG_BOT[i] + (CYAN[i] - BG_BOT[i]) * a) for i in range(3))
        draw_center(d, 930, "你只需要看一眼，改改措辞", 38, col, bold=True)

    return img


# ------------------------------------------------------------------- 场景 5 ---
def scene_cta(t, dur):
    """收尾：仓库地址。"""
    img = base_img.copy()
    d = ImageDraw.Draw(img)

    # 主标题
    if t > 0.1:
        k = ease_back((t - 0.1) / 0.6)
        s = int(96 * (0.85 + 0.15 * k))
        draw_center(d, 300, "vmware-mcp-guide", s, FG, bold=True)

    # 一行数据
    if t > 0.8:
        a = clamp((t - 0.8) / 0.4)
        col = tuple(int(BG_BOT[i] + (DIM[i] - BG_BOT[i]) * a) for i in range(3))
        draw_center(d, 470, "25 个 MCP 工具   ·   16 条踩坑   ·   2000 行教程", 38, col)

    # 地址
    if t > 1.5:
        a = clamp((t - 1.5) / 0.45)
        url = "github.com/baizhan007/vmware-mcp-guide"
        us = 46
        uw = measure(url, us, bold=True)
        ux = (W - uw) / 2
        col = tuple(int(BG_BOT[i] + (CYAN[i] - BG_BOT[i]) * a) for i in range(3))
        draw_mixed(d, (ux, 610), url, us, col, bold=True)
        # 下划线
        if a > 0.6:
            d.line([(ux, 686), (ux + uw, 686)], fill=col, width=3)

    # 三个标签
    if t > 2.3:
        tags = ["真实执行", "可复用", "坑已踩完"]
        tag_size = 28
        tws = [measure(x, tag_size) + 48 for x in tags]
        gap = 22
        total = sum(tws) + gap * (len(tags) - 1)
        tx = (W - total) / 2
        for i, tag in enumerate(tags):
            a = clamp((t - 2.3 - i * 0.14) / 0.35)
            if a <= 0:
                continue
            box = (tx, 790, tx + tws[i], 850)
            d.rounded_rectangle(
                box,
                radius=30,
                fill=tuple(int(BG_BOT[j] + (30 * 1.0 - BG_BOT[j]) * a) for j in range(3)),
                outline=tuple(int(BG_BOT[j] + (80 - BG_BOT[j]) * a) for j in range(3)),
                width=2,
            )
            lw = measure(tag, tag_size)
            draw_mixed(
                d,
                (tx + (tws[i] - lw) / 2, 800),
                tag,
                tag_size,
                tuple(int(BG_BOT[j] + (FG[j] - BG_BOT[j]) * a) for j in range(3)),
            )
            tx += tws[i] + gap

    # 元信息
    if t > 3.4:
        a = clamp((t - 3.4) / 0.5)
        col = tuple(int(BG_BOT[i] + (FAINT[i] - BG_BOT[i]) * a) for i in range(3))
        draw_center(d, 930, "900 帧 · 由 Python 逐帧绘制 · 没有一帧是录屏", 24, col)

    return img


# ----------------------------------------------------------------- 合成调度 ---
SCENES = [
    (0.0, 5.0, scene_pain),
    (5.0, 11.0, scene_idea),
    (11.0, 17.5, scene_exec),
    (17.5, 23.0, scene_output),
    (23.0, 30.0, scene_cta),
]
XF = 0.5  # 交叉淡入淡出时长


def scene_alpha(t, s, e):
    h = XF / 2
    if t < s - h or t > e + h:
        return 0.0
    a = 1.0
    if t < s + h:
        a = (t - (s - h)) / XF
    if t > e - h:
        a = ((e + h) - t) / XF
    return clamp(a)


def render_frame(i):
    t = i / FPS
    acc = None
    for s, e, fn in SCENES:
        a = scene_alpha(t, s, e)
        if a <= 0.001:
            continue
        local = clamp(t - s, 0.0, e - s)
        sub = fn(local, e - s)
        if acc is None:
            acc = sub.convert("RGBA")
        else:
            layer = sub.convert("RGBA")
            layer.putalpha(int(255 * a))
            acc = Image.alpha_composite(acc, layer)

    if acc is None:
        acc = base_img.convert("RGBA")

    out = acc.convert("RGB")

    # 底部进度条
    d = ImageDraw.Draw(out)
    prog = clamp(i / max(1, NFRAMES - 1))
    d.rectangle((0, H - 4, W, H), fill=(24, 30, 39))
    d.rectangle((0, H - 4, int(W * prog), H), fill=CYAN)

    # 整体淡出
    if t > DUR - 0.7:
        k = clamp((t - (DUR - 0.7)) / 0.7)
        dark = Image.new("RGB", (W, H), (0, 0, 0))
        out = Image.blend(out, dark, k)

    return out


# --------------------------------------------------------------------- 主流程 ---
def main():
    global base_img

    ap = argparse.ArgumentParser()
    ap.add_argument("--preview", nargs=2, type=int, metavar=("START", "END"))
    args = ap.parse_args()

    print("构建背景...")
    base_img = build_background()

    os.makedirs(FRAME_DIR, exist_ok=True)

    if args.preview:
        start, end = args.preview
        for i in range(start, min(end, NFRAMES)):
            render_frame(i).save(
                os.path.join(FRAME_DIR, f"p{i:05d}.png"), compress_level=1
            )
        print(f"预览帧已输出: {start}..{end - 1}")
        return

    for i in range(NFRAMES):
        render_frame(i).save(
            os.path.join(FRAME_DIR, f"{i:05d}.png"), compress_level=1
        )
        if i % 60 == 0:
            pct = i / NFRAMES * 100
            print(f"  {i:4d}/{NFRAMES}  {pct:5.1f}%", flush=True)

    print(f"完成，共 {NFRAMES} 帧 -> {FRAME_DIR}")


if __name__ == "__main__":
    main()
