import { plural } from './result'

// Лента по сиду и вызов другу: «Поделиться» отправляет /game?c=<сид>-<очки>-<поймано>-<лишние>-<брака всего>&src=ref_<код>.
// У друга та же лента — тот же порядок и вид брака по номеру бутылки (логический слот), на любом экране.
// Таблиц рекордов и призов нет: сравниваются два результата, и только у того, кто открыл ссылку.
// Чистые функции без браузера — их сверяет scripts/tests/w2-game-challenge.test.ts

/** Генератор mulberry32: одинаковый сид — одинаковая последовательность чисел от 0 до 1 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Случайные числа одной бутылки: свой генератор на каждый слот. Слот k получает одни и те же числа, сколько бы бутылок
 * ни встало на ленту до старта и в каком бы порядке ни вызывались другие слоты
 */
export const slotRandom = (seed: number, slot: number) => mulberry32((seed ^ Math.imul(slot + 1, 0x9e3779b1)) >>> 0)

/** Новый сид раунда: 1…2³²−1 */
export function newSeed(): number {
  try {
    const [n] = crypto.getRandomValues(new Uint32Array(1))
    if (n > 0) return n
  } catch {
    // без crypto — Math.random ниже
  }
  return 1 + Math.floor(Math.random() * 0xfffffffe)
}

export type Challenge = {
  seed: number
  score: number
  caught: number
  /** Лишние нажатия по нормальным бутылкам */
  extra: number
  /** Брака на ленте всего; null — в старой ссылке его нет */
  total: number | null
}

/** Очков за одну пойманную бутылку не больше 30 (×3 за серию) — по этому отсеиваем выдуманные ссылки */
const MAX_POINTS_PER_CATCH = 30

/** Значение параметра c: сид в base36 и четыре числа через дефис */
export const encodeChallenge = (c: Challenge) =>
  [c.seed.toString(36), c.score, c.caught, c.extra, ...(c.total === null ? [] : [c.total])].join('-')

/** Разбор c. Всё, что не похоже на настоящий результат, — null: такую ссылку страница молча не замечает */
export function parseChallenge(raw: string | null | undefined): Challenge | null {
  const m = /^([0-9a-z]{1,7})-(\d{1,4})-(\d{1,3})-(\d{1,3})(?:-(\d{1,3}))?$/.exec((raw ?? '').trim())
  if (!m) return null
  const seed = parseInt(m[1], 36)
  const [score, caught, extra] = [m[2], m[3], m[4]].map(Number)
  const total = m[5] === undefined ? null : Number(m[5])
  if (!Number.isSafeInteger(seed) || seed < 1 || seed > 0xffffffff) return null
  if (score > caught * MAX_POINTS_PER_CATCH) return null
  if (total !== null && (total < caught || total < 1)) return null
  return { seed, score, caught, extra, total }
}

/** Строка над лентой у того, кому прислали результат */
export function challengeLine(c: Challenge): string {
  const caught = c.total === null ? `поймано ${c.caught}` : `поймано ${c.caught} из ${c.total}`
  return `Тебе прислали результат: ${caught}, лишних ${c.extra}. Лента та же.`
}

/** Сравнение после раунда — без «побей» и без оценок: два числа рядом */
export const compareLine = (mine: number, theirs: number) => `У тебя ${mine}, у приславшего ${theirs}.`

/** То же для экранного диктора: со словом «очков» */
export const compareSpoken = (mine: number, theirs: number) =>
  `У тебя ${mine} ${plural(mine, ['очко', 'очка', 'очков'])}, в присланном результате ${theirs}.`
