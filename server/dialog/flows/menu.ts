import { paidPracticeInfo } from '@shared/content/practice'
import { formatRub, maxEntryPay, minMonthlyPay } from '@shared/content/vacancies'
import { reply, siteBase, siteLink, withImage, type Ctx } from '../context'
import { photoJpeg } from '../images'
import { isDone, listRu, progressText, shiftStatus, tasks } from '../progress'
import { btn, link, menuRow, msg, rows } from '../ui'
import type { OutMessage } from '../types'
import { TITLE as COMPANY_QUIZ_TITLE } from './companyQuiz'
import { remindRows } from './remind'
import { applyOrStatus } from './status'

/** «от 56 000 до 70 000 ₽» — вилка оплачиваемой практики из shared */
const practicePay = () => `от ${minMonthlyPay.toLocaleString('ru-RU')} до ${formatRub(maxEntryPay)}`

export function menuMessage(ctx: Ctx, lead = 'Выбери, с чего начать, или задай вопрос своими словами.'): OutMessage {
  return msg(`${lead}\n\n${shiftStatus(ctx.session.progress, ctx.hasApplication)}`, {
    buttons: [
      [btn('Практика', 'm:prac'), btn('Вакансии и зарплаты', 'm:vac')],
      [btn('Подобрать работу', 'm:quiz'), btn('Собери лето', 'm:money')],
      [btn('Поймай брак', 'm:game'), btn('Правда или миф', 'm:myth')],
      [btn('Путь кваса', 'm:tour'), btn('Спросить Квасыча', 'm:ask')],
      [btn(COMPANY_QUIZ_TITLE, 'm:cq')],
      // Внутри сайта ссылка на сайт не нужна
      ctx.user.channel === 'web' ? [btn('Позвать друга', 'm:friend'), applyOrStatus(ctx)] : [btn('Позвать друга', 'm:friend'), applyOrStatus(ctx), link('Сайт', siteLink(ctx))],
      // «Напомнить о наборе» — без заявки; подписанному — «Не присылать о наборе»
      ...remindRows(ctx, true),
    ],
  })
}

export async function start(ctx: Ctx) {
  // На сайте чат маленький: две строки и три главных действия, полное меню — по кнопке «Ещё»
  if (ctx.user.channel === 'web') {
    return reply(
      msg(
        'Привет, я Квасыч, бот «Очаково». Расскажу про практику и работу на заводе.\n' +
          `На оплачиваемой практике платят ${practicePay()} в месяц до вычета налога, учит наставник. Задай вопрос или выбери раздел.`,
        {
          buttons: [
            [btn('Вакансии', 'm:vac'), btn('Подобрать работу', 'm:quiz')],
            [applyOrStatus(ctx), btn('Ещё', 'm')],
          ],
        },
      ),
    )
  }
  const units = listRu(paidPracticeInfo.units.map((u) => u.charAt(0).toLowerCase() + u.slice(1)))
  const greeting = msg(
    'Привет, я Квасыч, бот завода «Очаково» в Москве. Расскажу про практику и работу и приму заявку.\n\n' +
      `На оплачиваемой практике платят ${practicePay()} в месяц до вычета налога. Отделы: ${units}. ` +
      'К каждому новичку прикрепляют наставника, испытательного срока у студентов нет.',
    withImage(await photoJpeg('excursion')),
  )
  return reply([greeting, menuMessage(ctx, 'Выбери раздел или задай вопрос своими словами.')])
}

export const menu = (ctx: Ctx, notice?: string) => reply(menuMessage(ctx), notice)

/** «Сколько заданий я прошёл?» — «Смена N/4» и кнопки к оставшимся: в боте — разделы, на сайте — блоки главной */
export function progress(ctx: Ctx) {
  const p = ctx.session.progress
  const left = tasks.filter((t) => !isDone(p, t.key))
  const base = siteBase(ctx)
  const toTask = (t: (typeof tasks)[number]) => (ctx.user.channel === 'web' ? link(t.label, `${base}/${t.anchor}`) : btn(t.label, t.action))
  const buttons = left.length ? rows(left.map(toTask), 2) : [[applyOrStatus(ctx)]]
  return reply(msg(progressText(p), { buttons: [...buttons, menuRow()] }))
}

export const help = (ctx: Ctx) =>
  reply(menuMessage(ctx, 'Номер пригодится в заявке, нажми «Откликнуться». Вопросы можно писать своими словами.'))
