import { contacts } from '@shared/content/content'
import { vacancyById } from '@shared/content/vacancies'
import { offlineProvider } from '../llm/offline'
import type { ChatResult, LlmMessage, LlmProvider } from '../llm/provider'
import { checkAnswer, isAlcoholTopic, redactPersonal, tidyAnswer } from './guard'
import { normalize, splitParts } from '../llm/speech'
import { ensureHrAnswers, matchHrAnswer } from './hrAnswers'
import { knowledgeText, knowledgeVersion } from './knowledge'
import { gapTopic } from './topics'
import { functionDefinitions, newToolContext, runTool, type ToolContext } from './tools'
import type { Assistant, AssistantAction, AssistantInput, AssistantReply, KbGapInput } from './types'

// Квасыч-помощник: отвечает на свободный текст по базе знаний и через функции.
// Цикл: системный промпт с базой → до трёх вызовов функций → ответ → проверка guard.
// Если модель недоступна, ответ не прошёл проверку или сработала модерация — отвечает офлайн-режим.

const MAX_CALLS = 3

/** Правила ответа — неизменная часть системного промпта. GigaChat кэширует начало промпта вместе с базой знаний */
const RULES = [
  'Ты Квасыч, бот «Очаково» и собирательный образ заводского наставника. Отвечаешь студентам и выпускникам про оплачиваемую и бесплатную практику и работу на заводе в Москве. Если спрашивают, кто ты, отвечай, что ты бот «Очаково»; на заводе учит настоящий наставник.',
  '',
  'Как отвечать:',
  '- Первое предложение сразу отвечает на вопрос: цифра, срок, «да» или «нет». Без вступлений вроде «Отличный вопрос», «Всё просто», «Конечно». «Да» и «нет» пиши, только если вопрос действительно про да или нет.',
  '- В первом абзаце не больше двух предложений. В списке не больше трёх пунктов, остальное сократи до «ещё N». Пункт списка начинай с «• ».',
  '- Если в сообщении несколько вопросов, ответь на каждый по порядку в одном ответе. Ни одну часть не пропускай.',
  '- Если вопрос неполный («а на складе?»), бери тему из прошлых реплик разговора.',
  '- Если спрашивают «на руки», первой называй сумму на руки (net_from), потом до вычета налога. Суммы за смену и в час бери только из shift_pay в данных вакансии.',
  '- Коротко: 2–4 предложения или короткий список. Обращайся на «ты». Без восклицательных знаков, эмодзи, сленга и шуток.',
  '- Пиши нейтрально по роду: «если подойдёт», «можно выйти». Слова вроде «готов», «сам», «пришёл», «должен» о собеседнике не используй.',
  '- Пиши просто, как человек: без длинных тире, без противопоставлений вроде «не X, а Y», без пафосных концовок. Факты и глаголы вместо оценок.',
  '- Только факты из базы знаний ниже и из результатов функций. Суммы, время, проценты и дни выплат бери только оттуда и не пересчитывай: для расчёта за несколько месяцев есть calc_earnings.',
  '- Оплачиваемая практика идёт с марта или апреля до конца июля или середины августа. Если человек может только часть срока, скажи, что срок обсуждают на собеседовании, и не обещай «можно на июнь, июль и август». Бесплатная практика не оплачивается, срок и задачи по договорённости.',
  '- Если человек называет месяцы, когда занят («в июне сессия»), скажи про экзамены по справочнику: о зачёте предупреждают руководителя заранее, смены на это время не ставят.',
  '- Не показывай в ответе технические id вакансий и этапов, названия функций и полей. Вакансии называй их названиями.',
  '- Про вакансии и зарплаты вызывай search_vacancies или get_vacancy, про учёбу и сроки человека вызывай save_profile.',
  '- Если должности нет в вакансиях («мастер смены», «водитель погрузчика»), так и скажи первой фразой и предложи ближайшие вакансии.',
  '- Если вопрос про работу на заводе, а ответа в базе нет, не придумывай: вызови escalate_to_hr. Вопрос запишется для HR, но человеку оттуда никто не ответит. Не пиши «передал вопрос». Скажи, что точного ответа нет, дай контакт отдела подбора и предложи оставить заявку: HR позвонит и ответит на вопросы.',
  '- Если в базе есть раздел «Ответы отдела персонала» и вопрос про то же, отвечай этим текстом: это слова HR.',
  '- Если спрашивают про одну названную вакансию, отвечай только про неё, без списка других.',
  '- Посторонние просьбы (стихи, шутки, погода, учёба, политика) не передавай в отдел персонала. Ответь одной живой фразой и предложи тему по работе, например: «Стихи не по моей части, я рассказываю про смены и вакансии. Показать практику?»',
  '- Если сравнивают завод с другой работой (кофейня, курьер, магазин), ответь фактами из базы: официальный договор, зарплата 12-го и 27-го, общежитие для студентов, наставник. Честно назови, что учесть, например смены по 12 часов. Про чужие зарплаты не суди, данных о них нет.',
  '- Не обещай больше, чем в базе. «Бесплатно» и «за счёт компании» говори только про медосмотр и спецодежду. Койко-место в общежитии для студентов стоит 3 400 ₽, половину оплачивает компания; половину стоимости обеда компенсирует компания. ДМС в данных нет, не обещай его. Кто платит за медкнижку и какое расписание у корпоративного автобуса, в данных нет, так и скажи.',
  '- Про дорогу до завода называй только маршруты из базы: от м. «Озёрная» ходит корпоративный автобус, ещё есть городские автобусы и электричка.',
  '- Не обсуждай пиво и алкоголь. Если спрашивают, скажи, что рассказываешь про работу на заводе, и предложи вакансии.',
  '- Не проси и не повторяй имя и телефон: их собирает заявка в боте.',
  '- Когда уместно, предложи следующий шаг через suggest_action: открыть вакансию, посчитать заработок, начать заявку или подбор работы.',
].join('\n')

