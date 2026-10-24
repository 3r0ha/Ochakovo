import { phonebook, phoneLine } from '@shared/content/content'
import { handbookText, practiceDocs, TRAINING_CENTER_ROOM } from '@shared/content/handbook'
import { freePracticeInfo, paidPracticeInfo } from '@shared/content/practice'
import { formatRub, freePractice, NIGHT_PAY_NOTE, paidPractice, payLabel } from '@shared/content/vacancies'
import { reply, siteBase, type Ctx } from '../context'
import { listRu } from '../progress'
import { btn, link, menuRow, msg, rows } from '../ui'
import type { Button } from '../types'
import { practiceVideos } from '../videos'
import { applyOrStatus } from './status'

// Практика в боте: оплачиваемая (5 ролей в 4 отделах, суммы, срок, что даёт компания, ролики «Смена изнутри»),
// бесплатная по договорённости (задачи из «Описания практики») и документы по практике (справочник студента).
// Тексты и цифры — из shared/content: practice.ts, vacancies.ts, handbook.ts.
//
// Кнопки: m:prac — оплачиваемая, pr:free — бесплатная, pr:docs — документы

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1)

/** Кнопки роликов: «Оператор линии розлива · 0:27» — ссылка на файл ролика на сайте */
function videoLinks(ctx: Ctx) {
  return practiceVideos(siteBase(ctx)).map((v) => ({ speech: v.speech, row: [link(`${v.profession} · ${v.duration}`, v.url)] as Button[] }))
}

export function paid(ctx: Ctx) {
  const roles = paidPractice.map((v) => `• ${v.title}: ${payLabel(v)}`).join('\n')
  const nights = paidPractice.filter((v) => v.payNote === NIGHT_PAY_NOTE).map((v) => lower(v.title))
  const videos = videoLinks(ctx)
  // Два сообщения: сначала деньги, срок и роли, потом что даёт компания и ролики — так легче читать с телефона
  const head =
    `**Оплачиваемая практика**\n\n` +
    `От ${paidPracticeInfo.payFrom.toLocaleString('ru-RU')} до ${formatRub(paidPracticeInfo.payTo)} в месяц до вычета налога, ` +
    `${lower(paidPracticeInfo.period)}. Отделы: ${listRu(paidPracticeInfo.units.map(lower))}.\n\n` +
    `${roles}` +
    (nights.length ? `\n\nУ ${listRu(nights.map(genitive))} ${NIGHT_PAY_NOTE}.` : '')
  const more =
    `**Что даёт компания**\n${paidPracticeInfo.benefits.map((b) => `• ${b}`).join('\n')}\n\n${paidPracticeInfo.contract}.` +
    (videos.length ? `\n\nКак выглядит смена, видно в роликах «Очаково» по кнопкам ниже.` : '')
  return reply([
    msg(head),
    msg(more, {
      buttons: [
        ...videos.map((v) => v.row),
        [btn('Бесплатная практика', 'pr:free'), btn('Документы', 'pr:docs')],
        [btn('Вакансии практики', 'v:list:0'), applyOrStatus(ctx)],
        menuRow(),
      ],
    }),
  ])
}

/** «лаборант» → «лаборанта», «оператор склада» → «оператора склада», «кладовщик» → «кладовщика» — для «У лаборанта …» */
function genitive(title: string) {
  const [first, ...rest] = title.split(' ')
  const g = /[йь]$/.test(first) ? `${first.slice(0, -1)}я` : /а$/.test(first) ? `${first.slice(0, -1)}ы` : `${first}а`
  return [g, ...rest].join(' ')
}

export function free(ctx: Ctx) {
  const text =
    `**${freePracticeInfo.title}**\n\n${freePracticeInfo.text}\n\n` +
    `**Какие бывают задачи**\n${freePracticeInfo.tasks.map((t) => `• ${t}`).join('\n')}\n\n` +
    'В заявке отметь «Практика от вуза», понадобится договор с вузом или колледжем.'
  return reply(
    msg(text, {
      buttons: [
        ...rows(freePractice.map((v) => btn(v.title, `v:open:${v.id}`)), 2),
        [btn('Оплачиваемая практика', 'm:prac'), btn('Документы', 'pr:docs')],
        [applyOrStatus(ctx)],
        menuRow(),
      ],
    }),
  )
}

export function docs(ctx: Ctx) {
  const training = phonebook.find((p) => p.id === 'training')
  const text =
    `**Документы по практике**\n\n${practiceDocs.map((d) => `• ${d.title}: ${d.who}, ${d.when}`).join('\n')}\n\n` +
    `Подготовить и распечатать документы нужно самостоятельно, а принести в Учебный центр, кабинет ${TRAINING_CENTER_ROOM}.\n\n` +
    `${handbookText('exams')}` +
    (training ? `\n\n${phoneLine(training)}.` : '')
  return reply(
    msg(text, {
      buttons: [[btn('Оплачиваемая практика', 'm:prac'), btn('Бесплатная практика', 'pr:free')], [applyOrStatus(ctx)], menuRow()],
    }),
  )
}

export function route(ctx: Ctx, parts: string[]) {
  if (parts[1] === 'free') return free(ctx)
  if (parts[1] === 'docs') return docs(ctx)
  return paid(ctx)
}
