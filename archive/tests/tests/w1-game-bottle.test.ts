// Бутылка «Поймай брак» с этикеткой «КВАС» и фавиконка-силуэт. Отрисовку проверяем через react-dom/server,
// глазами — скриншотами 390 и 1440. Запуск: pnpm test w1-game

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Bottle, BottleShape, KVASS_BOTTOM, KVASS_TOP, LABEL_BOX, type BottleKind } from '../../src/game/Bottle'
import { KVAS_GLYPH, WORDMARK } from '../../src/game/label'

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const render = (kind: BottleKind, extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(Bottle, { kind, tone: 'dark', ...extra }))

test('этикетка: белая полоса, «КВАС» красным контуром шрифта сайта, знак «ОЧАКОВО» из logo-wordmark', () => {
  const html = render('ok')
  // Белая полоса во всю ширину бутылки
  assert.match(html, new RegExp(`<rect x="${LABEL_BOX.x}" y="${LABEL_BOX.y}" width="${LABEL_BOX.width}" height="${LABEL_BOX.height}" fill="var\\(--color-white\\)"`))
  // «КВАС» — тот же контур, что рисует бот
  const bot = read('server/dialog/glyphs.ts').match(/export const KVAS: Glyph = \{[^}]*d: '([^']+)'/)?.[1]
  assert.equal(KVAS_GLYPH.d, bot, 'контур «КВАС» на сайте и в боте один')
  assert.match(html, /data-kvas="" transform="[^"]+" d="M46 0Q34 0[^"]*" fill="var\(--color-brand\)"/)
  // Знак — из public/brand/logo-wordmark-red.svg
  const mark = read('public/brand/logo-wordmark-red.svg').match(/\sd="([^"]+)"/)?.[1]
  assert.equal(WORDMARK.d, mark)
  assert.match(html, /data-wordmark="" class="[^"]*hidden" transform="[^"]+" d="M180\.464 0C/)
  // Старой эмблемы (квадрат с кружком) больше нет
  assert.doesNotMatch(html, /<circle cx="1[47]\.\d"/)
  assert.doesNotMatch(html, /stroke="var\(--color-brand\)"/)
})

test('«КВАС» и знак внутри этикетки, по центру', () => {
  const html = render('ok')
  const nums = (re: RegExp) => html.match(re)!.slice(1).map(Number)
  const [kx, ky, kk] = nums(/data-kvas="" transform="translate\(([\d.]+) ([\d.]+)\) scale\(([\d.]+)\)"/)
  const left = kx + KVAS_GLYPH.minX * kk
  const right = kx + KVAS_GLYPH.maxX * kk
  const top = ky + KVAS_GLYPH.minY * kk
  const [mx, my, mk] = nums(/data-wordmark="" class="[^"]*" transform="translate\(([\d.]+) ([\d.]+)\) scale\(([\d.]+)\)"/)
  const markBottom = my + WORDMARK.height * mk
  const { x, y, width, height } = LABEL_BOX
  assert.ok(left > x && right < x + width, `«КВАС» по ширине: ${left}…${right}`)
  assert.ok(Math.abs(left + right - 2 * 20) < 0.05, 'по центру бутылки')
  assert.ok(top > y && markBottom < y + height, `по высоте: ${top}…${markBottom}`)
  assert.ok(Math.abs(top - y - (y + height - markBottom)) < 0.05, 'поровну сверху и снизу')
  assert.ok(Math.abs(mx + (WORDMARK.width * mk) / 2 - 20) < 0.05, 'знак по центру')
})