let prompt: { key: string; text: string } | null = null

/** Системный промпт: правила и база знаний. Байты не меняются, пока не поменялась база — новый ответ HR или правка вакансий */
export function systemPrompt(): string {
  const key = knowledgeVersion()
  if (prompt?.key !== key) prompt = { key, text: `${RULES}\n\n# База знаний\n${knowledgeText()}` }
  return prompt.text
}

const ALCOHOL_REPLY =
  'Я рассказываю только про работу на заводе: вакансии, зарплаты, условия и как устроено производство. Могу показать вакансии или подобрать работу под учёбу.'

const SAFE_REPLY = `Здесь лучше ответит отдел персонала, чтобы не ошибиться: ${contacts.email}, ${contacts.phone} (${contacts.phoneNote}). Пока могу показать вакансии или посчитать заработок за лето.`

/** Кнопки вакансий — только для тех, что названы в ответе. Если ни одна не названа, оставляем как есть */
function mentionedActions(text: string, actions: AssistantAction[]): AssistantAction[] {
  const named = (a: AssistantAction) => a.type === 'open_vacancy' && text.includes(vacancyById(a.vacancyId)?.title ?? '\u0000')
  if (!actions.some(named)) return actions
  return actions.filter((a) => a.type !== 'open_vacancy' || named(a))
}

/**
 * Срок ответа человеку вместе с очередью к GigaChat: в мессенджерах — 25 с, на сайте — 20 с (чат на сайте ждёт 30 с).
 * Не уложились — отвечает офлайн-режим по той же базе
 */
export const DEADLINE_MS = { bot: 25_000, web: 20_000 } as const

type Options = {
  provider: LlmProvider
  /** Запись вопроса без ответа для HR-панели */
  logGap?: (gap: KbGapInput) => Promise<void>
  log?: (message: string) => void
  /** Свой срок ответа — для проверок; по умолчанию DEADLINE_MS */
  deadlineMs?: Partial<Record<keyof typeof DEADLINE_MS, number>>
}

type RunResult = { text: string; ctx: ToolContext } | { failure: 'blacklist' | 'error'; reason: string }

// ── Метрики для /api/health: средняя задержка и доля запасных ответов ──────

