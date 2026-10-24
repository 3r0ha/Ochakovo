"""Векторные файлы принтов мерча «Смена» для производства: docs/brand/merch/art/*.svg.

Набор, за что выдают и как выглядят вещи — docs/brand/merch.md, технические рисунки изделий —
docs/brand/merch/layouts.html. Здесь — сами принты в натуральную величину: размеры в миллиметрах,
текст переведён в кривые, поэтому подрядчику не нужны шрифты.

Шрифты — те же, что на сайте и листовках (OFL, docs/brand/print/fonts/OFL.txt): Sofia Sans Extra Condensed
для заголовков, Onest для мелкого текста. Пиктограммы — фирменный набор public/brand/pictograms;
пиктограммы склада в наборе нет, она нарисована по той же сетке (art/picto-warehouse.svg) и требует согласования.
Цвета — брендбук, стр. 58: красный #D50032 (Pantone 199 C), тёмно-красный #AB2328, белый, тёмно-серый #3E3E3E.
Контур высечки наклеек — линия CutContour цвета #FF00FF, её не печатают.

Носки (вязаный жаккард) — пиктограммы в сетке петель: картинку переводит в петли sharp (node), сетка — в art/socks.svg.

Запуск: python3 scripts/merch-art.py  (нужны fonttools с brotli и node с sharp из node_modules проекта)
"""
import json
import re
import subprocess
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = Path(__file__).resolve().parent.parent
FONTS = ROOT / 'docs/brand/print/fonts'
PICTO = ROOT / 'public/brand/pictograms'
BRAND = ROOT / 'public/brand'
OUT = ROOT / 'docs/brand/merch/art'

RED = '#D50032'
RED_DARK = '#AB2328'
WHITE = '#FFFFFF'
INK = '#3E3E3E'
# Никель значков на макете — светло-серый: в производстве это металл, а не краска
NICKEL = '#C9CDD0'
CUT = '#FF00FF'


def num(v: float) -> str:
    s = f'{v:.2f}'.rstrip('0').rstrip('.')
    return '0' if s in ('-0', '') else s


# ── Шрифты: текст в кривые ────────────────────────────────────────────────


def kerning(font: TTFont):
    """Кернинг из GPOS (фича kern, PairPos форматов 1 и 2): функция пары глифов → поправка в единицах шрифта"""
    if 'GPOS' not in font:
        return lambda a, b: 0
    gpos = font['GPOS'].table
    indexes = sorted({i for fr in gpos.FeatureList.FeatureRecord if fr.FeatureTag == 'kern' for i in fr.Feature.LookupListIndex})
    subtables = []
    for i in indexes:
        lookup = gpos.LookupList.Lookup[i]
        for st in lookup.SubTable:
            if lookup.LookupType == 9:
                st = st.ExtSubTable
            if getattr(st, 'LookupType', 2) != 2:
                continue
            cov = set(st.Coverage.glyphs)
            if st.Format == 1:
                pairs = {}
                for g, ps in zip(st.Coverage.glyphs, st.PairSet):
                    for r in ps.PairValueRecord:
                        v = getattr(r.Value1, 'XAdvance', 0) if r.Value1 else 0
                        pairs[(g, r.SecondGlyph)] = v or 0
                subtables.append(('pairs', cov, pairs))
            elif st.Format == 2:
                subtables.append(('class', cov, st))

    def kern(a: str, b: str) -> int:
        for kind, cov, data in subtables:
            if a not in cov:
                continue
            if kind == 'pairs':
                if (a, b) in data:
                    return data[(a, b)]
                continue
            c1 = data.ClassDef1.classDefs.get(a, 0)
            c2 = data.ClassDef2.classDefs.get(b, 0)
            rec = data.Class1Record[c1].Class2Record[c2]
            v = getattr(rec.Value1, 'XAdvance', 0) if rec.Value1 else 0
            if v:
                return v
        return 0

    return kern


