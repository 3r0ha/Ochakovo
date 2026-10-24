"""
Стикерпак Квасыча для Telegram.

Берёт позы из public/mascot (фон уже убран scripts/mascot-cutout.py) и подписи из docs/kvasych.md, раздел «Стикерпак».
Каждый стикер: поза, красная плашка с подписью шрифтом заголовков сайта (Sofia Sans Extra Condensed, 900),
белая обводка по контуру, как у вырезанной наклейки, и лёгкая тень, чтобы стикер читался и на светлом фоне чата.

Требования Telegram к статичному стикеру: PNG или WEBP с прозрачным фоном, одна сторона ровно 512 px, до 512 КБ.

  python3 scripts/stickers.py

Результат:
  docs/brand/stickers/NN-<поза>.png         файлы для @Stickers, по порядку набора
  docs/brand/stickers/kvasych-stickers.zip  все файлы одним архивом
  docs/brand/stickers/preview/NN-<поза>.webp  превью 256 px для страницы материалов
  docs/brand/img/stickers.webp              обзор набора для презентации и страницы материалов
"""
import tempfile
import zipfile
from pathlib import Path

import cv2
import numpy as np
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
MASCOT = ROOT / 'public/mascot'
FONTS = ROOT / 'docs/brand/print/fonts'
OUT = ROOT / 'docs/brand/stickers'
SHEET = ROOT / 'docs/brand/img/stickers.webp'

# Порядок набора и подписи из docs/kvasych.md
STICKERS = [
    ('hello', 'Привет, смена'),
    ('face', 'Жду на смене'),
    ('thumbs', 'Глаз-алмаз'),
    ('meh', 'Бывает'),
    ('oops', 'Ой, брак'),
    ('inspector', 'Проверим'),
    ('think', 'Дай подумать'),
    ('wow', 'Вот это да'),
    ('money', '12-го и 27-го'),
    ('clock', 'Смена в 8:00'),
    ('mentor', 'Смотри, как надо'),
    ('point', 'Тебе туда'),
    ('peek', 'Я тут'),
    ('phone', 'Пишу'),
    ('lost', 'Где я?'),
]

RED = (213, 0, 50, 255)
S = 1024  # рисуем вдвое крупнее и уменьшаем до 512: края и текст получаются чище
FINAL = 512
EDGE = 20  # белая обводка при S
PAD = 44  # запас под обводку и тень
TILT = -3  # плашка чуть повёрнута, как наклеенная


def fonts(wght: int, size: int):
    """Sofia Sans Extra Condensed: кириллица и латиница лежат в двух файлах сайта, ось wght закрепляем"""
    tmp = Path(tempfile.mkdtemp())
    out = []
    for part in ('cyrillic', 'latin'):
        font = instancer.instantiateVariableFont(TTFont(FONTS / f'sofia-sans-extra-condensed-{part}-wght-normal.woff2'), {'wght': wght})
        font.flavor = None
        path = tmp / f'{part}.ttf'
        font.save(path)
        out.append((ImageFont.truetype(str(path), size), set(font.getBestCmap()), font['OS/2'].sCapHeight / font['head'].unitsPerEm))
    return out


def label(text: str, faces) -> Image.Image:
    """Красная плашка с подписью прописными. Знак берём из того файла шрифта, где он есть"""
    text = text.upper()
    size = faces[0][0].size
    cap = faces[0][2] * size
    runs = []
    for ch in text:
        font = next((f for f, cmap, _ in faces if ord(ch) in cmap), faces[0][0])
        runs.append((ch, font, font.getlength(ch)))
    width = sum(w for _, _, w in runs)
    px, py = round(size * 0.3), round(size * 0.24)
    plate = Image.new('RGBA', (round(width) + 2 * px, round(cap) + 2 * py), (0, 0, 0, 0))
    draw = ImageDraw.Draw(plate)
    draw.rounded_rectangle([0, 0, plate.width - 1, plate.height - 1], radius=round(size * 0.12), fill=RED)
    x = px
    for ch, font, w in runs:
        draw.text((x, py + cap), ch, font=font, fill='white', anchor='ls')
        x += w
    return plate.rotate(TILT, resample=Image.BICUBIC, expand=True)