test('ниже 70 px остаётся только «КВАС»: знак прячет контейнерный запрос, «КВАС» встаёт в центр', () => {
  const html = render('ok', { className: 'h-16 w-auto' })
  // Размер знает обёртка: контейнер по размеру и пропорция бутылки для вызовов «h-16 w-auto»
  assert.match(html, /^<span class="block aspect-\[2\/5\] \[container-type:size\] h-16 w-auto" aria-hidden="true"><svg viewBox="0 0 40 100"/)
  // В разметке «<» экранирован
  assert.match(html, /data-wordmark="" class="\[@container_\(height&lt;70px\)_or_\(width&lt;28px\)\]:hidden"/)
  assert.match(html, /class="\[@container_\(height&lt;70px\)_or_\(width&lt;28px\)\]:translate-y-\(--kvas-shift\)" style="--kvas-shift:([\d.]+)px"/)
  const shift = Number(html.match(/--kvas-shift:([\d.]+)px/)![1])
  const kk = Number(html.match(/data-kvas="" transform="[^"]*scale\(([\d.]+)\)"/)![1])
  const kvasH = (KVAS_GLYPH.maxY - KVAS_GLYPH.minY) * kk
  const ky = Number(html.match(/data-kvas="" transform="translate\([\d.]+ ([\d.]+)\)/)![1])
  const top = ky + KVAS_GLYPH.minY * kk + shift
  assert.ok(Math.abs(top - LABEL_BOX.y - (LABEL_BOX.y + LABEL_BOX.height - (top + kvasH))) < 0.05, 'одна «КВАС» — по центру этикетки')
  // Правило собирает Tailwind: класс записан в исходнике целиком
  const src = read('src/game/Bottle.tsx')
  assert.ok(src.includes("'[@container_(height<70px)_or_(width<28px)]:hidden'"))
})

test('кривая этикетка — та же этикетка «КВАС», повёрнутая; брак заметен', () => {
  const ok = render('ok')
  const label = render('label')
  const subtle = render('label', { subtle: true })
  const labelGroup = (html: string) => html.match(/<g data-label="">[\s\S]*?fill-rule="evenodd"><\/path><\/g>/)?.[0]
  assert.ok(labelGroup(ok))
  assert.equal(labelGroup(label), labelGroup(ok), 'этикетка та же')
  assert.match(label, /<g transform="rotate\(-28 20 59\.5\) translate\(0 6\)"><g data-label="">/)
  assert.match(subtle, /<g transform="rotate\(-9 20 59\.5\) translate\(0 3\.5\)"><g data-label="">/)
  // Остальной брак на месте: без крышки — пена, недолив — пунктир нужного уровня
  assert.match(render('nocap'), /<ellipse cx="20" cy="10"/)
  assert.doesNotMatch(ok, /<ellipse/)
  assert.match(render('lowfill'), /<rect x="0" y="70" width="40" height="26"/)
  assert.match(render('lowfill'), /stroke-dasharray="2.4 2"/)
})

test('квас цвета кваса: налив — градиент KVASS_TOP → KVASS_BOTTOM в обоих тонах; BottleShape прежний', () => {
  for (const tone of ['dark', 'light'] as const) {
    const html = renderToStaticMarkup(createElement(Bottle, { kind: 'ok', tone }))
    assert.match(html, new RegExp(`stop-color="${KVASS_TOP}"[^]*stop-color="${KVASS_BOTTOM}"`))
    assert.match(html, /<rect x="0" y="27" width="40" height="69" fill="url\(#/)
  }
  const shape = renderToStaticMarkup(createElement(BottleShape, { level: 0.5 }))
  assert.match(shape, /^<svg viewBox="0 0 40 100"/)
  assert.doesNotMatch(shape, /data-kvas/)
})

test('фавиконка — силуэт бутылки без круга и рамки', () => {
  const svg = read('public/favicon.svg')
  assert.doesNotMatch(svg, /<circle|<ellipse/)
  // Единственный прямоугольник во всю ширину — этикетка внутри силуэта; рамки вокруг знака нет
  const rects = [...svg.matchAll(/<rect ([^>]+)\/>/g)].map((m) => m[1])
  for (const r of rects) {
    const w = Number(r.match(/width="([\d.]+)"/)?.[1])
    assert.ok(w <= 30, `прямоугольник шире бутылки: ${r}`)
  }
  assert.match(svg, /viewBox="-30 0 100 100"/)
  assert.ok(svg.includes(read('src/game/Bottle.tsx').match(/const BODY = '([^']+)'/)![1]), 'силуэт тот же, что у бутылки игры')
  assert.ok(svg.includes(KVAS_GLYPH.d), '«КВАС» на этикетке')
  assert.ok(svg.includes(KVASS_TOP) && svg.includes(KVASS_BOTTOM), 'цвета кваса')
  assert.ok(Buffer.byteLength(svg) < 4096)
  assert.match(read('index.html'), /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml" \/>/)
})
