// Готовит адаптивные фото: photos-src/* → public/photos/<name>-<w>.(avif|webp) + shared/photos.json
// Запуск: node scripts/photos.mjs                — все фото
//         node scripts/photos.mjs archive-1996   — перекодировать только эти (манифест всё равно собирается целиком)
// Файлы в public/photos, которых нет в photos-src, удаляются: в сборку попадает только то, что есть в манифесте.
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const SRC = 'photos-src'
const OUT = 'public/photos'
const WIDTHS = [480, 960, 1600, 2200]

/**
 * Кадрирование исходника до нарезки (left, top, width, height в пикселях исходника).
 * archive-1996 (ochakovo.ru, история): внизу слева на исходном кадре — пивная подставка с бородачом и кружкой пива.
 * Её верх — на 312-й строке, поэтому берём полосу выше, до крышек банок колы (285-я строка), и без размытой тарелки справа
 * (от 425-го столбца): видны квас, «Еруслан» и вода
 */
export const CROPS = {
  'archive-1996': { left: 0, top: 0, width: 424, height: 284 },
}

await mkdir(OUT, { recursive: true })
const only = new Set(process.argv.slice(2))
const files = (await readdir(SRC)).filter((f) => !f.startsWith('.')).sort()
const names = new Set(files.map((f) => path.parse(f).name))
const manifest = {}

for (const file of files) {
  const name = path.parse(file).name
  let input = sharp(path.join(SRC, file)).rotate()
  if (CROPS[name]) input = sharp(await input.extract(CROPS[name]).toBuffer())
  const { width, height } = await input.metadata()
  const widths = WIDTHS.filter((w) => w <= width)
  if (!widths.length || widths.at(-1) < width) widths.push(Math.min(width, 2200))
  const unique = [...new Set(widths)]
  if (!only.size || only.has(name)) {
    for (const w of unique) {
      const resized = input.clone().resize({ width: w })
      await resized.clone().avif({ quality: 52, effort: 6 }).toFile(`${OUT}/${name}-${w}.avif`)
      await resized.clone().webp({ quality: 74, effort: 6 }).toFile(`${OUT}/${name}-${w}.webp`)
    }
    console.log(name, `${width}x${height}`, unique.join(','))
  }
  // Размытая мини-превью прямо в манифест: показывается, пока грузится фото
  const lqip = await input.clone().resize({ width: 24 }).blur(1.2).webp({ quality: 40 }).toBuffer()
  manifest[name] = { w: width, h: height, widths: unique, lqip: `data:image/webp;base64,${lqip.toString('base64')}` }
}

// Лишнее из public/photos: фото, которых больше нет в photos-src, ширины, которых нет в манифесте, служебные файлы
for (const f of await readdir(OUT)) {
  const m = f.match(/^(.+)-(\d+)\.(avif|webp)$/)
  const keep = m && names.has(m[1]) && manifest[m[1]].widths.includes(Number(m[2]))
  if (!keep) {
    await rm(path.join(OUT, f))
    console.log('удалено', f)
  }
}

await writeFile('shared/photos.json', JSON.stringify(manifest, null, 2) + '\n')