class Face:
    """Начертание: кириллица и латиница из двух файлов сайта, вариативная ось wght закреплена"""

    def __init__(self, family: str, wght: int):
        self.parts = []
        for name in (f'{family}-cyrillic-wght-normal.woff2', f'{family}-latin-wght-normal.woff2'):
            font = instancer.instantiateVariableFont(TTFont(FONTS / name), {'wght': wght})
            self.parts.append((font.getBestCmap(), font.getGlyphSet(), font['hmtx'], kerning(font)))
            self.upm = font['head'].unitsPerEm
            self.cap = font['OS/2'].sCapHeight / self.upm

    def glyphs(self, text: str):
        out = []
        for ch in text:
            for i, (cmap, gs, hmtx, kern) in enumerate(self.parts):
                if ord(ch) in cmap:
                    out.append((i, cmap[ord(ch)]))
                    break
            else:
                raise ValueError(f'нет знака {ch!r}')
        return out

    def width(self, text: str, size: float, tracking: float = 0) -> float:
        k = size / self.upm
        gl = self.glyphs(text)
        w = 0.0
        for n, (i, g) in enumerate(gl):
            w += self.parts[i][2][g][0] * k
            if n + 1 < len(gl) and gl[n + 1][0] == i:
                w += self.parts[i][3](g, gl[n + 1][1]) * k
        return w + tracking * (len(gl) - 1)

    def fit(self, text: str, width: float) -> float:
        """Кегль, при котором строка занимает ровно width мм"""
        return width / self.width(text, 1000) * 1000

    def path(self, text: str, size: float, x: float, y: float, tracking: float = 0, anchor: str = 'start') -> str:
        """Контуры строки: y — базовая линия, размеры в мм"""
        k = size / self.upm
        w = self.width(text, size, tracking)
        if anchor == 'middle':
            x -= w / 2
        elif anchor == 'end':
            x -= w
        gl = self.glyphs(text)
        d = []
        cursor = x
        for n, (i, g) in enumerate(gl):
            cmap, gs, hmtx, kern = self.parts[i]
            pen = SVGPathPen(gs, ntos=num)
            gs[g].draw(TransformPen(pen, (k, 0, 0, -k, cursor, y)))
            if pen.getCommands():
                d.append(pen.getCommands())
            cursor += hmtx[g][0] * k + tracking
            if n + 1 < len(gl) and gl[n + 1][0] == i:
                cursor += kern(g, gl[n + 1][1]) * k
        return ' '.join(d)


DISPLAY = Face('sofia-sans-extra-condensed', 860)
TEXT = Face('onest', 500)
TEXT_BOLD = Face('onest', 650)


def accent(s: str, size: float) -> float:
    """Запас над прописными: кратка «Й» и точки «Ё» стоят выше линии прописных"""
    return 0.2 * size if any(c in 'ЙЁ' for c in s) else 0


def text(face: Face, s: str, size: float, x: float, y: float, fill: str, tracking: float = 0, anchor: str = 'start') -> str:
    return f'<path fill="{fill}" d="{face.path(s, size, x, y, tracking, anchor)}"/>'


# ── Пиктограммы и логотип ─────────────────────────────────────────────────

# Склад: коробки на поддоне. Сетка 48 × 48, линия 1,23 — как у пиктограмм брендбука
WAREHOUSE_D = (
    # поддон: верхний и нижний настил, три опоры
    'M11.35 34.7H36.73V35.93H11.35Z M11.35 39.38H36.73V40.61H11.35Z '
    'M12.2 35.93H15.2V39.38H12.2Z M22.54 35.93H25.54V39.38H22.54Z M32.88 35.93H35.88V39.38H32.88Z '
    # две нижние коробки и верхняя: контур с внутренним вырезом, лента по центру крышки
    'M12.58 23.4H23.42V34.7H12.58Z M13.81 24.63V33.47H22.19V24.63Z M17.38 24.63H18.61V28.3H17.38Z '
    'M24.66 23.4H35.5V34.7H24.66Z M25.89 24.63V33.47H34.27V24.63Z M29.47 24.63H30.7V28.3H29.47Z '
    'M18.62 12.1H29.46V23.4H18.62Z M19.85 13.33V22.17H28.23V13.33Z M23.42 13.33H24.65V17H23.42Z'
)


def picto_d(pid: str) -> str:
    if pid == 'warehouse':
        return WAREHOUSE_D
    src = (PICTO / f'{pid}.svg').read_text()
    return ' '.join(re.findall(r' d="([^"]+)"', src))


def bbox(d: str):
    nums = [float(v) for v in re.findall(r'-?\d+(?:\.\d+)?', d)]
    xs, ys = nums[0::2], nums[1::2]
    return min(xs), min(ys), max(xs), max(ys)


