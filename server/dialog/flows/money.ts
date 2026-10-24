import { PAY_DAYS } from '@shared/content/handbook'
import { formatRub, isPractice, netPay, payLabel, scheduleLine, shiftPay, vacancyById, type Vacancy } from '@shared/content/vacancies'
import { playButton, reply, setState, state, type Ctx } from '../context'
import { shiftLine } from '../progress'
import { btn, menuRow, monthButtons, monthList, monthsPhrase, msg, plural, toggle } from '../ui'
import { remindRows } from './remind'

// «Собери лето»: выбираешь работу и месяцы — считаем заработок.
// Роли — те же, что в «Собери лето» на сайте: графики 2/2 с суммой из источника (shiftPay), чтобы была строка «за смену».
// Суммы оплачиваемой практики — «Описание практики» «Очаково», работы — вакансии «Очаково» на hh.ru (shared/content/vacancies.ts)

/** Роли с суммой из источника; индекс — в action «mo:r:<индекс>» */
export const roles: readonly string[] = ['fermentation-assistant', 'lab-chemist', 'store-worker']
const KEY = 'money'
type MoneyState = { role: number; months: number[] }

/** Роль по индексу; несуществующий id в данных — первая роль, которая есть */
function roleVacancy(index: number): Vacancy {
  return vacancyById(roles[index] ?? '') ?? roles.map((id) => vacancyById(id)).find((v) => v !== undefined)!
}

/** Роли, которые есть в данных: кнопки не ведут в пустоту, если вакансию убрали */
const liveRoles = () => roles.flatMap((id, i) => (vacancyById(id)?.pay ? [i] : []))

/**
 * Месяцы для выбора. Оплачиваемая практика идёт с марта или апреля до июля или середины августа — сентября в ней нет;
 * работа — весь сезон, с марта по сентябрь
 */
const allowedMonths = (v: Vacancy) => (isPractice(v) ? [3, 4, 5, 6, 7, 8] : [3, 4, 5, 6, 7, 8, 9])
/** Что отмечено сразу: у практики — апрель — июль, общая часть любого её срока; у работы — лето */
const defaultMonths = (v: Vacancy) => (isPractice(v) ? [4, 5, 6, 7] : [6, 7, 8])

function totals(v: Vacancy, months: number[]) {
  const pay = v.pay!
  const n = months.length
  const from = pay.from * n
  const range = pay.to ? `${from.toLocaleString('ru-RU')}–${formatRub(pay.to * n)}` : `от ${formatRub(from)}`
  return `${range} до вычета налога, на руки от ${formatRub(netPay(from))}`
}

/**
 * «≈ N ₽ на руки за смену, ≈ M ₽ в час» — те же числа, что в «Собери лето» на сайте (shiftPay из shared).
 * Пусто, если у вакансии нет расчёта за смену: не 2/2 или сумма — ориентир
 */
export function perShiftLine(v: Vacancy) {
  const sp = shiftPay(v)
  return sp ? `≈ ${formatRub(sp.perShift)} на руки за смену, ≈ ${formatRub(sp.perHour)} в час.` : ''
}

const payDays = `${PAY_DAYS[0]}-го и ${PAY_DAYS[1]}-го`

export function start(ctx: Ctx) {
  // Во весь экран — тот же расчёт, что на сайте: месяцы на шкале и сумма на руки
  const full = playButton(ctx, 'Посчитать во весь экран', 'money')
  return reply(
    msg('**Собери лето**\n\nВыбери работу, и я посчитаю, сколько выйдет за сезон. Суммы взяты из данных «Очаково» и вакансий на hh.ru.', {
      buttons: [...liveRoles().map((i) => [btn(`${roleVacancy(i).title} · ${payLabel(roleVacancy(i))}`, `mo:r:${i}`)]), ...(full ? [[full]] : []), menuRow()],
    }),
  )
}

function months(ctx: Ctx, s: MoneyState, replace: boolean) {
  const v = roleVacancy(s.role)
  const n = s.months.length
  const summary = n
    ? `Выбрано: ${monthList(s.months)}, всего ${n} ${plural(n, 'месяц', 'месяца', 'месяцев')}.\nВыйдет ${totals(v, s.months)}.`
    : 'Отметь хотя бы один месяц.'
  const shift = perShiftLine(v)
  const hint = `${isPractice(v) ? 'Практика идёт с марта или апреля до конца июля или середины августа. ' : ''}Нажми на месяц, чтобы добавить или убрать.`
  const allowed = allowedMonths(v)
  setState(ctx, KEY, s)
  return reply(
    msg(
      `**${v.title}**, ${payLabel(v)} в месяц до вычета налога${v.payNote ? `, ${v.payNote}` : ''}. Зарплата ${payDays}.\n` +
        `График: ${scheduleLine(v).replace(/\.$/, '')}.${shift ? `\n${shift}` : ''}\n\n${hint}\n\n${summary}`,
      {
        replace,
        buttons: [
          ...monthButtons(s.months, 'mo:m:').map((row) => row.filter((b) => b.kind === 'action' && allowed.includes(Number(b.action.split(':')[2])))).filter((row) => row.length),
          [btn('Готово', 'mo:done'), btn('Другая работа', 'm:money')],
          menuRow(),
        ],
      },
    ),
  )
}

export function route(ctx: Ctx, parts: string[]) {
  const [, cmd, arg] = parts
  if (cmd === 'r') {
    const role = Math.min(Math.max(Number(arg) || 0, 0), roles.length - 1)
    return months(ctx, { role, months: defaultMonths(roleVacancy(role)) }, true)
  }
  const s = state<MoneyState>(ctx, KEY)
  if (!s) return start(ctx)
  if (cmd === 'm') {
    const m = Number(arg)
    if (!allowedMonths(roleVacancy(s.role)).includes(m)) return months(ctx, s, true)
    return months(ctx, { ...s, months: toggle(s.months, m) }, true)
  }
  if (cmd === 'done') {
    if (!s.months.length) return reply(months(ctx, s, true).messages, 'Отметь хотя бы один месяц')
    const v = roleVacancy(s.role)
    ctx.session.progress.money = true
    ctx.session.progress.months = [...s.months]
    setState(ctx, KEY, undefined)
    const n = s.months.length
    const shift = perShiftLine(v)
    return reply(
      msg(
        `**Собери лето: итог**\n\n${v.title}, ${monthsPhrase(s.months)}.\nЗа ${n} ${plural(n, 'месяц', 'месяца', 'месяцев')} выйдет ${totals(v, s.months)}.` +
          `${shift ? ` ${shift}` : ''} Зарплата ${payDays}, официально.\n\n${shiftLine(ctx.session.progress)}`,
        {
          replace: true,
          buttons: [
            [btn('Откликнуться на эту работу', `a:start:${v.id}`)],
            [btn('Позвать друга', 'm:friend')],
            ...remindRows(ctx),
            [btn('Другая работа', 'm:money'), btn('Меню', 'm')],
          ],
        },
      ),
    )
  }
  return start(ctx)
}
