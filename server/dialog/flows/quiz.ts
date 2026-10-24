import { quiz, scoreQuiz } from '@shared/content/quiz'
import { vacancyById } from '@shared/content/vacancies'
import { reply, setState, state, type Ctx } from '../context'
import { shiftLine } from '../progress'
import { btn, menuRow, msg } from '../ui'
import { card } from './vacancies'

// Подбор работы — те же вопросы, что на сайте. Вопрос меняется в том же сообщении

const KEY = 'quiz'

function question(picks: number[], replace: boolean) {
  const step = picks.length
  const q = quiz[step]
  return reply(
    msg(`**Подбор работы · вопрос ${step + 1} из ${quiz.length}**\n\n${q.text}`, {
      replace,
      buttons: [...q.answers.map((a, i) => [btn(a.text, `q:${step}:${i}`)]), [btn('Отмена', 'x')]],
    }),
  )
}

export function start(ctx: Ctx) {
  setState<number[]>(ctx, KEY, [])
  return question([], false)
}

export function answer(ctx: Ctx, step: number, index: number) {
  const picks = state<number[]>(ctx, KEY) ?? []
  // Нажали кнопку из старого сообщения — показываем текущий вопрос заново
  if (step !== picks.length || !quiz[step]?.answers[index]) {
    if (picks.length >= quiz.length) return start(ctx)
    return question(picks, false)
  }
  const next = [...picks, index]
  if (next.length < quiz.length) {
    setState(ctx, KEY, next)
    return question(next, true)
  }

  setState(ctx, KEY, undefined)
  const id = scoreQuiz(next.map((a, s) => quiz[s].answers[a]))
  const v = vacancyById(id)
  if (!v) return start(ctx)
  ctx.session.progress.quiz = v.id
  return reply(
    msg(`**Тебе подойдёт**\n\n${card(v)}\n\n${shiftLine(ctx.session.progress)}`, {
      replace: true,
      buttons: [[btn('Откликнуться на эту вакансию', `a:start:${v.id}`)], [btn('Пройти заново', 'm:quiz'), btn('Все вакансии', 'v:list:0')], menuRow()],
    }),
  )
}

export function route(ctx: Ctx, parts: string[]) {
  return answer(ctx, Number(parts[1]), Number(parts[2]))
}
