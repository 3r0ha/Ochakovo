import type { HrApplication, InterviewSlot } from './applications'
import { vacancyById } from './content/vacancies'

// Тексты сообщений кандидату: одни подстановки на сервере (отправка) и в панели (предпросмотр)

const msk = (d: Date, o: Intl.DateTimeFormatOptions) => d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', ...o })

/**
 * Подстановки: {name}, {id}, {vacancy}, {ref} — «по заявке № …» или «по твоему отклику на hh.ru»,
 * {request} — «заявку № …» или «отклик на hh.ru»; для собеседования ещё {date}, {time}, {address}, {bring}
 */
export const placeholders = ['name', 'id', 'vacancy', 'ref', 'request', 'date', 'time', 'address', 'bring'] as const

export function renderTemplate(
  text: string,
  app: Pick<HrApplication, 'name' | 'id' | 'vacancyId'> & { source?: string | null },
  interview?: Pick<InterviewSlot, 'startsAt' | 'address' | 'bring'> | null,
) {
  const firstName = app.name.trim().split(/\s+/)[0] || 'Привет'
  const v = app.vacancyId ? vacancyById(app.vacancyId) : undefined
  const at = interview ? new Date(interview.startsAt) : null
  // Кандидат с hh.ru не оставлял заявку на сайте: номер заявки ему ничего не скажет
  const hh = app.source === 'hh'
  return text
    .replaceAll('{name}', firstName)
    .replaceAll('{ref}', hh ? 'по твоему отклику на hh.ru' : `по заявке № ${app.id}`)
    .replaceAll('{request}', hh ? 'отклик на hh.ru' : `заявку № ${app.id}`)
    .replaceAll('{id}', app.id)
    .replaceAll('{vacancy}', v ? (hh ? ` на вакансию «${v.title}»` : ` на позицию «${v.title}»`) : '')
    .replaceAll('{date}', at ? msk(at, { weekday: 'long', day: 'numeric', month: 'long' }) : 'дату сообщат дополнительно')
    .replaceAll('{time}', at ? msk(at, { hour: '2-digit', minute: '2-digit' }) : '')
    .replaceAll('{address}', interview?.address || 'адрес сообщат дополнительно')
    .replaceAll('{bring}', interview?.bring || 'паспорт')
    .replace(/\s+([.,])/g, '$1')
    .replace(/,\s*\./g, '.')
}
