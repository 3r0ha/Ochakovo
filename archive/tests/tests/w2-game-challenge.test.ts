// «Поймай брак»: лента по сиду и вызов другу (w2-gm-1), картинка для сторис (w2-gm-2), события игры (w2-gm-3).
// Логика — чистые функции src/game/challenge.ts, slotBottle и storyLines; подключение — по исходникам. Запуск: pnpm test w2-game

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  challengeLine,
  compareLine,
  compareSpoken,
  encodeChallenge,
  mulberry32,
  newSeed,
  parseChallenge,
  slotRandom,
  type Challenge,
} from '../../src/game/challenge'
import { storyFileName, storyLines } from '../../src/game/storyImage'
import { slotBottle, type GameStats } from '../../src/game/useConveyorGame'

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

/** Лента по сиду: вид каждой бутылки по номеру слота, как в useConveyorGame (не больше двух нормальных подряд) */
function belt(seed: number, n: number, from = 0) {
  const out: string[] = []
  let okInRow = 0
  for (let slot = 0; slot < from + n; slot++) {
    const b = slotBottle(seed, slot, okInRow)
    okInRow = b.kind === 'ok' ? okInRow + 1 : 0
    if (slot >= from) out.push(b.kind)
  }
  return out
}

test('mulberry32: одинаковый сид — одинаковые числа, разные сиды — разные', () => {
  const a = mulberry32(42)
  const b = mulberry32(42)
  const xs = Array.from({ length: 20 }, () => a())
  assert.deepEqual(xs, Array.from({ length: 20 }, () => b()))
  for (const x of xs) assert.ok(x >= 0 && x < 1)
  assert.notDeepEqual(xs, Array.from({ length: 20 }, mulberry32(43)))
})

test('слоты: числа бутылки не зависят от того, сколько слотов и в каком порядке спрашивали до неё', () => {
  const direct = Array.from({ length: 4 }, slotRandom(777, 9))
  for (let k = 0; k < 9; k++) slotRandom(777, k)()
  assert.deepEqual(Array.from({ length: 4 }, slotRandom(777, 9)), direct)
  assert.notDeepEqual(Array.from({ length: 4 }, slotRandom(777, 10)), direct)
})

test('лента по сиду: одинаковый сид — одинаковая последовательность вида брака; разные сиды — разные ленты', () => {
  for (const seed of [1, 12345, 0xffffffff, newSeed()]) {
    assert.deepEqual(belt(seed, 40), belt(seed, 40))
    // Тот же сид, но ленту «досчитали» позже (на другом экране до старта встало другое число бутылок) — хвост тот же
    assert.deepEqual(belt(seed, 40).slice(3), belt(seed, 37, 3))
  }
  assert.notDeepEqual(belt(1, 40), belt(2, 40))
  // Нормальных больше двух подряд не бывает
  for (let seed = 1; seed < 200; seed++) assert.doesNotMatch(belt(seed, 60).join(','), /ok,ok,ok/)
})

test('брака — пропорционально длине раунда: около половины бутылок, вдвое длиннее лента — вдвое больше брака', () => {
  let short = 0
  let long = 0
  const seeds = 300
  for (let seed = 1; seed <= seeds; seed++) {
    short += belt(seed, 30).filter((k) => k !== 'ok').length
    long += belt(seed, 60).filter((k) => k !== 'ok').length
  }
  const share = short / (30 * seeds)
  assert.ok(share > 0.45 && share < 0.65, `доля брака ${share}`)
  assert.ok(Math.abs(long / short - 2) < 0.1, `отношение ${long / short}`)
  // Все три вида брака встречаются
  const kinds = new Set(Array.from({ length: 50 }, (_, s) => belt(s + 1, 30)).flat())
  assert.deepEqual([...kinds].sort(), ['label', 'lowfill', 'nocap', 'ok'])
})

test('параметр c: туда и обратно; неверное значение — null, без исключений', () => {
  const c: Challenge = { seed: 3141592653, score: 310, caught: 13, extra: 1, total: 14 }
  const raw = encodeChallenge(c)
  assert.match(raw, /^[0-9a-z]{1,7}-310-13-1-14$/)
  assert.deepEqual(parseChallenge(raw), c)
  // Старая форма без «брака всего» тоже читается
  assert.deepEqual(parseChallenge('abc-100-5-0'), { seed: parseInt('abc', 36), score: 100, caught: 5, extra: 0, total: null })
  for (const bad of [
    null,
    undefined,
    '',
    'x',
    '0-10-1-0-2', // сид 0
    'zzzzzzzz-10-1-0-2', // сид длиннее 7 знаков
    'zzzzzzz-10-1-0-2', // сид больше 2³²
    'ABC-10-1-0-2', // заглавные
    'abc-10-1-0', // это верно — проверим ниже
    'abc-999-1-0-2', // 999 очков за одну бутылку
    'abc-10-5-0-3', // поймано больше, чем было брака
    'abc--1-0-2',
    'abc-10-1-0-2-7',
    'abc-10-1-0-2&x=1',
    '<script>-1-1-1',
    'abc-10.5-1-0-2',
  ]) {
    if (bad === 'abc-10-1-0') continue
    assert.equal(parseChallenge(bad), null, String(bad))
  }
  assert.notEqual(parseChallenge('abc-10-1-0'), null)
  for (let i = 0; i < 50; i++) {
    const seed = newSeed()
    assert.ok(Number.isInteger(seed) && seed >= 1 && seed <= 0xffffffff)
    assert.equal(parseChallenge(encodeChallenge({ seed, score: 0, caught: 0, extra: 0, total: 9 }))?.seed, seed)
  }
})

