// Компонент ShiftVideo: ролик по нажатию, файл не грузится заранее, без автозвука, понятная кнопка, подпись про звук.
// Разметку проверяем через react-dom/server, поведение в браузере — глазами (скриншоты 390 и 1440).
// Запуск: pnpm test c2-brand-media-shiftvideo

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SHIFT_VIDEOS, ShiftVideo, durationWords, formatDuration, pickQuality, soundNote } from '../../src/components/ShiftVideo'

const render = (props: Parameters<typeof ShiftVideo>[0]) => renderToStaticMarkup(createElement(ShiftVideo, props))
const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/ /g, ' ')

test('постер с кнопкой: видео не грузится заранее, без автозапуска и со звуком выключенным', () => {
  for (const v of SHIFT_VIDEOS) {
    const html = render({ id: v.id })
    const video = html.match(/<video[^>]*>/)?.[0] ?? ''
    assert.match(video, /preload="none"/, 'файл ролика не запрашивается до нажатия')
    assert.match(video, /playsInline=""|playsinline=""/)
    assert.doesNotMatch(video, /autoplay/i, 'ролик не запускается сам')
    assert.doesNotMatch(video, /\bcontrols\b/, 'панель плеера — после запуска')
    assert.doesNotMatch(video, /\bposter=/, 'постер рисуем сами: AVIF, WebP и мини-превью')
    assert.match(video, /src="\/video\/[a-z-]+-720\.mp4"/, 'вне браузера — 720p')
    assert.match(video, /tabindex="-1"/, 'до запуска плеер не в порядке Tab')
    // Кнопка: видимая подпись входит в доступное имя
    const button = unescape(html.match(/<button[^>]*aria-label="([^"]+)"/)?.[1] ?? '')
    assert.equal(button, `Посмотреть смену: ${v.profession}, ${durationWords(v.duration)}`)
    assert.match(html, /type="button"/)
    assert.match(unescape(html), new RegExp(`Посмотреть смену<span[^>]*>${formatDuration(v.duration)}</span>`))
    // Постер: AVIF и WebP, ленивый, мини-превью фоном
    assert.match(html, /<source type="image\/avif" srcSet="[^"]+1280w"/)
    assert.match(html, /<source type="image\/webp" srcSet="[^"]+1280w"/)
    assert.match(html, /loading="lazy"/)
    assert.ok(html.includes(v.lqip))
    // Подпись про звук и титры для экранного диктора
    assert.ok(unescape(html).includes(soundNote(v)))
    assert.match(html, /aria-describedby="[^"]+"/)
    assert.ok(unescape(html).includes(v.steps[0]))
  }
})

test('вариант «кнопка»: только кнопка «Посмотреть смену», ни видео, ни постера', () => {
  const v = SHIFT_VIDEOS[1]
  const html = render({ id: v.id, variant: 'button' })
  assert.doesNotMatch(html, /<video|<picture|<img/)
  assert.match(html, /^<button type="button" aria-label="Посмотреть смену: /)
  assert.match(html, /<span class="underline[^"]*">Посмотреть смену<\/span>/)
  assert.ok(html.includes(formatDuration(v.duration)))
})

test('подписи: длительность, секунды словами, звук', () => {
  assert.equal(formatDuration(25.2), '0:25')
  assert.equal(formatDuration(31.3), '0:31')
  assert.equal(formatDuration(65), '1:05')
  assert.equal(durationWords(21), '21 секунда')
  assert.equal(durationWords(23), '23 секунды')
  assert.equal(durationWords(25), '25 секунд')
  assert.equal(durationWords(12), '12 секунд')
  assert.equal(soundNote({ speech: true }), 'В ролике говорят, включи звук.')
  assert.equal(soundNote({ speech: false }), 'Без слов, только музыка и титры. Смотреть можно без звука.')
  for (const text of [soundNote({ speech: true }), soundNote({ speech: false })]) assert.doesNotMatch(text, /!/)
})

test('качество: телефону и при экономии трафика — 480p, иначе 720p', () => {
  assert.equal(pickQuality({ width: 390 }), '480')
  assert.equal(pickQuality({ width: 1440 }), '720')
  assert.equal(pickQuality({ width: 1440, connection: { saveData: true } }), '480')
  assert.equal(pickQuality({ width: 1440, connection: { effectiveType: '3g' } }), '480')
  assert.equal(pickQuality({ width: 1440, connection: { effectiveType: '4g' } }), '720')
})

test('в коде: пауза вне экрана и на скрытой вкладке, один ролик за раз, запуск без звука', () => {
  const src = readFileSync(new URL('../../src/components/ShiftVideo.tsx', import.meta.url), 'utf8')
  assert.match(src, /new IntersectionObserver\(\(\[e\]\) => e\.intersectionRatio < 0\.25 && stop\(\), \{ threshold: \[0, 0\.25\] \}\)/)
  assert.match(src, /visibilitychange/)
  assert.match(src, /if \(playing && playing !== el\) playing\.pause\(\)/)
  assert.match(src, /useState\(true\)/, 'muted по умолчанию')
  assert.doesNotMatch(src, /autoPlay/)
})
