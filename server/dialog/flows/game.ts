import { PLANT_BOTTLES_PER_HOUR } from '@shared/content/production'
import { formatRub, vacancyById } from '@shared/content/vacancies'
import { playButton, reply, setState, siteBase, state, type Ctx } from '../context'
import { gameRoundImage, type DefectKind } from '../images'
import { shiftLine } from '../progress'
import { btn, link, menuRow, msg, plural, rows } from '../ui'
import { remindRows } from './remind'
import type { DialogReply, OutMessage } from '../types'

// «Поймай брак» в чате: 5 раундов, в каждом одна бутылка с браком.
// Раунды 1–2 — четыре бутылки и явный брак, раунды 3–5 — шесть бутылок и брак тоньше.
// Названия брака — как в игре на сайте: «Без крышки», «Недолив», «Кривая этикетка»

const KEY = 'game'
const ROUNDS = 5
const kinds: DefectKind[] = ['nocap', 'lowfill', 'label']
const defectName: Record<DefectKind, string> = { nocap: 'без крышки', lowfill: 'недолив', label: 'кривая этикетка' }
const subtleName: Record<DefectKind, string> = { nocap: 'без крышки', lowfill: 'недолив', label: 'этикетка чуть съехала' }

type Round = { at: number; kind: DefectKind; count: 4 | 6; subtle: boolean }
type GameState = { round: number; score: number; rounds: Round[] }

function randomRounds(random: () => number): Round[] {
  return Array.from({ length: ROUNDS }, (_, i) => {
    const hard = i >= 2
    const count = hard ? 6 : 4
    return { at: Math.floor(random() * count), kind: kinds[Math.floor(random() * kinds.length)], count, subtle: hard }
  })
}

const nameOf = (r: Round) => (r.subtle ? subtleName : defectName)[r.kind]

/** Сколько бутылок прошло мимо за всю игру: сумма бутылок всех раундов */
const bottlesSeen = (rounds: Round[]) => rounds.reduce((sum, r) => sum + (r.count ?? 4), 0)

export function intro(ctx: Ctx) {
  // В мессенджере есть и живая лента, как на сайте: 20 секунд, бутылки едут, брак ловят нажатием
  const full = playButton(ctx, 'Живая лента во весь экран', 'game')
  return reply(
    msg(
      '**Поймай брак**\n\nПять раундов, в каждом одна бутылка с браком: без крышки, недолив или кривая этикетка. ' +
        'В первых двух раундах четыре бутылки и брак видно сразу, дальше шесть бутылок, и брак тоньше. Нажми номер бутылки с браком.' +
        (full ? '\n\nМожно сыграть и на живой ленте, как на сайте: 20 секунд, бутылки едут сами.' : ''),
      { buttons: [[btn('Начать', 'g:go')], ...(full ? [[full]] : []), menuRow()] },
    ),
  )
}

/** Картинку раунда нарисовать не вышло — без неё брак не разглядеть, зовём в игру на сайте */
function noImage(ctx: Ctx): DialogReply {
  return reply(
    msg('Картинки раундов сейчас не загружаются, а без них брак не разглядеть. Сыграть можно на сайте, там та же лента с бутылками.', {
      buttons: [[playButton(ctx, 'Играть во весь экран', 'game') ?? link('Играть на сайте', `${siteBase(ctx)}/game?src=${ctx.user.channel}`)], menuRow()],
    }),
  )
}

async function roundMessage(s: GameState): Promise<OutMessage | null> {
  const r = s.rounds[s.round]
  const path = await gameRoundImage(r.at, r.kind, r.count, r.subtle)
  if (!path) return null
  const hint = r.subtle && s.round === 2 ? '\nТеперь шесть бутылок, и брак тоньше. Присмотрись.' : ''
  const numbers = Array.from({ length: r.count }, (_, i) => btn(String(i + 1), `g:${s.round}:${i + 1}`))
  return msg(`**Раунд ${s.round + 1} из ${ROUNDS}**\nНажми номер бутылки с браком.${hint}`, {
    image: { path },
    buttons: rows(numbers, r.count === 4 ? 2 : 3),
  })
}

async function showRound(ctx: Ctx, s: GameState, before: OutMessage[] = [], notice?: string): Promise<DialogReply> {
  const round = await roundMessage(s)
  if (!round) {
    setState(ctx, KEY, undefined)
    return reply([...before, ...noImage(ctx).messages], notice)
  }
  return reply([...before, round], notice)
}

export async function go(ctx: Ctx) {
  const s: GameState = { round: 0, score: 0, rounds: randomRounds(ctx.random) }
  setState(ctx, KEY, s)
  return showRound(ctx, s)
}

/** Итог по числу пойманных: честно и без снисходительности */
function verdict(score: number) {
  const line = vacancyById('bottling-operator')
  if (score === ROUNDS) {
    const pay = line?.pay ? ` ${line.title} на оплачиваемой практике получает от ${formatRub(line.pay.from)} в месяц до вычета налога.` : ''
    return `Пять из пяти, включая тонкий брак. Так работает контроль на линии розлива.${pay}`
  }
  if (score >= 3) return 'Хороший результат. Тонкий брак в последних раундах замечают с опытом, на линии этому учит наставник.'
  return 'Последние раунды сложные: брак там видно не сразу. На линии этому учит наставник в первые смены.'
}

/** Масштаб завода: сколько бутылок прошло в игре и сколько разливает завод за час */
export function scaleLine(seen: number) {
  return `За ${ROUNDS} раундов мимо тебя ${plural(seen, 'прошла', 'прошли', 'прошло')} ${seen} ${plural(seen, 'бутылка', 'бутылки', 'бутылок')}. Завод разливает до ${PLANT_BOTTLES_PER_HOUR.toLocaleString('ru-RU')} бутылок в час.`
}

export async function route(ctx: Ctx, parts: string[]) {
  if (parts[1] === 'go') return go(ctx)
  const s = state<GameState>(ctx, KEY)
  if (!s) return intro(ctx)

  const round = Number(parts[1])
  const pickNumber = Number(parts[2])
  if (round !== s.round) return showRound(ctx, s, [], 'Этот раунд уже сыгран')

  const r = s.rounds[round]
  // Сессии, начатые до появления шести бутылок, хранят раунды без count
  const count = r.count ?? 4
  if (!Number.isInteger(pickNumber) || pickNumber < 1 || pickNumber > count) return showRound(ctx, s)
  const correct = pickNumber - 1 === r.at
  const feedback = correct ? `Верно, бутылка ${r.at + 1}: ${nameOf(r)}.` : `Мимо, брак у бутылки ${r.at + 1}: ${nameOf(r)}.`
  const next: GameState = { ...s, round: s.round + 1, score: s.score + (correct ? 1 : 0) }

  if (next.round < ROUNDS) {
    setState(ctx, KEY, next)
    return showRound(ctx, next, [msg(feedback)])
  }

  setState(ctx, KEY, undefined)
  ctx.session.progress.game = Math.max(ctx.session.progress.game ?? 0, next.score)
  return reply([
    msg(feedback),
    msg(`**Поймано ${next.score} из ${ROUNDS}**\n${verdict(next.score)}\n\n${scaleLine(bottlesSeen(s.rounds))}\n\n${shiftLine(ctx.session.progress)}`, {
      buttons: [[btn('Сыграть ещё', 'g:go'), btn('Откликнуться на линию', 'a:start:bottling-operator')], [btn('Позвать друга', 'm:friend')], ...remindRows(ctx), menuRow()],
    }),
  ])
}