test('тексты вызова: строка над лентой, сравнение без «побей» и оценок', () => {
  assert.equal(challengeLine({ seed: 1, score: 290, caught: 13, extra: 1, total: 14 }), 'Тебе прислали результат: поймано 13 из 14, лишних 1. Лента та же.')
  assert.equal(challengeLine({ seed: 1, score: 290, caught: 13, extra: 1, total: null }), 'Тебе прислали результат: поймано 13, лишних 1. Лента та же.')
  assert.equal(compareLine(310, 290), 'У тебя 310, у приславшего 290.')
  assert.equal(compareSpoken(1, 290), 'У тебя 1 очко, в присланном результате 290.')
  for (const t of [challengeLine({ seed: 1, score: 0, caught: 0, extra: 0, total: 5 }), compareLine(0, 0), compareSpoken(5, 0)])
    assert.doesNotMatch(t, /!|побе|рекорд|лучше|хуже|молодец/i, t)
})

test('подключение вызова: /game читает c, неверный c молча не замечает, «Откликнуться вдвоём» — с отметкой «Иду с другом»', () => {
  const page = read('src/pages/Game.tsx')
  assert.match(page, /parseChallenge\(raw\)/)
  assert.match(page, /challenge=\{challenge\}/)
  const game = read('src/game/InlineGame.tsx')
  assert.match(game, /roundSeed\.current = challenge\?\.seed \?\? newSeed\(\)/)
  assert.match(game, /game\.reset\(roundSeed\.current\)/)
  assert.match(game, /\{nb\(challengeLine\(challenge\)\)\}/)
  assert.match(game, /\{compareLine\(stats\.score, challenge\.score\)\}/)
  assert.match(game, /'\/apply\?friend=1'/)
  assert.match(game, /Откликнуться вдвоём/)
  assert.doesNotMatch(game, /побей|таблиц[аы] рекордов|(^|[^а-яё])приз(ы|ов|а)?([^а-яё]|$)/i)
  // Слот бутылки виден в разметке: две вкладки с одним c можно сравнить по data-slot и data-kind
  assert.match(read('src/game/ConveyorStage.tsx'), /data-slot=\{it\.slot\}/)
})

test('события игры: game_start — только по «Играть», share — по «Поделиться», без очков', () => {
  const game = read('src/game/InlineGame.tsx')
  const starts = game.match(/trackEvent\('game_start'[^)]*\)/g) ?? []
  assert.deepEqual(starts, ["trackEvent('game_start')"])
  // «Играть» — оверлей заставки; «Ещё раз» вызывает start без события
  assert.ok(game.indexOf("trackEvent('game_start')") > game.indexOf('<IdleOverlay'))
  const start = game.slice(game.indexOf('  const start = () => {'), game.indexOf('  const finishWarmup'))
  assert.doesNotMatch(start, /trackEvent/)
  const shares = game.match(/trackEvent\('share'[^)]*\)/g) ?? []
  assert.deepEqual(shares, ["trackEvent('share', { kind: 'game' })"])
})

const stats = (over: Partial<GameStats>): GameStats => ({
  score: 0,
  caught: 0,
  mistakes: 0,
  missed: 0,
  subtleMissed: 0,
  streak: 0,
  maxMult: 1,
  bottles: 30,
  seconds: 20,
  ...over,
})

test('картинка для сторис: числа — из раунда, «Поймай брак» и адрес сайта, имя файла без даты', () => {
  const s = stats({ score: 310, caught: 13, missed: 1, mistakes: 1 })
  const l = storyLines(s, 'https://season.example.ru/')
  assert.equal(l.score, '310')
  assert.equal(l.scoreWord, 'очков')
  assert.equal(l.caught, 'Поймано 13 из 14')
  assert.equal(l.extra, 'Лишних нажатий: 1')
  assert.deepEqual(l.title, ['Поймай', 'брак'])
  assert.equal(l.site, 'season.example.ru/game')
  assert.equal(l.eyebrow, 'Игра на 20 секунд')
  assert.equal(storyLines(stats({ score: 1 }), 'x.ru').scoreWord, 'очко')
  assert.equal(storyFileName(s), 'poymay-brak-310.png')
  assert.doesNotMatch(storyFileName(s), /\d{4}-\d{2}/)
  const src = read('src/game/storyImage.ts')
  assert.match(src, /export const STORY_W = 1080/)
  assert.match(src, /export const STORY_H = 1920/)
  assert.match(src, /navigator\.canShare\?\.\(\{ files: \[file\] \}\)/)
  assert.match(src, /a\.download = name/)
  assert.match(read('src/game/InlineGame.tsx'), /Сохранить картинку для сторис/)
})