def picto(pid: str, cx: float, cy: float, h: float, fill: str) -> str:
    """Пиктограмма по центру (cx, cy), высота рисунка без полей — h мм"""
    d = picto_d(pid)
    x0, y0, x1, y1 = bbox(d)
    k = h / (y1 - y0)
    tx = cx - (x0 + x1) / 2 * k
    ty = cy - (y0 + y1) / 2 * k
    return f'<path fill="{fill}" fill-rule="evenodd" transform="translate({num(tx)} {num(ty)}) scale({num(k)})" d="{d}"/>'


WORDMARK = re.search(r' d="([^"]+)"', (BRAND / 'logo-wordmark-white.svg').read_text()).group(1)


def wordmark(x: float, y: float, w: float, fill: str) -> str:
    """Знак «ОЧАКОВО» без квадрата, ширина w мм, верхний левый угол (x, y)"""
    k = w / 196
    return f'<path fill="{fill}" fill-rule="evenodd" transform="translate({num(x)} {num(y)}) scale({num(k)})" d="{WORDMARK}"/>'


def rect(x, y, w, h, fill, rx=0):
    r = f' rx="{num(rx)}"' if rx else ''
    return f'<rect x="{num(x)}" y="{num(y)}" width="{num(w)}" height="{num(h)}"{r} fill="{fill}"/>'


def svg(name: str, w: float, h: float, title: str, desc: str, body: list[str]):
    doc = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{num(w)}mm" height="{num(h)}mm" viewBox="0 0 {num(w)} {num(h)}">'
        f'<title>{title}</title><desc>{desc}</desc>{"".join(body)}</svg>\n'
    )
    (OUT / name).write_text(doc)
    return name


# ── Принты ────────────────────────────────────────────────────────────────


def hoodie_back():
    """Спина худи: надпись с рабочих курток в три строки, под ней линия и название завода"""
    W = 300
    lines = ['Я ДЕЛАЮ', 'НАТУРАЛЬНЫЕ', 'НАПИТКИ']
    size = DISPLAY.fit('НАТУРАЛЬНЫЕ', W)
    cap = DISPLAY.cap * size
    step = cap * 1.17
    body = [text(DISPLAY, s, size, 0, cap + i * step, WHITE) for i, s in enumerate(lines)]
    y = cap + 2 * step + cap * 0.32
    body.append(rect(0, y, W, 1.4, WHITE))
    small = 6.2
    y += 4 + TEXT_BOLD.cap * small
    body.append(text(TEXT_BOLD, 'ОЧАКОВО', small, 0, y, WHITE, tracking=1.1))
    return svg('hoodie-back.svg', W, y + 1, 'Худи, спина', 'Шелкография белым на чёрном, поле 300 мм, верх — 120 мм от горловины', body)


def hoodie_neck():
    """Печать внутри горловины: слоган концепции и знак"""
    W = 70
    size = DISPLAY.fit('КВАС ДЕЛАЮТ', W)
    cap = DISPLAY.cap * size
    body = [text(DISPLAY, 'КВАС ДЕЛАЮТ', size, 0, cap, WHITE), text(DISPLAY, 'ЛЮДИ', size, 0, cap * 2.25, WHITE)]
    body.append(wordmark(0, cap * 2.25 + 4, 26, WHITE))
    return svg('hoodie-neck.svg', W, cap * 2.25 + 4 + 26 / 196 * 24, 'Худи, печать внутри горловины', 'Шелкография белым, 70 мм', body)


DEPARTMENTS = [
    ('lab', 'control', 'Лаборатория'),
    ('bottling', 'pet-bottle', 'Цех розлива'),
    ('brewing', 'kettle', 'Технологический цех'),
    ('warehouse', 'warehouse', 'Склад'),
]


def chest():
    """Грудь худи: пиктограмма своего отдела, вышивка красным, высота рисунка 55 мм"""
    for dept, pid, title in DEPARTMENTS:
        x0, y0, x1, y1 = bbox(picto_d(pid))
        h = 55
        w = (x1 - x0) / (y1 - y0) * h
        svg(f'chest-{dept}.svg', w, h, f'Худи, грудь: {title}', 'Вышивка красной нитью в тон Pantone 199 C, высота 55 мм', [picto(pid, w / 2, h / 2, h, RED)])


def warehouse_picto():
    """Пиктограмма склада отдельным файлом — в сетке 48 × 48, как фирменные"""
    svg('picto-warehouse.svg', 48, 48, 'Склад и отгрузка', 'Нарисована командой по сетке брендбука: 48 × 48, линия 1,23. Нужно согласовать с «Очаково»',
        [f'<path fill="{RED}" fill-rule="evenodd" d="{WAREHOUSE_D}"/>'])