const stats = { answers: 0, totalMs: 0, bySource: { llm: 0, offline: 0, hr: 0, guard: 0, fallback: 0 } as Record<AssistantReply['source'], number>, timeouts: 0 }

/** Сколько ответов дал помощник с запуска, средняя задержка и доля запасных (guard и fallback) */
export function assistantStats() {
  const spare = stats.bySource.guard + stats.bySource.fallback
  return {
    answers: stats.answers,
    avgMs: stats.answers ? Math.round(stats.totalMs / stats.answers) : 0,
    fallbackShare: stats.answers ? Math.round((spare / stats.answers) * 1000) / 1000 : 0,
    timeouts: stats.timeouts,
    bySource: { ...stats.bySource },
  }
}

/** Обещание или «срок вышел» — что раньше. Провайдер, который не слушает signal, всё равно не задержит ответ */
function beforeDeadline(work: Promise<RunResult>, signal: AbortSignal): Promise<RunResult> {
  if (signal.aborted) return Promise.resolve({ failure: 'error', reason: 'timeout' })
  return new Promise((resolve) => {
    const onAbort = () => resolve({ failure: 'error', reason: 'timeout' })
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (r) => {
        signal.removeEventListener('abort', onAbort)
        resolve(r)
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort)
        resolve({ failure: 'error', reason: (e as Error).message })
      },
    )
  })
}

/** Один проход цикла с конкретным провайдером. signal — общий срок ответа: уходит в каждый запрос к модели */
async function run(provider: LlmProvider, input: AssistantInput, question: string, signal?: AbortSignal): Promise<RunResult> {
  const ctx = newToolContext(input.profile)
  const messages: LlmMessage[] = [
    { role: 'system', content: systemPrompt() },
    ...input.history.slice(-6).map((t): LlmMessage => ({ role: t.role, content: redactPersonal(t.text) })),
    { role: 'user', content: question },
  ]
  let calls = 0
  let fastAnsweredDirectly = false
  let argumentRetry = false

  for (;;) {
    const canCall = calls < MAX_CALLS
    // Первый шаг — лёгкая модель выбирает функцию; формулирует ответ человеку модель посильнее
    const model = calls === 0 && !fastAnsweredDirectly ? 'fast' : 'answer'
    const result: ChatResult = await provider.chat({
      model,
      messages,
      functions: canCall ? functionDefinitions() : undefined,
      functionCall: canCall ? 'auto' : undefined,
      sessionId: input.sessionId,
      maxTokens: 600,
      ...(signal ? { signal } : {}),
    })

    if (result.kind === 'blacklist') return { failure: 'blacklist', reason: 'blacklist' }
    if (result.kind === 'error') {
      if (result.reason === 'invalid-function-arguments' && !argumentRetry) {
        argumentRetry = true
        continue
      }
      return { failure: 'error', reason: result.reason }
    }
    if (result.kind === 'function_call') {
      if (!canCall) return { failure: 'error', reason: 'too-many-calls' }
      calls++
      messages.push({ role: 'assistant', content: result.content, function_call: result.call, functions_state_id: result.functionsStateId })
      const tool = runTool(result.call.name, result.call.arguments, ctx)
      messages.push({ role: 'function', name: result.call.name, content: JSON.stringify({ result: tool.data, summary: tool.summary }) })
      continue
    }
    // Лёгкая модель ответила сама, без функций — просим сформулировать ответ основную модель
    if (model === 'fast' && provider.name !== 'offline') {
      fastAnsweredDirectly = true
      continue
    }
    return { text: tidyAnswer(result.content), ctx }
  }
}

