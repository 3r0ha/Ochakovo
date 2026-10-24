import { departments } from '@shared/content/departments'
import { estimateNote, formatRub, netPay, openVacancyById, payLabel, scheduleLine, vacanciesByPay, type Vacancy } from '@shared/content/vacancies'
import { reply, siteBase, withImage, type Ctx } from '../context'
import { photoJpeg } from '../images'
import { btn, link, menuRow, msg } from '../ui'
import { shiftVideoForVacancy } from '../videos'
import { menu } from './menu'
import type { Button } from '../types'

// Список вакансий и карточка вакансии. Порядок — vacanciesByPay: оплачиваемая практика, бесплатная практика, работа

const PAGE = 5

/** Зарплата с пометкой «ориентир» для сумм, которые пока не утверждены; у бесплатной практики — «без оплаты» */
export const payText = (v: Vacancy) => `${payLabel(v)}${v.pay?.estimate ? ' (ориентир)' : ''}`

export function list(_ctx: Ctx, page = 0) {
  const pages = Math.ceil(vacanciesByPay.length / PAGE)
  const p = Math.min(Math.max(page, 0), pages - 1)
  const slice = vacanciesByPay.slice(p * PAGE, p * PAGE + PAGE)
  // Заголовок формата там, где он меняется: «Оплачиваемая практика», «Бесплатная практика», «Постоянная работа»
  const lines = slice.flatMap((v, i) => {
    const prev = i > 0 ? slice[i - 1] : undefined
    const line = `${p * PAGE + i + 1}. ${v.title} · ${payText(v)}`
    return prev?.format === v.format ? [line] : [`${i > 0 ? '\n' : ''}**${v.format}**`, line]
  })
  const nav: Button[] = []
  if (p > 0) nav.push(btn('Предыдущие', `v:list:${p - 1}`))
  if (p < pages - 1) nav.push(btn('Следующие', `v:list:${p + 1}`))
  // Откуда суммы — на первой странице, текст общий с сайтом
  const lead = p === 0 ? `${estimateNote}\n\n` : ''
  return reply(
    msg(`**Практика и вакансии** · страница ${p + 1} из ${pages}\n\n${lead}${lines.join('\n')}\n\nНажми на вакансию, чтобы открыть подробности.`, {
      buttons: [...slice.map((v) => [btn(v.title, `v:open:${v.id}`)]), ...(nav.length ? [nav] : []), menuRow()],
    }),
  )
}

export function card(v: Vacancy) {
  const where = v.unit ?? departments[v.department].name
  const pay = v.pay
    ? `Зарплата: ${payLabel(v)} в месяц до вычета налога${v.pay.estimate ? ' (ориентир)' : ''}${v.payNote ? `, ${v.payNote}` : ''}\nНа руки: от ${formatRub(netPay(v.pay.from))}`
    : v.format === 'Бесплатная практика'
      ? 'Без оплаты: практика по договорённости с вузом или колледжем'
      : `Зарплата: ${payText(v)}`
  const hours = v.hours ? `\nСмены: ${v.hours.charAt(0).toLowerCase()}${v.hours.slice(1)}` : ''
  return (
    `**${v.title}**\n${where} · ${v.format.toLowerCase()}\n\n` +
    `${pay}\nГрафик: ${scheduleLine(v)}${hours}\nСрок: ${v.period.charAt(0).toLowerCase()}${v.period.slice(1)}\n\n` +
    `**Что делать**\n${v.tasks.map((t) => `• ${t}`).join('\n')}\n\n**Кого берут**\n${v.requirements}`
  )
}

export async function open(ctx: Ctx, id: string) {
  // Кнопка из старого сообщения не открывает вакансию, которую HR закрыл в панели
  const v = openVacancyById(id)
  if (!v) return list(ctx, 0)
  // Ролик «Смена изнутри» — ссылкой на файл с сайта: честное превью работы до отклика
  const video = shiftVideoForVacancy(v.id, siteBase(ctx))
  return reply(
    msg(card(v), {
      ...withImage(await photoJpeg(departments[v.department].photo)),
      buttons: [
        [btn('Откликнуться на эту вакансию', `a:start:${v.id}`)],
        ...(video ? [[link(`Посмотреть смену · ${video.duration}`, video.url)]] : []),
        [btn('Все вакансии', 'v:list:0'), btn('Меню', 'm')],
      ],
    }),
  )
}

export async function route(ctx: Ctx, parts: string[]) {
  const [, cmd, arg] = parts
  if (cmd === 'list') return list(ctx, Number(arg) || 0)
  if (cmd === 'open' && arg) return open(ctx, arg)
  return menu(ctx)
}
