import { PLANT_BOTTLES_PER_HOUR } from '@shared/content/production'
import type { GameStats } from './useConveyorGame'

// Тексты итога «Поймай брак»: разбор, масштаб завода, «Поделиться». Каждое число — из раунда или из shared,
// поэтому всё здесь чистые функции без браузера: их сверяет scripts/tests/w1-game-result.test.ts

export const plural = <T>(n: number, forms: [T, T, T]): T => {
  const d = n % 10
  const h = n % 100
  return forms[d === 1 && h !== 11 ? 0 : d >= 2 && d <= 4 && (h < 12 || h > 14) ? 1 : 2]
}

/** Брак на ленте за раунд: пойманный и пропущенный */
export const defectsTotal = (s: GameStats) => s.caught + s.missed

/** Доля пойманного брака, после которой итог предлагает работу оператора линии */
export const SHARP_EYE = 0.85
/** Лишних нажатий по нормальным бутылкам, при которых предложение ещё звучит */
const SHARP_MISTAKES = 1
/** С этого числа лишних нажатий разбор начинается с них: человек жал на всё подряд */
const CARELESS = 3

/**
 * Предлагать ли в итоге работу оператора. Нужен и пойманный брак, и точность:
 * кто жмёт на все бутылки подряд, ловит весь брак, но снимает и нормальные — такому раунду предложения нет
 */
export function offersJob(s: GameStats): boolean {
  const total = defectsTotal(s)
  return total >= 8 && s.caught / total >= SHARP_EYE && s.mistakes <= SHARP_MISTAKES
}

/** «Снята 1 нормальная бутылка», «Снято 3 нормальные бутылки», «Снято 7 нормальных бутылок» */
function removedNormal(n: number) {
  const [verb, rest] = plural(n, [
    ['Снята', 'нормальная бутылка'],
    ['Снято', 'нормальные бутылки'],
    ['Снято', 'нормальных бутылок'],
  ])
  return `${verb} ${n} ${rest}`
}

/** Разбор раунда: каждое предложение следует из счёта, первым — главное, без похвалы ради похвалы */
export function verdict(s: GameStats): string {
  const total = defectsTotal(s)
  if (total === 0) return 'Брака на ленте не попалось, сыграй ещё раз.'
  if (s.missed === 0 && s.mistakes === 0) return 'Без единой ошибки весь брак снят, нормальные бутылки ушли на склад.'
  if (s.caught === 0 && s.mistakes === 0) return `Нажатий не было, и весь брак уехал на склад: ${s.missed} ${plural(s.missed, ['бутылка', 'бутылки', 'бутылок'])}. Брак видно по крышке, уровню кваса и этикетке.`

  const out: string[] = []
  if (s.mistakes >= CARELESS) {
    // Нажатия по всему подряд: сначала об этом, потом — сколько брака поймано
    out.push(`${removedNormal(s.mistakes)}, минус 5 очков за каждую.`)
    out.push(`Брака поймано ${s.caught} из ${total}.`)
    out.push('На контроле нормальные пропускают и снимают только брак.')
    return out.join(' ')
  }

  out.push(
    s.missed === 0
      ? 'Весь брак пойман.'
      : `${plural(s.missed, ['Пропущена', 'Пропущено', 'Пропущено'])} ${s.missed} ${plural(s.missed, ['бутылка', 'бутылки', 'бутылок'])} с браком.`,
  )
  if (s.mistakes === 0) out.push('По нормальным бутылкам ни одного лишнего нажатия.')
  else if (s.mistakes === 1) out.push('Одно лишнее нажатие по нормальной бутылке, минус 5 очков.')
  // Меньше CARELESS и больше одного — ровно два
  else out.push('Два лишних нажатия по нормальным бутылкам, минус 5 очков за каждое.')
  if (s.subtleMissed > 0) out.push('Ближе к концу брак тоньше: недолив на треть, этикетка чуть съехала.')
  else if (s.caught / total < 0.7) out.push('Брак видно по крышке, уровню кваса и этикетке.')
  return out.join(' ')
}

/** Сколько бутылок завод разливает за столько секунд — по PLANT_BOTTLES_PER_HOUR */
export const plantBottlesIn = (seconds: number) => Math.round((PLANT_BOTTLES_PER_HOUR * seconds) / 3600)

const thousands = (n: number) => n.toLocaleString('ru-RU')

/** «За 20 секунд мимо тебя проехало 34 бутылки. Завод разливает до 70 000 бутылок в час, то есть до 389 за те же 20 секунд» */
export function scaleLine(s: GameStats): string {
  const n = s.seconds
  const k = s.bottles
  const secs = plural(n, ['секунду', 'секунды', 'секунд'])
  return (
    `За ${n} ${secs} мимо тебя ${plural(k, ['проехала', 'проехали', 'проехало'])} ${k} ${plural(k, ['бутылка', 'бутылки', 'бутылок'])}. ` +
    `Завод разливает до ${thousands(PLANT_BOTTLES_PER_HOUR)} бутылок в час, то есть до ${thousands(plantBottlesIn(n))} за те же ${n} ${secs}.`
  )
}

/** Текст для «Поделиться»: счёт как есть, вместе с лишними нажатиями — без приукрашивания */
export function shareText(s: GameStats): string {
  const lead = s.missed === 0 && s.mistakes === 0 && defectsTotal(s) > 0 ? 'Без единой ошибки поймано' : 'Поймано'
  return `${lead} ${s.caught} из ${defectsTotal(s)}, лишних нажатий ${s.mistakes}. Игра «Поймай брак», ${s.seconds} ${plural(s.seconds, ['секунда', 'секунды', 'секунд'])} у конвейера «Очаково».`
}
