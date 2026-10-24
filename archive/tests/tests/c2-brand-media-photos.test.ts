// Фото сайта: в сборку попадает только используемое, архивный кадр 1996 года — без пивной подставки и кружки,
// в public нет служебных файлов (.DS_Store). Фото готовит node scripts/photos.mjs. Запуск: pnpm test c2-brand-media-photos

import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = fileURLToPath(new URL('../../', import.meta.url))
const read = (p: string) => readFileSync(join(root, p), 'utf8')
const photos = JSON.parse(read('shared/photos.json')) as Record<string, { w: number; h: number; widths: number[]; lqip: string }>

function walk(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((f) => {
    const p = `${dir}/${f}`
    return statSync(join(root, p)).isDirectory() ? walk(p) : [p]
  })
}

test('в public и photos-src нет служебных файлов: сервер отдал бы их как есть', () => {
  for (const dir of ['public', 'photos-src']) {
    const hidden = walk(dir).filter((p) => p.split('/').some((part) => part.startsWith('.')))
    assert.deepEqual(hidden, [], `${dir}: ${hidden.join(', ')}`)
  }
})

test('public/photos — ровно то, что в манифесте: по AVIF и WebP на каждую ширину', () => {
  const expected = Object.entries(photos).flatMap(([name, p]) => p.widths.flatMap((w) => [`${name}-${w}.avif`, `${name}-${w}.webp`]))
  assert.deepEqual(readdirSync(join(root, 'public/photos')).sort(), expected.sort())
  // Исходник на каждое фото и ни одного лишнего
  assert.deepEqual(
    readdirSync(join(root, 'photos-src'))
      .map((f) => f.replace(/\.[a-z]+$/, ''))
      .sort(),
    Object.keys(photos).sort(),
  )
})

test('каждое фото используется на сайте или в боте; лишних больше нет', () => {
  const code = ['src', 'shared', 'server']
    .flatMap((d) => walk(d))
    .filter((p) => /\.(tsx?|css)$/.test(p) && !p.endsWith('photos.json'))
    .map(read)
    .join('\n')
  for (const name of Object.keys(photos)) assert.ok(new RegExp(`['"\`/]${name}(['"\`-])`).test(code), `фото ${name} нигде не используется`)
  for (const gone of ['archive-1988', 'archive-1997', 'izba', 'silos']) assert.ok(!(gone in photos), `${gone} убрано из сборки`)
})

test('архив 1996: кадр без подставки с кружкой пива', async () => {
  const src = read('scripts/photos.mjs')
  const crop = src.match(/'archive-1996': \{ left: (\d+), top: (\d+), width: (\d+), height: (\d+) \}/)
  assert.ok(crop, 'кадрирование задано в scripts/photos.mjs')
  const [left, top, width, height] = crop.slice(1).map(Number)
  // Подставка на исходнике (480×480) начинается с 312-й строки и 107-го столбца, тарелка справа — с 425-го столбца
  assert.ok(top + height <= 312, 'низ кадра выше подставки')
  assert.ok(left + width <= 425, 'без тарелки справа')
  assert.deepEqual({ w: photos['archive-1996'].w, h: photos['archive-1996'].h }, { w: width, h: height })
  for (const w of photos['archive-1996'].widths) {
    const meta = await sharp(join(root, `public/photos/archive-1996-${w}.webp`)).metadata()
    assert.deepEqual([meta.width, meta.height], [width, height])
  }
})