export function createAssistant({ provider, logGap, log = (m) => console.warn(`[assistant] ${m}`), deadlineMs }: Options): Assistant {
  const offline = provider.name === 'offline' ? provider : offlineProvider()
  const deadline = { ...DEADLINE_MS, ...deadlineMs }

  async function finish(input: AssistantInput, question: string, text: string, ctx: ToolContext, source: AssistantReply['source']): Promise<AssistantReply> {
    if (ctx.escalation && logGap) {
      // Тему от офлайн-режима даёт его словарь намерений. Тему от модели приводим к тому же словарю,
      // чтобы одинаковые вопросы собирались в одну строку «Вопросов к Квасычу»
      const topic = source === 'llm' ? (gapTopic(question) ?? ctx.escalation.topic) : ctx.escalation.topic
      await logGap({ channel: input.channel, topic, question: question.slice(0, 500) }).catch((e) =>
        log(`не удалось записать вопрос без ответа: ${(e as Error).message}`),
      )
    }
    return { text, actions: mentionedActions(text, ctx.actions).slice(0, 4), profile: ctx.profile, escalated: Boolean(ctx.escalation), source }
  }

  async function respond(input: AssistantInput): Promise<AssistantReply> {
    const question = redactPersonal(input.question.trim()).slice(0, 1000)
    if (!question) return { text: SAFE_REPLY, actions: [], escalated: false, source: 'fallback' }
    // Ответы отдела персонала — свежие: HR мог только что ответить на вопрос из «Вопросов к Квасычу»
    await ensureHrAnswers()
    if (isAlcoholTopic(question)) {
      return { text: ALCOHOL_REPLY, actions: [{ type: 'open_vacancies' }, { type: 'start_quiz' }], escalated: false, source: 'fallback' }
    }
    // Вопрос целиком — тот, на который ответил HR: отвечаем его словами и без модели. Составной вопрос разбирает
    // офлайн-режим по частям, а GigaChat видит ответы HR в базе знаний
    const hr = splitParts(question).length <= 1 ? matchHrAnswer(normalize(question)) : null
    if (hr) return { text: hr.answer, actions: [{ type: 'start_application' }], escalated: false, source: 'hr' }

    let first: RunResult
    if (provider === offline) {
      first = await run(provider, input, question).catch((e: unknown) => ({ failure: 'error' as const, reason: (e as Error).message }))
    } else {
      // Общий срок вместе с очередью: прерывает ожидание, запрос к модели и паузу перед повтором
      const limitMs = input.channel === 'web' ? deadline.web : deadline.bot
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), limitMs)
      try {
        first = await beforeDeadline(run(provider, input, question, controller.signal), controller.signal)
      } finally {
        clearTimeout(timer)
      }
      if ('failure' in first && (first.reason === 'timeout' || first.reason === 'queue-full')) {
        stats.timeouts++
        log(first.reason === 'timeout' ? `таймаут: модель не ответила за ${Math.round(limitMs / 1000)} с, отвечает офлайн-режим` : 'таймаут: очередь к модели переполнена, отвечает офлайн-режим')
      }
    }
    if ('text' in first) {
      const check = checkAnswer(first.text, first.ctx.amounts)
      if (check.ok && first.text) return finish(input, question, first.text, first.ctx, provider.name === 'offline' ? 'offline' : 'llm')
      if (!check.ok) log(`ответ не прошёл проверку: ${check.problems.join('; ')}`)
    } else {
      if (first.reason !== 'timeout' && first.reason !== 'queue-full') log(`модель не ответила: ${first.reason}`)
      if (first.failure === 'blacklist') {
        return { text: ALCOHOL_REPLY, actions: [{ type: 'open_vacancies' }], escalated: false, source: 'fallback' }
      }
    }

    // Запасной ответ: офлайн-режим по тем же данным
    if (provider !== offline) {
      const second = await run(offline, input, question).catch(() => null)
      if (second && 'text' in second && second.text && checkAnswer(second.text, second.ctx.amounts).ok) {
        return finish(input, question, second.text, second.ctx, 'text' in first ? 'guard' : 'fallback')
      }
    }
    return { text: SAFE_REPLY, actions: [{ type: 'open_vacancies' }], escalated: false, source: 'fallback' }
  }

  return {
    mode: provider.name,
    async answer(input) {
      const started = Date.now()
      const reply = await respond(input)
      stats.answers++
      stats.totalMs += Date.now() - started
      stats.bySource[reply.source]++
      return reply
    },
  }
}