def longsleeve():
    """Лонгслив: «2/2» во весь перед, график 2/2 из «Описания практики»; под воротником сзади — знак"""
    W = 400
    size = DISPLAY.fit('2/2', W)
    cap = DISPLAY.cap * size
    svg('longsleeve-front.svg', W, cap + 1, 'Лонгслив, перед', 'Шелкография красным Pantone 199 C, ширина 400 мм, верх — 90 мм от горловины', [text(DISPLAY, '2/2', size, 0, cap, RED)])

    svg('longsleeve-nape.svg', 60, 60 / 196 * 24, 'Лонгслив, сзади под воротником', 'Шелкография красным, ширина 60 мм', [wordmark(0, 0, 60, RED)])


def arrow(x0, y, x1, color, t=1.6):
    head = 4.2
    return rect(x0, y - t / 2, x1 - x0 - head, t, color) + (
        f'<path fill="{color}" d="M{num(x1)} {num(y)}L{num(x1 - head * 1.4)} {num(y - head)}V{num(y + head)}Z"/>'
    )


def tee():
    """Футболка амбассадора: двойное брожение кваса — схема из «Пути кваса»"""
    W = 280
    size = DISPLAY.fit('БРОЖЕНИЕ', W)
    cap = DISPLAY.cap * size
    pad = accent('ДВОЙНОЕ', size)
    body = [text(DISPLAY, 'ДВОЙНОЕ', size, 0, pad + cap, INK), text(DISPLAY, 'БРОЖЕНИЕ', size, 0, pad + cap * 2.18, RED)]
    top = pad + cap * 2.18 + 24
    steps = [('barley', 'СОЛОД'), ('kettle', 'ВАРКА'), ('cct', 'БРОЖЕНИЕ'), ('pet-bottle', 'РОЗЛИВ')]
    cell = W / 4
    ph = 46
    for i, (pid, label) in enumerate(steps):
        cx = cell * i + cell / 2
        body.append(picto(pid, cx, top + ph / 2, ph, RED))
        body.append(text(TEXT_BOLD, label, 6.4, cx, top + ph + 13, INK, tracking=0.9, anchor='middle'))
        if i < 3:
            body.append(arrow(cx + 20, top + ph / 2, cx + cell - 20, INK, t=1.8))
    # Скобка под брожением: две ветки, у правого края места меньше — подписи прижаты к схеме
    bx = cell * 2 + cell / 2
    yb = top + ph + 21
    body.append(rect(bx - 0.9, yb, 1.8, 8, RED))
    body.append(rect(bx - 50, yb + 8, 100, 1.8, RED))
    body.append(rect(bx - 50, yb + 8, 1.8, 7, RED))
    body.append(rect(bx + 48.2, yb + 8, 1.8, 7, RED))
    body.append(text(TEXT_BOLD, 'МОЛОЧНОКИСЛОЕ', 6.4, bx - 49, yb + 25, RED, tracking=0.6, anchor='middle'))
    body.append(text(TEXT_BOLD, 'ДРОЖЖЕВОЕ', 6.4, min(bx + 49, W - TEXT_BOLD.width('ДРОЖЖЕВОЕ', 6.4, 0.6) / 2), yb + 25, RED, tracking=0.6, anchor='middle'))
    y = yb + 44
    body.append(wordmark(0, y, 46, INK))
    return svg('tee-fermentation.svg', W, y + 46 / 196 * 24 + 1, 'Футболка амбассадора, грудь', 'Шелкография в два цвета на белой футболке: красный Pantone 199 C и тёмно-серый Cool Gray 10, ширина 280 мм', body)


