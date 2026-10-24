// «Поймай брак»: честный итог, масштаб завода, «Поделиться» с кодом приглашения, рекорд и счёт в заявке,
// строка о работе на /game. Тексты считаются чистыми функциями из src/game/result.ts. Запуск: pnpm test w1-game

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { PLANT_BOTTLES_PER_HOUR } from '../../shared/content/production'
import { formatRub, minMonthlyPay } from '../../shared/content/vacancies'
import { defectsTotal, offersJob, plantBottlesIn, plural, scaleLine, shareText, verdict } from '../../src/game/result'
import type { GameStats } from '../../src/game/useConveyorGame'

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
/** Неразрывные пробелы — в обычные: так сравниваем тексты */
const plain = (t: string) => t.replace(/[  ]/g, ' ').replace(/⁠/g, '')

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

/** Раунд «жму на всё подряд»: весь брак снят, но и все нормальные бутылки тоже */
const tapAll = stats({ score: 60, caught: 14, missed: 0, mistakes: 17, bottles: 31 })
const perfect = stats({ score: 290, caught: 14, missed: 0, mistakes: 0, maxMult: 3, bottles: 31 })

test('нажатия по всем бутылкам: работу не предлагаем, разбор начинается со «Снято N нормальных бутылок»', () => {
  assert.equal(offersJob(tapAll), false)
  const text = verdict(tapAll)
  assert.ok(text.startsWith('Снято 17 нормальных бутылок'), text)
  assert.match(text, /Брака поймано 14 из 14\./)
  assert.doesNotMatch(text, /Весь брак пойман|Без единой ошибки/)
})

test('идеальный раунд — «Без единой ошибки», и только он', () => {
  assert.ok(verdict(perfect).startsWith('Без единой ошибки'), verdict(perfect))
  assert.equal(offersJob(perfect), true)
  for (const s of [stats({ caught: 13, missed: 1 }), stats({ caught: 14, mistakes: 1 }), tapAll]) assert.ok(!verdict(s).includes('Без единой ошибки'), verdict(s))
})

test('разбор по счёту: одно и два лишних нажатия, пропуски, тонкий брак, пустая лента', () => {
  assert.equal(verdict(stats({ caught: 12, missed: 2, mistakes: 1 })), 'Пропущено 2 бутылки с браком. Одно лишнее нажатие по нормальной бутылке, минус 5 очков.')
  assert.equal(verdict(stats({ caught: 13, missed: 1, mistakes: 0 })), 'Пропущена 1 бутылка с браком. По нормальным бутылкам ни одного лишнего нажатия.')
  assert.equal(verdict(stats({ caught: 14, missed: 0, mistakes: 2 })), 'Весь брак пойман. Два лишних нажатия по нормальным бутылкам, минус 5 очков за каждое.')
  assert.match(verdict(stats({ caught: 10, missed: 3, subtleMissed: 2 })), /Ближе к концу брак тоньше/)
  assert.match(verdict(stats({ caught: 5, missed: 9 })), /Брак видно по крышке, уровню кваса и этикетке\.$/)
  assert.equal(verdict(stats({ caught: 0, missed: 0 })), 'Брака на ленте не попалось, сыграй ещё раз.')
  // Раунд без единого нажатия — без «ни одного лишнего нажатия»
  assert.equal(verdict(stats({ caught: 0, missed: 12 })), 'Нажатий не было, и весь брак уехал на склад: 12 бутылок. Брак видно по крышке, уровню кваса и этикетке.')
  // Три и больше лишних нажатий — с них и начинаем, в нужной форме
  assert.ok(verdict(stats({ caught: 9, missed: 1, mistakes: 3 })).startsWith('Снято 3 нормальные бутылки, минус 5 очков за каждую.'))
  assert.ok(verdict(stats({ caught: 9, missed: 1, mistakes: 21 })).startsWith('Снята 21 нормальная бутылка'))
})

test('предложение работы — за точный раунд: 85 % брака и не больше одного лишнего нажатия', () => {
  assert.equal(offersJob(stats({ caught: 12, missed: 2, mistakes: 1 })), true)
  assert.equal(offersJob(stats({ caught: 12, missed: 2, mistakes: 2 })), false)
  assert.equal(offersJob(stats({ caught: 11, missed: 3 })), false)
  // Короткий раунд с горсткой брака — без выводов
  assert.equal(offersJob(stats({ caught: 5, missed: 0 })), false)
})

test('тексты без «!», многоточий и рода: ни «поймал», ни «нажал»', () => {
  const all = [tapAll, perfect, stats({ caught: 12, missed: 2, mistakes: 1 }), stats({ caught: 4, missed: 10, mistakes: 5, subtleMissed: 3 })].flatMap((s) => [
    verdict(s),
    scaleLine(s),
    shareText(s),
  ])
  for (const t of all) {
    assert.doesNotMatch(t, /!|\.\.\.|…/, t)
    assert.doesNotMatch(t, /\b(поймал|нажал|пропустил|снял)(а|\(а\))?\b/i, t)
  }
})