def sticker(pose: str, text: str, faces) -> Image.Image:
    fig = Image.open(MASCOT / f'kvasych-{pose}.webp').convert('RGBA')
    plate = label(text, faces)
    box = S - 2 * PAD
    if plate.width > box:
        plate = plate.resize((box, round(plate.height * box / plate.width)), Image.LANCZOS)
    # Плашка внизу и заходит на фигуру на 60% своей высоты
    plate_top = S - PAD - plate.height
    fig_bottom = plate_top + round(plate.height * 0.6)
    scale = min(box / fig.width, (fig_bottom - PAD) / fig.height)
    fig = fig.resize((round(fig.width * scale), round(fig.height * scale)), Image.LANCZOS)
    art = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    art.alpha_composite(fig, ((S - fig.width) // 2, fig_bottom - fig.height))
    art.alpha_composite(plate, ((S - plate.width) // 2, plate_top))

    # Обводка: расстояние до фигуры и плашки, сглаженный край
    solid = (np.asarray(art)[..., 3] > 110).astype(np.uint8)
    dist = cv2.distanceTransform(1 - solid, cv2.DIST_L2, 5)
    rim = np.clip(EDGE + 0.5 - dist, 0, 1)
    # Тень под наклейкой, чтобы белая обводка не терялась на светлом фоне чата
    shadow = cv2.GaussianBlur(rim, (0, 0), 7)
    shadow = np.roll(shadow, 5, axis=0) * 0.28

    base = np.zeros((S, S, 4), np.float32)
    base[..., 3] = shadow
    white = rim
    a = white + base[..., 3] * (1 - white)
    rgb = (np.ones(3) * white[..., None] + base[..., :3] * (base[..., 3] * (1 - white))[..., None]) / np.maximum(a, 1e-6)[..., None]
    under = Image.fromarray((np.dstack([rgb, a]) * 255).astype(np.uint8), 'RGBA')
    under.alpha_composite(art)
    return under.resize((FINAL, FINAL), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'preview').mkdir(exist_ok=True)
    for old in [*OUT.glob('*.png'), *(OUT / 'preview').glob('*.webp')]:
        old.unlink()
    faces = fonts(900, 118)
    files = []
    for n, (pose, text) in enumerate(STICKERS, 1):
        img = sticker(pose, text, faces)
        path = OUT / f'{n:02d}-{pose}.png'
        img.save(path, optimize=True)
        assert path.stat().st_size < 512 * 1024, f'{path.name} больше 512 КБ'
        files.append((path, img))
        img.resize((256, 256), Image.LANCZOS).save(OUT / 'preview' / f'{path.stem}.webp', 'WEBP', quality=88, alpha_quality=100, method=6)
        print(f'{path.relative_to(ROOT)}  {path.stat().st_size // 1024} КБ  «{text}»')
    with zipfile.ZipFile(OUT / 'kvasych-stickers.zip', 'w', zipfile.ZIP_DEFLATED) as z:
        for path, _ in files:
            z.write(path, path.name)
    # Обзор набора: пять в ряд, прозрачный фон
    cell, cols = 300, 5
    sheet = Image.new('RGBA', (cell * cols, cell * ((len(files) + cols - 1) // cols)), (0, 0, 0, 0))
    for i, (_, img) in enumerate(files):
        sheet.alpha_composite(img.resize((cell, cell), Image.LANCZOS), ((i % cols) * cell, (i // cols) * cell))
    sheet.save(SHEET, 'WEBP', quality=88, alpha_quality=100, method=6)
    print(f'{SHEET.relative_to(ROOT)}  {SHEET.stat().st_size // 1024} КБ')


if __name__ == '__main__':
    main()
