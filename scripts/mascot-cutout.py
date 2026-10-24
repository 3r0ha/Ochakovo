"""
Квасыч: убрать белый фон и обрезать по фигуре.

Исходники из нейросети (JPEG на белом) лежат в archive/mascot-src, результат: public/mascot/<имя>.webp с прозрачным фоном.
Фон заливается от краёв кадра, поэтому белое внутри фигуры (глаза, карта, каска, лица на мемах) остаётся.
Края мягкие: на границе с фоном белый переводится в прозрачность, как «цвет в альфу» в GIMP.
У мемов линии нарисованы штрихом с разрывами, поэтому перед заливкой разрывы закрываются.

  python3 scripts/mascot-cutout.py [имя ...]
"""
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from scipy import ndimage

SRC = Path('archive/mascot-src')
OUT = Path('public/mascot')
PAD = 12  # запас вокруг фигуры, px
LIGHT = 200  # светлее этого (по самому тёмному каналу) пиксель может быть фоном
# Фон, со всех сторон закрытый контуром: между рукой и телом, у стойки пульта. Заливка от краёв туда не доходит,
# а правилом «чисто-белое внутри» не отличить от этикетки на бутылке или каски, поэтому точки отмечены по каждой позе
HOLES = {
    'kvasych-clock': [(568, 360)],
    'kvasych-money': [(575, 351)],
    'kvasych-oops': [(804, 189), (602, 198)],
    'kvasych-think': [(614, 224), (825, 374)],
    'kvasych-mentor': [(586, 535), (738, 634)],
}


def cutout(path: Path) -> Image.Image:
    rgb = np.asarray(Image.open(path).convert('RGB')).astype(np.float32)
    light = rgb.min(axis=2) > LIGHT
    sketch = path.stem.startswith('kvasych-meme')
    # Барьер: всё тёмное. У мемов утолщаем линии, чтобы заливка не протекла в лицо через разрывы штриха
    wall = ~light
    if sketch:
        wall = ndimage.binary_dilation(wall, iterations=3)
    labels, _ = ndimage.label(~wall)
    edge = np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
    bg = np.isin(labels, edge[edge > 0])
    holes = [labels[y, x] for x, y in HOLES.get(path.stem, []) if labels[y, x] > 0]
    bg |= np.isin(labels, holes)
    if sketch:
        # Возвращаем полосу, съеденную утолщением, но только по светлым пикселям и не глубже 4 px
        for _ in range(4):
            bg |= ndimage.binary_dilation(bg) & light
    # Цвет в альфу относительно белого: альфа = насколько пиксель темнее белого по самому тёмному каналу
    a = np.clip((255 - rgb.min(axis=2)) / (255 - LIGHT * 0.6), 0, 1)
    a[rgb.min(axis=2) > 246] = 0
    alpha = np.where(bg, a, 1.0)
    # Цвет на полупрозрачной кромке: убираем подмешанный белый
    safe = np.maximum(alpha, 1e-3)[..., None]
    col = np.where(bg[..., None] & (alpha[..., None] > 0), (rgb - 255 * (1 - safe)) / safe, rgb)
    col = np.clip(col, 0, 255)
    # Мелкий мусор JPEG по фону: одиночные точки с малой альфой
    alpha[(alpha < 0.12) & bg] = 0
    out = np.dstack([col, alpha * 255]).astype(np.uint8)
    ys, xs = np.nonzero(alpha > 0.05)
    y0, y1 = max(ys.min() - PAD, 0), min(ys.max() + PAD + 1, out.shape[0])
    x0, x1 = max(xs.min() - PAD, 0), min(xs.max() + PAD + 1, out.shape[1])
    return Image.fromarray(out[y0:y1, x0:x1], 'RGBA')


def main() -> None:
    names = sys.argv[1:] or sorted(p.stem for p in SRC.glob('kvasych-*.jpg'))
    for name in names:
        img = cutout(SRC / f'{name}.jpg')
        dst = OUT / f'{name}.webp'
        img.save(dst, 'WEBP', quality=90, alpha_quality=100, method=6)
        print(f'{dst}  {img.width}×{img.height}  {dst.stat().st_size // 1024} КБ')


if __name__ == '__main__':
    main()