def tote():
    """Шоппер «Состав смены»: как состав на этикетке, только про людей"""
    W = 280
    size = DISPLAY.fit('СОСТАВ СМЕНЫ', W)
    cap = DISPLAY.cap * size
    body = [text(DISPLAY, 'СОСТАВ СМЕНЫ', size, 0, cap, RED)]
    y = cap + 9
    body += [rect(0, y, W, 1.6, INK), rect(0, y + 3.2, W, 0.6, INK)]
    rows = [('Наставник', '1'), ('Новичок', '1'), ('Пульт линии', '1'), ('Смена', '12 часов'), ('Напитки', 'натуральные')]
    fs = 10.5
    y += 8
    for label, value in rows:
        y += 17
        body.append(text(TEXT_BOLD, label, fs, 0, y, INK))
        body.append(text(TEXT_BOLD, value, fs, W, y, INK, anchor='end'))
        x0 = TEXT_BOLD.width(label, fs) + 4
        x1 = W - TEXT_BOLD.width(value, fs) - 4
        dots = ''.join(f'<circle cx="{num(x)}" cy="{num(y - 0.6)}" r="0.75"/>' for x in frange(x0, x1, 3.2))
        body.append(f'<g fill="{INK}">{dots}</g>')
    y += 12
    body.append(rect(0, y, W, 0.6, INK))
    y += 18
    body.append(text(TEXT_BOLD, 'Квас делают люди', 10.5, 0, y, RED))
    y += 22
    for i, pid in enumerate(['barley', 'kettle', 'cct', 'control', 'pet-bottle', 'warehouse']):
        body.append(picto(pid, 15 + i * 30, y + 12, 24, RED))
    y += 40
    body.append(wordmark(0, y, 62, INK))
    return svg('tote-sostav.svg', W, y + 62 / 196 * 24 + 1, 'Шоппер «Состав смены»', 'Шелкография в два цвета на небелёном хлопке: красный Pantone 199 C и тёмно-серый Cool Gray 10, ширина 280 мм', body)


def frange(a, b, step):
    x = a
    while x <= b:
        yield x
        x += step


# Значки и наклейки — одна коллекция из шести: четыре отдела, колос за контрольные вопросы на экскурсии, «1978» — в музее
COLLECTION = [('lab', 'control'), ('bottling', 'pet-bottle'), ('brewing', 'kettle'), ('warehouse', 'warehouse'), ('excursion', 'barley'), ('museum', '1978')]


def badge(cx, cy, r, pid, bg, fg):
    out = [f'<circle cx="{num(cx)}" cy="{num(cy)}" r="{num(r)}" fill="{bg}"/>']
    if pid == '1978':
        size = DISPLAY.fit('1978', r * 1.25)
        out.append(text(DISPLAY, '1978', size, cx, cy + DISPLAY.cap * size / 2, fg, anchor='middle'))
    else:
        out.append(picto(pid, cx, cy, r * 1.25, fg))
    return ''.join(out)


def pins():
    """Значки: круг 25 мм, кант и рисунок — никель, поле — красная эмаль"""
    d, gap = 25, 6
    body = []
    for i, (_, pid) in enumerate(COLLECTION):
        cx = d / 2 + i * (d + gap) + 1
        body.append(f'<circle cx="{num(cx)}" cy="{num(d / 2 + 1)}" r="{num(d / 2)}" fill="{NICKEL}"/>')
        body.append(badge(cx, d / 2 + 1, d / 2 - 1.1, pid, RED, NICKEL))
    return svg('pins.svg', 6 * d + 5 * gap + 2, d + 2, 'Значки, коллекция из шести', 'Мягкая эмаль: красная Pantone 199 C, кант и рисунок — никель; диаметр 25 мм, застёжка «бабочка»', body)


def stickers():
    """Лист наклеек A6: круги 44 мм, контур высечки CutContour"""
    W, H, dd = 105, 148, 44
    body = []
    for i, (_, pid) in enumerate(COLLECTION):
        col, row = i % 2, i // 2
        cx = 7 + dd / 2 + col * (dd + 3)
        cy = 7 + dd / 2 + row * (dd + 2.5)
        body.append(f'<circle cx="{num(cx)}" cy="{num(cy)}" r="{num(dd / 2)}" fill="{WHITE}"/>')
        body.append(badge(cx, cy, dd / 2 - 3, pid, WHITE, RED) if pid != '1978' else badge(cx, cy, dd / 2 - 3, pid, RED, WHITE))
        body.append(f'<circle cx="{num(cx)}" cy="{num(cy)}" r="{num(dd / 2)}" fill="none" stroke="{CUT}" stroke-width="0.25"><title>CutContour</title></circle>')
    return svg('stickers.svg', W, H, 'Наклейки, лист A6', 'Цифровая печать на белой виниловой плёнке, ламинат матовый, высечка по контуру CutContour (#FF00FF, не печатается)', body)


