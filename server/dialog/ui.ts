import type { Button, OutMessage } from './types'

// Мелкие помощники для сообщений и кнопок. Не больше трёх кнопок в ряду —
// так клавиатура одинаково читается и в Telegram, и в MAX.

export const btn = (text: string, action: string): Button => {
  if (Buffer.byteLength(action) > 64) throw new Error(`action длиннее 64 байт: ${action}`)
  return { kind: 'action', text, action }
}

export const link = (text: string, url: string): Button => ({ kind: 'link', text, url })

export const contactButton = (text: string): Button => ({ kind: 'contact', text })

/** Разбить кнопки на ряды по n штук */
export function rows(buttons: Button[], perRow = 2): Button[][] {
  const out: Button[][] = []
  for (let i = 0; i < buttons.length; i += perRow) out.push(buttons.slice(i, i + perRow))
  return out
}

export const menuRow = (): Button[] => [btn('Меню', 'm')]

export const cancelRow = (): Button[] => [btn('Отмена', 'x')]

export const msg = (text: string, extra: Omit<OutMessage, 'text'> = {}): OutMessage => ({ text, ...extra })

export const monthNames = ['Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен'] as const
export const monthValues = [3, 4, 5, 6, 7, 8, 9] as const
const monthFull: Record<number, string> = { 3: 'март', 4: 'апрель', 5: 'май', 6: 'июнь', 7: 'июль', 8: 'август', 9: 'сентябрь' }

export const monthList = (months: number[]) => months.map((m) => monthFull[m]).join(', ')

const monthGenitive: Record<number, string> = { 3: 'марта', 4: 'апреля', 5: 'мая', 6: 'июня', 7: 'июля', 8: 'августа', 9: 'сентября' }

/** [6,7,8,9] → «с июня по сентябрь», [6,7] → «июнь и июль», [7] → «июль», [3,6] → «март, июнь» */
export function monthsPhrase(months: number[]) {
  const sorted = [...months].sort((a, b) => a - b)
  const consecutive = sorted.every((m, i) => i === 0 || m === sorted[i - 1] + 1)
  if (sorted.length >= 3 && consecutive) return `с ${monthGenitive[sorted[0]]} по ${monthFull[sorted.at(-1)!]}`
  if (sorted.length === 2 && consecutive) return `${monthFull[sorted[0]]} и ${monthFull[sorted[1]]}`
  return monthList(sorted)
}

/** Кнопки месяцев с отметкой выбранных; action = `${prefix}${месяц}` */
export function monthButtons(selected: number[], prefix: string): Button[][] {
  const buttons = monthValues.map((m, i) => btn(selected.includes(m) ? `${monthNames[i]} ✓` : monthNames[i], `${prefix}${m}`))
  return rows(buttons, 3)
}

export function toggle(list: number[], value: number) {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value].sort((a, b) => a - b)
}

export const plural = (n: number, one: string, few: string, many: string) => {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}
