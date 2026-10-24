"""Крошечные шрифты для редких знаков интерфейса.

1. Подмножества Onest. Без них браузер ради одного «₽», стрелки или «≈» скачивает целые наборы latin-ext,
   symbols и math (по 18–28 КБ). Из каждого набора вырезаются только нужные знаки, вариативная ось wght сохраняется.

2. Дополнение к Sofia Sans Extra Condensed — знаки ₽, ← и → начертаний 800 и 900. В Sofia Sans их нет, и в крупных
   цифрах (сумма первого экрана, «≈ … ₽», стрелка финала) браузер брал широкий знак из чужого шрифта.
   ₽ — буква «Р» того же начертания (составной глиф разобран на контуры) с перекладиной толщиной горизонтального
   штриха: она врезана в контур ножки, без наложения контуров. Стрелки — контуры Onest, сжатые до высоты цифр;
   толщина древка равна горизонтальному штриху Sofia, ширина плеч — вертикальному. Свои имена в таблице name,
   лицензия OFL — src/fonts/OFL.txt.

Подключение — src/fonts.css. Запуск: python3 scripts/fonts-subset.py  (нужен fonttools с brotli: pip install fonttools brotli)
"""
from pathlib import Path

from fontTools import subset
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.recordingPen import DecomposingRecordingPen, RecordingPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = Path(__file__).resolve().parent.parent
ONEST = ROOT / 'node_modules/@fontsource-variable/onest/files'
SOFIA = ROOT / 'node_modules/@fontsource-variable/sofia-sans-extra-condensed/files'
OUT = ROOT / 'src/fonts'

# ── 1. Подмножества Onest ────────────────────────────────────────────────

# имя файла → (исходный набор, коды знаков)
PARTS = {
    'onest-ruble-wght.woff2': ('onest-latin-ext-wght-normal.woff2', [0x20BD]),  # ₽
    'onest-arrows-wght.woff2': ('onest-symbols-wght-normal.woff2', [0x2190, 0x2192]),  # ← →
    'onest-approx-wght.woff2': ('onest-math-wght-normal.woff2', [0x2248]),  # ≈
}

OUT.mkdir(parents=True, exist_ok=True)
for name, (source, codes) in PARTS.items():
    font = TTFont(ONEST / source)
    missing = [hex(c) for c in codes if c not in font.getBestCmap()]
    if missing:
        raise SystemExit(f'{source}: нет знаков {missing}')
    options = subset.Options()
    options.flavor = 'woff2'
    options.layout_features = ['*']
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=codes)
    subsetter.subset(font)
    font.flavor = 'woff2'
    font.save(OUT / name)
    print(f'{name}: {(OUT / name).stat().st_size} байт')

# ── 2. ₽ и стрелки для Sofia Sans Extra Condensed ────────────────────────

FAMILY = 'Ochakovo Display Signs'
SIGNS = {0x20BD: 'ruble', 0x2190: 'arrowleft', 0x2192: 'arrowright'}
# Пропорции ₽ по образцу Onest: зазор между чашей и перекладиной — 4 % высоты прописной (у жирной Sofia чаша ниже),
# перекладина выступает влево от ножки на половину её ширины, вправо — на 56 % вылета чаши
GAP, LEFT, RIGHT = 0.04, 0.5, 0.56
CAP = 655  # высота прописных и цифр Sofia Sans


def instance(path: Path, wght: float) -> TTFont:
    return instancer.instantiateVariableFont(TTFont(path), {'wght': wght})


def outline(font: TTFont, glyph: str) -> list:
    gs = font.getGlyphSet()
    pen = DecomposingRecordingPen(gs)
    gs[glyph].draw(pen)
    return pen.value


def bounds(value: list) -> tuple:
    pen = BoundsPen(None)
    for op, args in value:
        getattr(pen, op)(*args)
    return pen.bounds


def stroke(value: list) -> float:
    """Толщина горизонтального штриха «Р»: от верха чаши до верха её просвета"""
    counter = [pt for op, args in value[value.index(('closePath', ())) + 1 :] for pt in args]
    return CAP - max(y for _, y in counter)


