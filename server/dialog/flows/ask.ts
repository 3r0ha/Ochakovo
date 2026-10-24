import { vacancyById } from '@shared/content/vacancies'
import { redactPersonal } from '../../assistant/guard'
import type { AssistantAction, AssistantProfile, AssistantTurn } from '../../assistant/types'
import { reply, setState, siteBase, state, type Ctx } from '../context'
import { btn, link, msg, rows } from '../ui'
import { shiftVideoForVacancy } from '../videos'
import type { Button } from '../types'
import { roles } from './money'
import { applyOrStatus } from './status'
import { TOUR_TITLE } from './tour'

// «Спросить Квасыча»: свободный текст вне сценариев уходит помощнику.
// История (последние 6 реплик) и профиль живут в session.data и переживают переход в меню.

export const ASK_KEY = 'assistant'
type AskState = { history: AssistantTurn[]; profile: AssistantProfile }

export function intro() {
  return reply(
    msg(
      '**Спросить Квасыча**\n\nНапиши вопрос своими словами: сколько платят, какой график, где жить, что делают в цехах или какая работа подойдёт под твою учёбу. ' +
        'Отвечаю по данным завода. Если чего-то не знаю, подскажу, где спросить.',
      { buttons: [[btn('Подобрать работу', 'm:quiz'), btn('Вакансии и зарплаты', 'v:list:0')], [btn('Меню', 'm')]] },
    ),
  )
}

/** Действия помощника → кнопки бота: вакансии по одной в ряд, остальные по две */
function actionButtons(ctx: Ctx, actions: AssistantAction[]): Button[][] {
  const vacancyRows: Button[][] = []
  const small: Button[] = []
  for (const a of actions) {
    switch (a.type) {
      case 'open_vacancy': {
        const v = vacancyById(a.vacancyId)
        if (v && vacancyRows.length < 3) vacancyRows.push([btn(v.title, `v:open:${v.id}`)])
        break
      }
      case 'calc_earnings': {
        const i = a.vacancyId ? roles.indexOf(a.vacancyId) : -1
        small.push(i >= 0 ? btn('Посчитать за лето', `mo:r:${i}`) : btn('Собери лето', 'm:money'))
        break
      }
      case 'start_application':
        small.push(applyOrStatus(ctx, 'Откликнуться', a.vacancyId && vacancyById(a.vacancyId) ? `a:start:${a.vacancyId}` : 'm:apply'))
        break
      case 'start_quiz':
        small.push(btn('Подобрать работу', 'm:quiz'))
        break
      case 'open_vacancies':
        // Ответ про одну вакансию — кнопка ведёт к остальным
        small.push(btn(actions.some((x) => 'vacancyId' in x && x.vacancyId) ? 'Другие вакансии' : 'Все вакансии', 'v:list:0'))
        break
      case 'start_tour':
        small.push(btn(TOUR_TITLE, a.stage !== undefined ? `t:${a.stage}` : 'm:tour'))
        break
      case 'start_game':
        small.push(btn('Поймай брак', 'm:game'))
        break
    }
  }
  const unique = small.filter((b, i) => b.kind === 'action' && small.findIndex((x) => x.kind === 'action' && x.action === b.action) === i)
  // Ответ про одну вакансию с роликом — «Посмотреть смену» ссылкой на файл с сайта
  const one = actions.filter((a) => a.type === 'open_vacancy')
  const video = one.length === 1 && one[0].type === 'open_vacancy' ? shiftVideoForVacancy(one[0].vacancyId, siteBase(ctx)) : null
  return [...vacancyRows, ...(video ? [[link(`Посмотреть смену · ${video.duration}`, video.url)]] : []), ...rows(unique.slice(0, 4), 2)]
}

/** Вопрос про практику или стажировку — кнопки разделов практики: суммы, ролики, задачи и документы там */
const aboutPractice = (text: string) => /практик|стажир|стажёр|от вуза|от колледжа/i.test(text)

export async function answer(ctx: Ctx, text: string) {
  const s = state<AskState>(ctx, ASK_KEY) ?? { history: [], profile: {} }
  const r = await ctx.assistant.answer({
    question: text,
    history: s.history,
    profile: s.profile,
    sessionId: `${ctx.user.channel}-${ctx.user.id}`,
    channel: ctx.user.channel,
  })
  const history: AssistantTurn[] = [
    ...s.history,
    { role: 'user' as const, text: redactPersonal(text).slice(0, 500) },
    { role: 'assistant' as const, text: r.text.slice(0, 600) },
  ].slice(-6)
  setState<AskState>(ctx, ASK_KEY, { history, profile: r.profile ?? s.profile })

  const actions = actionButtons(ctx, r.actions)
  const practice = aboutPractice(text) ? [[btn('Оплачиваемая практика', 'm:prac'), btn('Бесплатная практика', 'pr:free')]] : []
  const fallback = actions.length || practice.length ? [] : [[btn('Вакансии и зарплаты', 'v:list:0'), btn('Подобрать работу', 'm:quiz')]]
  return reply(msg(r.text, { buttons: [...practice, ...actions, ...fallback, [btn('Меню', 'm')]] }))
}
