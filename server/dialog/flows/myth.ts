import { buildDeck, myths, type MythCard } from '@shared/content/content'
import { reply, setState, state, withImage, type Ctx } from '../context'
import { photoJpeg } from '../images'
import { shiftLine } from '../progress'
import { btn, menuRow, msg } from '../ui'
import { remindRows } from './remind'

// «Правда или миф»: колода из общей с сайтом (buildDeck) — карточки про работу и про историю завода.
// В состоянии — id карточек колоды, кнопки «my:<id>:t|f»: кнопка из прошлой игры не ответит за чужую карточку

const KEY = 'myth'
type MythState = {
  deck: string[]
  i: number
  score: number
  /** Последняя карточка с ошибкой — её факт в итоге */
  missed?: string
}

const cardById = (id: string | undefined): MythCard | undefined => myths.find((m) => m.id === id)

async function cardMessage(s: MythState) {
  const m = cardById(s.deck[s.i])!
  return msg(`**Правда или миф · ${s.i + 1} из ${s.deck.length}**\n\n${m.claim}`, {
    ...(m.photo ? withImage(await photoJpeg(m.photo)) : {}),
    buttons: [[btn('Правда', `my:${m.id}:t`), btn('Миф', `my:${m.id}:f`)]],
  })
}

/** Колода из прошлой версии бота хранила номера карточек, а не id — такую игру начинаем заново */
const validState = (s: MythState | undefined): s is MythState =>
  Boolean(s && Array.isArray(s.deck) && s.deck.length && s.deck.every((id) => cardById(id)) && s.i >= 0 && s.i < s.deck.length)

export async function start(ctx: Ctx) {
  const s: MythState = { deck: buildDeck(ctx.random).map((m) => m.id), i: 0, score: 0 }
  setState<MythState>(ctx, KEY, s)
  return reply(await cardMessage(s))
}

export async function route(ctx: Ctx, parts: string[]) {
  const s = state<MythState>(ctx, KEY)
  if (!validState(s)) return start(ctx)
  if (parts[1] === 'next') return reply(await cardMessage(s))

  const id = parts[1]
  if (id !== s.deck[s.i]) return reply(await cardMessage(s), 'Этот вопрос уже позади')

  const m = cardById(id)!
  const guess = parts[2] === 't'
  const correct = guess === m.truth
  const next: MythState = { ...s, i: s.i + 1, score: s.score + (correct ? 1 : 0), missed: correct ? s.missed : m.id }
  // У мифа сначала то, что на самом деле: иначе утверждение из вопроса остаётся в памяти как правда
  const verdict = m.truth
    ? `${correct ? 'Верно' : 'Мимо'}: это правда.\n\n${m.explain}`
    : `${correct ? 'Верно' : 'Мимо'}: это миф. На самом деле: **${m.fact.replace(/\.$/, '')}**.\n\n${m.explain}`

  if (next.i < next.deck.length) {
    setState(ctx, KEY, next)
    return reply(msg(verdict, { buttons: [[btn('Дальше', 'my:next')]] }))
  }

  setState(ctx, KEY, undefined)
  ctx.session.progress.myth = Math.max(ctx.session.progress.myth ?? 0, next.score)
  const missed = cardById(next.missed)
  // Итог — факт из карточки, где ошибка была последней; без ошибок — так и пишем
  const line = missed ? `Теперь знаешь, что ${missed.takeaway}.` : 'Без единой ошибки.'
  return reply([
    msg(verdict),
    msg(`**Итог: ${next.score} из ${next.deck.length}**\n${line}\n\n${shiftLine(ctx.session.progress)}`, {
      buttons: [[btn('Сыграть ещё раз', 'm:myth'), btn('Путь кваса', 'm:tour')], [btn('Позвать друга', 'm:friend')], ...remindRows(ctx), menuRow()],
    }),
  ])
}