def ruble(sofia_cyr: TTFont) -> tuple[list, int, float, float]:
    """«Р» с перекладиной: контур ножки получает выступы, отдельного контура поверх нет"""
    er = outline(sofia_cyr, 'uni0420')
    adv, lsb = sofia_cyr['hmtx']['uni0420']
    t = stroke(er)
    split = er.index(('closePath', ())) + 1
    pts = [pt for _, args in er[:split] for pt in args]
    counter = [pt for _, args in er[split:] for pt in args]
    stem_l = min(x for x, _ in pts)
    # Правый край ножки — левый край просвета чаши; низ чаши — точка, где чаша сходится с ножкой
    stem_r = min(x for x, _ in counter)
    bowl_bottom = max(y for x, y in pts if abs(x - stem_r) < 0.5 and 20 < y < min(cy for _, cy in counter) - 1)
    bowl_r = max(x for x, _ in pts)
    top = bowl_bottom - GAP * CAP
    bottom = top - t
    shift = LEFT * (stem_r - stem_l)
    right = stem_r + RIGHT * (bowl_r - stem_r)

    out, prev = [], None
    for op, args in er:
        args = tuple((x + shift, y) for x, y in args)
        if op == 'lineTo' and prev is not None:
            (x0, y0), (x1, y1) = prev, args[0]
            if abs(x0 - x1) < 0.5 and abs(x0 - (stem_l + shift)) < 0.5 and y0 < bottom and y1 > top:
                # Вверх по левому краю ножки: выступ влево
                x = x0
                out += [('lineTo', ((x, bottom),)), ('lineTo', ((x - shift, bottom),)), ('lineTo', ((x - shift, top),)), ('lineTo', ((x, top),))]
            elif abs(x0 - x1) < 0.5 and abs(x0 - (stem_r + shift)) < 0.5 and y0 > top and y1 < bottom:
                # Вниз по правому краю ножки: выступ вправо
                x = x0
                out += [('lineTo', ((x, top),)), ('lineTo', ((right + shift, top),)), ('lineTo', ((right + shift, bottom),)), ('lineTo', ((x, bottom),))]
        out.append((op, args))
        if args:
            prev = args[-1]
    return out, round(adv + shift), t, stem_r - stem_l


def arrow(onest_sym: TTFont, cp: int, stem: float) -> tuple[list, int, float]:
    """Стрелка Onest: по вертикали — до высоты цифр, по горизонтали сжата так, что плечо толщиной с ножку цифры"""
    glyph = onest_sym.getBestCmap()[cp]
    value = outline(onest_sym, glyph)
    x0, y0, x1, y1 = bounds(value)
    sy = CAP / (y1 - y0)
    pts = [pt for _, args in value for pt in args]
    ys = sorted({round(y, 1) for _, y in pts})
    shaft = [y for y in ys if y0 + 1 < y < y1 - 1 and any(abs(px - x0) < 1 or abs(px - x1) < 1 for px, py in pts if round(py, 1) == y)]
    shaft_t = max(shaft) - min(shaft) if len(shaft) >= 2 else 0
    # Плечо: горизонтальная толщина на середине между низом стрелки и низом древка
    ymid = (y0 + min(shaft)) / 2
    xs = []
    for i, (px, py) in enumerate(pts):
        qx, qy = pts[(i + 1) % len(pts)]
        if (py - ymid) * (qy - ymid) < 0:
            xs.append(px + (ymid - py) * (qx - px) / (qy - py))
    arm = max(xs) - min(xs) if len(xs) >= 2 else 1
    sx = stem / arm
    side = 30
    pen = RecordingPen()
    tp = TransformPen(pen, (sx, 0, 0, sy, side - x0 * sx, -y0 * sy))
    for op, args in value:
        getattr(tp, op)(*args)
    return pen.value, round((x1 - x0) * sx + 2 * side), shaft_t * sy


def onest_weight_for(t: float) -> float:
    """Начертание Onest, у которого древко стрелки после приведения к высоте цифр равно штриху Sofia"""
    lo, hi = 300.0, 900.0
    for _ in range(14):
        mid = (lo + hi) / 2
        sym = instance(ONEST / 'onest-symbols-wght-normal.woff2', mid)
        _, _, got = arrow(sym, 0x2192, 100)
        lo, hi = (mid, hi) if got < t else (lo, mid)
    return round((lo + hi) / 2)