def patch():
    """Нашивка «Наставник»: красная, оверлок тёмно-красный"""
    W, H = 110, 45
    body = [rect(0, 0, W, H, RED_DARK, rx=6), rect(2, 2, W - 4, H - 4, RED, rx=4.5)]
    size = DISPLAY.fit('НАСТАВНИК', 86)
    cap = DISPLAY.cap * size
    body.append(text(DISPLAY, 'НАСТАВНИК', size, W / 2, 9 + cap, WHITE, anchor='middle'))
    body.append(wordmark(W / 2 - 18, 9 + cap + 5.5, 36, WHITE))
    return svg('patch-mentor.svg', W, H, 'Нашивка «Наставник»', 'Вышитая нашивка на липучке или для пришивания, 110 × 45 мм, оверлок тёмно-красный', body)


def lanyard():
    """Лента для пропуска: раппорт 225 мм на ленте 20 мм — знак и пиктограммы отделов"""
    W, H = 225, 20
    body = [rect(0, 0, W, H, RED), wordmark(8, (H - 7) / 2, 58, WHITE)]
    for i, pid in enumerate(['control', 'pet-bottle', 'kettle', 'warehouse', 'barley']):
        body.append(picto(pid, 86 + i * 30, H / 2, 12, WHITE))
    return svg('lanyard.svg', W, H, 'Лента для пропуска, раппорт', 'Сублимация на ленте 20 мм, длина 900 мм — четыре раппорта, карабин и чехол в комплекте', body)


# ── Носки: жаккард ────────────────────────────────────────────────────────

KNIT = 24  # петель на рисунок по высоте


def raster(pid: str) -> list[str]:
    """Пиктограмма в сетку петель KNIT × KNIT через sharp: строки из «#» и «.»"""
    d = picto_d(pid)
    x0, y0, x1, y1 = bbox(d)
    side = max(x1 - x0, y1 - y0)
    vb = f'{num((x0 + x1) / 2 - side / 2)} {num((y0 + y1) / 2 - side / 2)} {num(side)} {num(side)}'
    src = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" width="240" height="240"><path fill="#000" fill-rule="evenodd" d="{d}"/></svg>'
    js = (
        "const sharp=require('sharp');let s='';process.stdin.on('data',c=>s+=c).on('end',async()=>{"
        f"const {{data}}=await sharp(Buffer.from(s)).flatten({{background:'#fff'}}).resize({KNIT},{KNIT},{{kernel:'lanczos3'}}).greyscale().raw().toBuffer({{resolveWithObject:true}});"
        f"const rows=[];for(let y=0;y<{KNIT};y++){{let r='';for(let x=0;x<{KNIT};x++)r+=data[y*{KNIT}+x]<170?'#':'.';rows.push(r)}}console.log(JSON.stringify(rows))}})"
    )
    out = subprocess.run(['node', '-e', js], input=src, capture_output=True, text=True, cwd=ROOT, check=True)
    return json.loads(out.stdout)


def socks():
    """Раппорт жаккарда 64 × 64 петли: четыре пиктограммы со сдвигом, красным по чёрному. Петля на макете — 1,25 мм"""
    grid = [['.'] * 64 for _ in range(64)]
    for (pid, gx, gy) in [('kettle', 4, 4), ('pet-bottle', 36, 4), ('barley', 20, 36), ('cct', 52, 36)]:
        for y, row in enumerate(raster(pid)):
            for x, c in enumerate(row):
                if c == '#':
                    grid[(gy + y) % 64][(gx + x) % 64] = '#'
    p = 1.25
    body = [rect(0, 0, 64 * p, 64 * p, '#141414')]
    runs = []
    for y, row in enumerate(grid):
        x = 0
        while x < 64:
            if row[x] == '#':
                x0 = x
                while x < 64 and row[x] == '#':
                    x += 1
                runs.append(f'M{num(x0 * p)} {num(y * p)}h{num((x - x0) * p)}v{num(p)}h{num(-(x - x0) * p)}Z')
            else:
                x += 1
    body.append(f'<path fill="{RED}" d="{"".join(runs)}"/>')
    (OUT / 'socks-grid.txt').write_text('\n'.join(''.join(r) for r in grid) + '\n')
    return svg('socks.svg', 64 * p, 64 * p, 'Носки, раппорт жаккарда', 'Жаккард в два цвета: чёрный фон, красная нить в тон Pantone 199 C; 64 × 64 петли, сетка — socks-grid.txt', body)


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    warehouse_picto()
    hoodie_back()
    hoodie_neck()
    chest()
    longsleeve()
    tee()
    tote()
    pins()
    stickers()
    patch()
    lanyard()
    socks()
    for f in sorted(OUT.iterdir()):
        print(f'{f.relative_to(ROOT)}  {f.stat().st_size // 1024} КБ')
