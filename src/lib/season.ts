/** Сезон идёт с марта по сентябрь; с октября набираем уже на следующий. */
export function seasonYear(now = new Date()) {
  return now.getMonth() >= 9 ? now.getFullYear() + 1 : now.getFullYear()
}

export const seasonMonths = [
  { value: 3, label: 'Мар' },
  { value: 4, label: 'Апр' },
  { value: 5, label: 'Май' },
  { value: 6, label: 'Июн' },
  { value: 7, label: 'Июл' },
  { value: 8, label: 'Авг' },
  { value: 9, label: 'Сен' },
]