def build(wght: int):
    cyr = instance(SOFIA / 'sofia-sans-extra-condensed-cyrillic-wght-normal.woff2', wght)
    base = instance(SOFIA / 'sofia-sans-extra-condensed-latin-wght-normal.woff2', wght)
    rub, rub_adv, t, stem = ruble(cyr)
    onest_w = onest_weight_for(t)
    sym = instance(ONEST / 'onest-symbols-wght-normal.woff2', onest_w)

    glyphs = {'ruble': (rub, rub_adv)}
    for cp in (0x2190, 0x2192):
        value, adv, _ = arrow(sym, cp, stem)
        glyphs[SIGNS[cp]] = (value, adv)

    glyf, hmtx = base['glyf'], base['hmtx']
    for name, (value, adv) in glyphs.items():
        pen = TTGlyphPen(None)
        for op, args in value:
            getattr(pen, op)(*args)
        g = pen.glyph()
        g.recalcBounds(glyf)
        glyf[name] = g
        hmtx[name] = (adv, g.xMin if g.numberOfContours else 0)
    order = base.getGlyphOrder()
    base.setGlyphOrder(order + [n for n in glyphs if n not in order])
    for table in base['cmap'].tables:
        if table.isUnicode():
            for cp, name in SIGNS.items():
                table.cmap[cp] = name

    style = 'ExtraBold' if wght == 800 else 'Black'
    names = {
        # Уведомления об авторских правах — из самих исходных шрифтов, как требует OFL
        0: f"{base['name'].getDebugName(0)} Arrows: {sym['name'].getDebugName(0)} Modified: ruble sign and arrows for the Ochakovo season site.",
        1: FAMILY,
        2: 'Regular',
        3: f'{FAMILY} {style}',
        4: f'{FAMILY} {style}',
        6: f'OchakovoDisplaySigns-{style}',
        13: 'This Font Software is licensed under the SIL Open Font License, Version 1.1.',
        14: 'https://openfontlicense.org',
        16: FAMILY,
        17: style,
    }
    name_table = base['name']
    name_table.names = [n for n in name_table.names if n.nameID not in names and n.nameID < 256]
    for nid, text in names.items():
        name_table.setName(text, nid, 3, 1, 0x409)
    base['OS/2'].usWeightClass = wght

    options = subset.Options()
    options.flavor = 'woff2'
    options.layout_features = []
    options.name_IDs = list(names)
    options.notdef_outline = False
    options.hinting = False
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=list(SIGNS))
    subsetter.subset(base)
    base.flavor = 'woff2'
    path = OUT / f'display-signs-{wght}.woff2'
    base.save(path)
    print(f'{path.name}: {path.stat().st_size} байт; штрих {t:.1f}, ножка {stem:.1f}, стрелка из Onest {onest_w}')


for w in (800, 900):
    build(w)

# ── 3. Латиница: ядро для страниц на русском ─────────────────────────────
# Из латинского набора fontsource страницам на русском нужны ASCII (цифры, знаки, названия брендов), неразрывный пробел,
# «ёлочки», точка-разделитель, знак умножения, тире, кавычки и невидимые знаки типографа. Ядро — свой маленький файл
# с осью wght и всеми возможностями OpenType (tnum для цифр). Остальная латиница (буквы с диакритикой и т. п.) остаётся
# прежним файлом fontsource под своим @font-face в src/fonts.css: браузер скачает его, только если такой знак встретится.
# Диапазоны ядра и остатка в src/fonts.css не пересекаются — тест w2-home-fonts сверяет их с LATIN_CORE

LATIN_CORE = [
    *range(0x20, 0x7F),
    0xA0, 0xA9, 0xAB, 0xAD, 0xB0, 0xB7, 0xBB, 0xD7,
    0x2009, 0x200A, 0x200B, 0x200D,
    *range(0x2010, 0x2016),
    *range(0x2018, 0x201F),
    0x2022, 0x2026, 0x202F, 0x2060, 0x2212,
]
CORE = {
    'onest-latin-core-wght.woff2': ONEST / 'onest-latin-wght-normal.woff2',
    'sofia-latin-core-wght.woff2': SOFIA / 'sofia-sans-extra-condensed-latin-wght-normal.woff2',
}
for name, source in CORE.items():
    font = TTFont(source)
    options = subset.Options()
    options.flavor = 'woff2'
    # Возможности, которыми сайт пользуется: кернинг и знаки, лигатуры и контекстные формы, цифры tnum и pnum.
    # Дроби (frac, numr, dnom) на страницах не встречаются — без них Sofia легче на 2 КБ
    options.layout_features = ['kern', 'mark', 'mkmk', 'liga', 'calt', 'ccmp', 'locl', 'tnum', 'pnum']
    options.name_IDs = ['*']
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=LATIN_CORE)
    subsetter.subset(font)
    font.flavor = 'woff2'
    font.save(OUT / name)
    print(f'{name}: {(OUT / name).stat().st_size} байт из {source.stat().st_size}')

# Лицензия рядом со шрифтами: уведомления авторов и текст OFL — дословно из пакетов fontsource
sofia_license = (SOFIA.parent / 'LICENSE').read_text()
onest_license = (ONEST.parent / 'LICENSE').read_text()
body = sofia_license[sofia_license.index('This Font Software is licensed') :]
notices = [line for text in (sofia_license, onest_license) for line in text.splitlines()[:1]]
(OUT / 'OFL.txt').write_text(
    'Шрифты этой папки собирает scripts/fonts-subset.py из шрифтов под лицензией SIL Open Font License 1.1.\n'
    'onest-*.woff2 — подмножества Onest, sofia-latin-core-wght.woff2 — подмножество Sofia Sans Extra Condensed.\n'
    'display-signs-*.woff2 (Ochakovo Display Signs) — знак ₽ из буквы «Р»\n'
    'Sofia Sans Extra Condensed и стрелки из Onest, изменены для сайта «Сезон в «Очаково»».\n\n'
    + '\n'.join(notices)
    + '\n\n'
    + body
)
print('OFL.txt записан')