test('масштаб завода: N секунд и K бутылок из раунда, 70 000 в час — из PLANT_BOTTLES_PER_HOUR', () => {
  const line = plain(scaleLine(stats({ bottles: 34, seconds: 20 })))
  assert.equal(PLANT_BOTTLES_PER_HOUR, 70_000)
  assert.equal(plantBottlesIn(20), Math.round((70_000 * 20) / 3600))
  assert.equal(line, `За 20 секунд мимо тебя проехали 34 бутылки. Завод разливает до 70 000 бутылок в час, то есть до ${plantBottlesIn(20)} за те же 20 секунд.`)
  // Число и секунды берутся из раунда, а не из текста
  assert.ok(plain(scaleLine(stats({ bottles: 21, seconds: 12 }))).startsWith('За 12 секунд мимо тебя проехала 21 бутылка.'))
  assert.ok(plain(scaleLine(stats({ bottles: 35, seconds: 20 }))).startsWith('За 20 секунд мимо тебя проехало 35 бутылок.'))
  assert.ok(plain(scaleLine(stats({ bottles: 1, seconds: 1 }))).startsWith('За 1 секунду мимо тебя проехала 1 бутылка.'))
  // «Завод», а не «линия»
  assert.doesNotMatch(line, /лини/)
})

test('«Поделиться»: «лишних нажатий N» и честный счёт', () => {
  assert.equal(shareText(tapAll), 'Поймано 14 из 14, лишних нажатий 17. Игра «Поймай брак», 20 секунд у конвейера «Очаково».')
  assert.ok(shareText(perfect).startsWith('Без единой ошибки поймано 14 из 14, лишних нажатий 0'))
  assert.equal(defectsTotal(tapAll), 14)
  assert.equal(plural(22, ['секунда', 'секунды', 'секунд']), 'секунды')
})

test('ссылка «Поделиться» — приглашение с кодом браузера на /game и вызовом той же ленты', () => {
  const game = read('src/game/InlineGame.tsx')
  // /game?c=<сид>-<очки>-<поймано>-<лишние>-<брака>&src=ref_<код> — разбор c сверяет w2-game-challenge.test.ts
  assert.match(game, /const url = inviteUrl\(`\/game\?c=\$\{encodeChallenge\(\{ seed, score: stats\.score, caught: stats\.caught, extra: stats\.mistakes, total: defectsTotal\(stats\) \}\)\}`\)/)
  assert.match(game, /const text = shareText\(stats\)/)
  assert.doesNotMatch(game, /src=share/)
  // inviteUrl('/game?c=…') → /game?c=…&src=ref_<код>: ссылку строит src/lib/ref.ts
  assert.match(read('src/lib/ref.ts'), /url\.searchParams\.set\('src', `ref_\$\{myRefCode\(\)\}`\)/)
})

test('итог раунда: предложение работы только через offersJob, строка о масштабе под разбором', () => {
  const game = read('src/game/InlineGame.tsx')
  assert.match(game, /const sharp = offersJob\(stats\)/)
  assert.match(game, /\{verdict\(stats\)\}/)
  assert.match(game, /\{scaleLine\(stats\)\}/)
  assert.ok(game.indexOf('{verdict(stats)}') < game.indexOf('{scaleLine(stats)}'))
})

test('рекорд только растёт, счёт в заявке — отдельный флаг; на /game галочки нет', async () => {
  // Хранилище браузера в памяти: persist у zustand пишет в window.localStorage
  const store = new Map<string, string>()
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis })
  const { useProfile } = await import('../../src/store/profile')
  const p = () => useProfile.getState()
  p().setConveyorBest(120)
  p().setConveyorBest(40)
  p().setConveyorBest(Number.NaN)
  assert.equal(p().conveyorBest, 120)
  p().setConveyorBest(150)
  assert.equal(p().conveyorBest, 150)
  // Флаг «показать в заявке» не трогает рекорд
  p().setAttachScore(false)
  assert.equal(p().conveyorBest, 150)
  assert.equal(p().attachScore, false)
  p().setAttachScore(true)
  assert.equal(JSON.parse(store.get('ochakovo.profile') ?? '{}').state?.conveyorBest, 150)

  const page = read('src/pages/Game.tsx')
  assert.doesNotMatch(page, /type="checkbox"|setState\(\{ conveyorBest|Показать результат/)
  // Рекорд снижать некому: прямой записи conveyorBest в игре нет
  for (const file of ['src/game/InlineGame.tsx', 'src/pages/Game.tsx']) assert.doesNotMatch(read(file), /setState\(\{[^}]*conveyorBest/, file)
})

test('/game: игра в первом экране, под лентой — строка о работе с суммой из shared и «Откликнуться»', () => {
  const page = read('src/pages/Game.tsx')
  assert.match(page, /nb\(`Летняя работа на этом заводе от \$\{formatRub\(minMonthlyPay\)\} в месяц`\)/)
  assert.match(page, /<Link to="\/apply" className=\{`\$\{btnRed\}[^`]*`\}>\s*Откликнуться/)
  // Пришли играть: сначала лента с «Играть», строка о работе и кнопка — сразу под ней (первый экран проверяет e2e game)
  assert.ok(page.indexOf('<InlineGame') < page.indexOf('data-game-job'))
  assert.ok(minMonthlyPay > 0 && formatRub(minMonthlyPay).endsWith('₽'))
})
