// Телефоны кандидатов: российские и номера стран, откуда чаще всего приезжают на сезонную работу.
// Номер приводится к международному виду +XXXXXXXXXXX (E.164). Нераспознанный номер — ошибка с текстом,
// а не тихая потеря: HR видит её в предпросмотре импорта и в отчёте.

/** Коды стран: Беларусь, Армения, Киргизия, Узбекистан, Таджикистан, Азербайджан, Грузия, Туркменистан, Молдова, Украина */
const countryCodes = ['375', '374', '996', '998', '992', '994', '995', '993', '373', '380']

export type ParsedPhone = { e164: string } | { error: string }

/** «8 (916) 123-45-67», «+375 29 123 45 67», «9161234567» → +79161234567 / +375291234567. Пусто — null */
export function parsePhone(raw: string): ParsedPhone | null {
  const s = raw.trim()
  if (!s) return null
  if (/[a-zа-яё]/i.test(s.replace(/доб\.?.*$/i, ''))) return { error: `телефон не распознан: «${s.slice(0, 40)}»` }
  const plus = /^\+/.test(s.replace(/^[\s(]+/, ''))
  const d = s.replace(/доб\.?.*$/i, '').replace(/\D/g, '')
  if (plus) {
    if (d.length === 11 && d.startsWith('7')) return { e164: `+${d}` }
    if (d.length >= 10 && d.length <= 15 && !d.startsWith('7')) return { e164: `+${d}` }
    return { error: `телефон не распознан: «${s.slice(0, 40)}»` }
  }
  if (d.length === 11 && (d.startsWith('8') || d.startsWith('7'))) return { e164: `+7${d.slice(1)}` }
  if (d.length === 10 && /^[3-9]/.test(d)) return { e164: `+7${d}` }
  if (d.length >= 11 && d.length <= 13 && countryCodes.some((c) => d.startsWith(c))) return { e164: `+${d}` }
  return { error: `телефон не распознан: «${s.slice(0, 40)}»` }
}

/** Номер для записи в заявку: распознанный — в международном виде (+79161234567), нераспознанный — как ввели */
export function normalizePhone(raw: string): string {
  const s = raw.trim()
  const r = parsePhone(s)
  return r && 'e164' in r ? r.e164 : s
}

/**
 * Ключ номера для поиска одного и того же человека — те же цифры, что в колонке applications.phone_norm:
 * 8XXXXXXXXXX и 10 цифр приводятся к 7XXXXXXXXXX. Пустая строка — номера нет
 */
export function phoneKey(raw: string): string {
  const d = raw.replace(/\D/g, '')
  if (d.length === 11 && d.startsWith('8')) return `7${d.slice(1)}`
  if (d.length === 10) return `7${d}`
  return d
}

/** Первый распознанный номер из ячейки с несколькими: «+7 (926) 111-22-33, +7 (495) 785-39-30» */
export function parsePhones(cell: string): ParsedPhone | null {
  const parts = cell.split(/[,;/]|\s{2,}/).map((p) => p.trim()).filter(Boolean)
  if (!parts.length) return null
  let firstError: ParsedPhone | null = null
  for (const p of parts) {
    const r = parsePhone(p)
    if (r && 'e164' in r) return r
    firstError ??= r
  }
  return firstError
}

/** Для показа: +7 916 123-45-67, +375 29 123-45-67; нераспознанное — как есть */
export function formatPhone(raw: string) {
  const r = parsePhone(raw)
  if (!r || 'error' in r) return raw
  const d = r.e164.slice(1)
  if (d.startsWith('7') && d.length === 11) return `+7 ${d.slice(1, 4)} ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}`
  const cc = countryCodes.find((c) => d.startsWith(c))
  if (!cc) return `+${d}`
  const rest = d.slice(cc.length)
  return `+${cc} ${rest.slice(0, 2)} ${rest.slice(2, 5)}-${rest.slice(5, 7)}-${rest.slice(7)}`.replace(/-$/, '')
}

/**
 * Для CSV и 1С: те же цифры без «+» в начале. Ячейка, начинающаяся с «+», «=», «-» или «@»,
 * в Excel может выполниться как формула — поэтому телефон пишем «7 916 123-45-67».
 */
export const csvPhone = (raw: string) => {
  const f = formatPhone(raw)
  return f.startsWith('+') ? f.slice(1) : f
}
