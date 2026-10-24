import {
  COMPANY_QUIZ_PASS,
  COMPANY_QUIZ_REWARD,
  COMPANY_QUIZ_ROUND,
  companyQuizById,
  companyQuizPassed,
  companyQuizResult,
  companyQuizRewardWhere,
  companyQuizRound,
  type CompanyQuizQuestion,
} from '@shared/content/companyQuiz'
import { playButton, reply, setState, state, type Ctx } from '../context'
import { btn, menuRow, msg, rows } from '../ui'
import type { Button } from '../types'
import { remindRows } from './remind'
import { applyOrStatus } from './status'

// «Что ты знаешь об „Очаково“» — контрольные вопросы на знание компании, те же, что на сайте (shared/content/companyQuiz.ts).
// Раунд — 7 случайных вопросов, варианты перемешаны. Ответ — сразу объяснение и источник, в итоге — счёт и путь к практике.
// Кнопки: cq:<id вопроса>:<исходный номер варианта> — старая кнопка не ответит за другой вопрос; cq:next — следующий.
// В «Смену» не входит: смена — четыре задания, как на сайте. Лучший счёт хранится в прогрессе

export const TITLE = 'Что ты знаешь об «Очаково»'

const KEY = 'cq'
type CqState = {
  /** id вопросов раунда */
  ids: string[]
  /** Исходные номера вариантов в порядке показа — для каждого вопроса */
  orders: number[][]
  i: number
  score: number
  /** Ответ на текущий вопрос уже дан — ждём «Дальше» */
  answered?: boolean
}

/** Длинные варианты не помещаются в кнопку мессенджера: тогда варианты — списком в тексте, на кнопках номера */
const BUTTON_TEXT_MAX = 30

function questionMessage(s: CqState, replace = false) {
  const q = companyQuizById(s.ids[s.i])!
  const order = s.orders[s.i]
  const options = order.map((orig) => q.options[orig])
  const head = `**${TITLE} · ${s.i + 1} из ${s.ids.length}**\n\n${q.question}`
  const long = options.some((o) => o.length > BUTTON_TEXT_MAX)
  // Номера — не больше трёх в ряду, четыре — по два, как месяцы и номера бутылок
  const buttons: Button[][] = long
    ? rows(order.map((orig, k) => btn(String(k + 1), `cq:${q.id}:${orig}`)), order.length === 4 ? 2 : 3)
    : order.map((orig) => [btn(q.options[orig], `cq:${q.id}:${orig}`)])
  const list = long ? `\n\n${options.map((o, k) => `${k + 1}. ${o}`).join('\n')}` : ''
  return msg(`${head}${list}`, { buttons: [...buttons, [btn('Отмена', 'x')]], ...(replace ? { replace } : {}) })
}

/** Сессия из прошлой версии или с вопросом, которого больше нет, — начинаем раунд заново */
const valid = (s: CqState | undefined): s is CqState =>
  Boolean(s && Array.isArray(s.ids) && s.ids.length && s.ids.every((id) => companyQuizById(id)) && Array.isArray(s.orders) && s.i >= 0 && s.i < s.ids.length)

export function start(ctx: Ctx) {
  const round = companyQuizRound(ctx.random, COMPANY_QUIZ_ROUND)
  const s: CqState = { ids: round.map((q) => q.id), orders: round.map((q) => q.order), i: 0, score: 0 }
  setState<CqState>(ctx, KEY, s)
  const full = playButton(ctx, 'Викторина во весь экран', 'company')
  const promise = `Ответь верно на ${COMPANY_QUIZ_PASS} из ${COMPANY_QUIZ_ROUND}, и получишь ${COMPANY_QUIZ_REWARD}. Результат попадёт в заявку.`
  return reply([msg(promise, full ? { buttons: [[full]] } : {}), questionMessage(s)])
}

function explain(q: CompanyQuizQuestion, correct: boolean) {
  return `${correct ? 'Верно' : 'Мимо'}. ${q.explain}\n\nИсточник: ${q.source}.`
}

export function route(ctx: Ctx, parts: string[]) {
  const s = state<CqState>(ctx, KEY)
  if (!valid(s)) return start(ctx)
  if (parts[1] === 'next') {
    if (!s.answered) return reply(questionMessage(s))
    const next: CqState = { ...s, i: s.i + 1, answered: false }
    setState(ctx, KEY, next)
    return reply(questionMessage(next))
  }

  const id = parts[1]
  const q = companyQuizById(s.ids[s.i])!
  if (id !== q.id || s.answered) return reply(questionMessage(s), 'Этот вопрос уже позади')
  const correct = Number(parts[2]) === q.answer
  const next: CqState = { ...s, score: s.score + (correct ? 1 : 0), answered: true }

  if (next.i + 1 < next.ids.length) {
    setState(ctx, KEY, next)
    return reply(msg(explain(q, correct), { buttons: [[btn('Дальше', 'cq:next')]] }))
  }

  setState(ctx, KEY, undefined)
  ctx.session.progress.companyQuiz = Math.max(ctx.session.progress.companyQuiz ?? 0, next.score)
  return reply([
    msg(explain(q, correct)),
    msg(`**Итог**\n${companyQuizResult(next.score, next.ids.length)}${companyQuizPassed(next.score, next.ids.length) ? `\n\n${companyQuizRewardWhere('message')}` : ''}`, {
      buttons: [[btn('Оплачиваемая практика', 'm:prac'), applyOrStatus(ctx)], [btn('Сыграть ещё раз', 'm:cq'), btn('Позвать друга', 'm:friend')], ...remindRows(ctx), menuRow()],
    }),
  ])
}
