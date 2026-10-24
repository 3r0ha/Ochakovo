// Проверки помощника «Спросить Квасыча» без сети: pnpm test:assistant
// Сценарный провайдер проверяет цикл функций, клиент GigaChat — на подменённом fetch,
// офлайн-режим — на типичных вопросах по официальным фактам «Очаково» (ответы печатаются, чтобы прочитать их глазами).
// Если задан GIGACHAT_AUTH_KEY, в конце — живой запрос к GigaChat.

import { createAssistant } from '../server/assistant/assistant'
import { checkAnswer, moneyAmounts, redactPersonal, tidyAnswer } from '../server/assistant/guard'
import { systemPrompt } from '../server/assistant/assistant'
import { confident, knowledgeText, search } from '../server/assistant/knowledge'
import { newToolContext, runTool } from '../server/assistant/tools'
import type { AssistantInput, KbGapInput } from '../server/assistant/types'
import { createEngine } from '../server/dialog/engine'
import { memoryStorage } from '../server/dialog/storage'
import type { DialogUser } from '../server/dialog/types'
import { createGigaChat, gigaChatFromEnv } from '../server/llm/gigachat'
import { faqAnswer } from '../shared/content/faq'
import { asksPortfolio, vacancies } from '../shared/content/vacancies'
import { offlineProvider } from '../server/llm/offline'
import type { ChatRequest, ChatResult, LlmProvider } from '../server/llm/provider'

/** Неразрывные пробелы в суммах → обычные, чтобы искать «60 000» */
const plain = (t: string) => t.replace(/[\u00A0\u202F]/g, ' ')

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    passed++
    console.log(`  \x1b[32m✓\x1b[39m ${name}`)
  } else {
    failed++
    console.log(`  \x1b[31m✗ ${name}\x1b[39m`, detail ?? '')
  }
}

const input = (question: string, extra: Partial<AssistantInput> = {}): AssistantInput => ({
  question,
  history: [],
  sessionId: 'test-session',
  channel: 'telegram',
  ...extra,
})

/** Провайдер, который отвечает заранее заданными результатами и запоминает запросы */
function scripted(results: ChatResult[]): LlmProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = []
  return {
    name: 'scripted',
    requests,
    async chat(request) {
      requests.push(structuredClone(request))
      return results[requests.length - 1] ?? { kind: 'error', reason: 'script-exhausted' }
    },
  }
}

const quiet = () => {}

// ── Цикл функций ─────────────────────────────────────────────────────────

console.log('\nЦикл функций')
{
  const provider = scripted([
    { kind: 'function_call', call: { name: 'search_vacancies', arguments: { query: 'склад' } }, functionsStateId: 'state-1', content: '' },
    { kind: 'text', content: 'На складе есть Оператор склада — от 60 000 ₽ в месяц, график 2/2 по 12 часов.' },
  ])
  const r = await createAssistant({ provider, log: quiet }).answer(input('Сколько платят на складе?'))
  const second = provider.requests[1]
  const echoed = second?.messages.find((m) => m.role === 'assistant' && 'functions_state_id' in m && m.functions_state_id === 'state-1')
  const fn = second?.messages.find((m) => m.role === 'function')
  check('первый шаг — лёгкая модель, ответ — основная', provider.requests[0].model === 'fast' && second?.model === 'answer')
  check('functions_state_id возвращается в историю', Boolean(echoed))
  check('результат функции уходит с ролью function', fn?.role === 'function' && fn.content.includes('warehouse-operator'))
  check('ответ модели принят', r.source === 'llm' && plain(r.text).includes('60 000'), r)
  check('под ответом кнопка вакансии', r.actions.some((a) => a.type === 'open_vacancy' && a.vacancyId === 'warehouse-operator'), r.actions)
  check('системный промпт одинаковый в каждом запросе', provider.requests[0].messages[0].content === second?.messages[0].content && provider.requests[0].messages[0].content === systemPrompt())
  check('база знаний собирается одинаково', knowledgeText() === knowledgeText() && knowledgeText().includes('Оператор склада'))
}
{
  const provider = scripted([
    { kind: 'text', content: 'черновик лёгкой модели' },
    { kind: 'text', content: 'Да, у компании есть общежитие рядом с заводом.' },
  ])
  const r = await createAssistant({ provider, log: quiet }).answer(input('Есть общежитие?'))
  check('если лёгкая модель ответила сама, ответ формулирует основная', provider.requests[1]?.model === 'answer' && r.text.startsWith('Да, у компании'), r.text)
}

// ── Проверки guard ───────────────────────────────────────────────────────

console.log('\nПроверки ответа')
{
  const provider = scripted([{ kind: 'text', content: 'x' }, { kind: 'text', content: 'Оператор склада получает от 150 000 ₽ в месяц.' }])
  const r = await createAssistant({ provider, log: quiet }).answer(input('Сколько платят на складе?'))
  check('выдуманная сумма отклонена, ответ из офлайн-режима', r.source === 'guard' && !r.text.includes('150') && plain(r.text).includes('60 000'), r)
}
check('выдуманная должность отклоняется', !checkAnswer('Нужны водители погрузчика, от 60 000 ₽ в месяц.').ok)
check('«вакансии грузчика нет» — честный ответ', checkAnswer('Вакансии грузчика сейчас нет. Есть Рабочий фирменного магазина — 57 000–89 000 ₽.').ok)
check('обещание сверх данных отклоняется', !checkAnswer('Тебя точно возьмут без собеседования.').ok)
check('итог за 3 месяца проходит, только если его посчитала функция', checkAnswer('За 3 месяца выйдет от 210 000 ₽, на руки — от 182 700 ₽.', [210000, 182700]).ok && !checkAnswer('За 3 месяца выйдет от 210 000 ₽.').ok)
check('суммы справочника проходят: общежитие и штраф за пропуск', checkAnswer('Для студентов — 3 400 ₽ за койко-место, для остальных — 6 800 ₽. За потерянный пропуск — штраф 500 ₽.').ok)
check('«бот-помощник» — не выдуманная должность', checkAnswer('Я Квасыч, бот-помощник «Очаково».').ok)
check('сумма, совпавшая с произведением, без расчёта не проходит', !checkAnswer('Оператор склада получает от 150 000 ₽ в месяц.').ok)
check('суммы: «57 000–89 000 ₽»', moneyAmounts('57 000–89 000 ₽').join() === '57000,89000', moneyAmounts('57 000–89 000 ₽'))
check('суммы: «57–89 тыс. ₽»', moneyAmounts('от 57–89 тыс. ₽').join() === '57000,89000', moneyAmounts('от 57–89 тыс. ₽'))
check('числа без денег не считаются суммами', moneyAmounts('70 000 бутылок в час, 2 раза в месяц, смены по 12 часов').length === 0)

{
  const provider = scripted([{ kind: 'text', content: 'ok' }, { kind: 'text', content: 'Платят официально.' }])
  await createAssistant({ provider, log: quiet }).answer(
    input('Меня зовут Маша Петрова, мой номер +7 999 123-45-67, почта masha@mail.ru, ник @masha_k. Сколько платят?'),
  )
  const sent = provider.requests[0].messages.at(-1)?.content ?? ''
  check(
    'телефон, почта, ник и имя не уходят в модель',
    !/999|123-45|mail\.ru|@masha|Маша|Петрова/.test(sent) && sent.includes('[телефон]'),
    sent,
  )
}
check('redactPersonal не трогает суммы', redactPersonal('от 57 000 ₽ до 89 000 ₽') === 'от 57 000 ₽ до 89 000 ₽')
check('вступления срезаются: «Отличный вопрос! Всё просто:»', tidyAnswer('Отличный вопрос! Всё просто: HR позвонит за два дня.') === 'HR позвонит за два дня.', tidyAnswer('Отличный вопрос! Всё просто: HR позвонит за два дня.'))
check('«Смотри вакансии…» без знака после — не вступление', tidyAnswer('Смотри вакансии на сайте.') === 'Смотри вакансии на сайте.')

// ── Поиск по базе и подбор по месяцам ────────────────────────────────────

console.log('\nПоиск по базе и подбор')
check('«можно устроиться вместе с другом» — FAQ про друга, а не про сезон', search('можно устроиться вместе с другом', 1)[0]?.chunk.answer.includes('Иду с другом') ?? false, search('можно устроиться вместе с другом', 1)[0])
check('общие слова не дают уверенного совпадения: «а как можно есть»', !confident(search('а как можно есть', 1)[0]), search('а как можно есть', 1)[0])
check('«есть ли парковка для сотрудников» — уверенного ответа в базе нет', !confident(search('есть ли парковка для сотрудников', 1)[0]), search('есть ли парковка для сотрудников', 1)[0])
{
  const ctx = newToolContext()
  const r = runTool('save_profile', { study_field: 'технолог', months: [6, 7] }, ctx)
  const data = r.data as { matches?: { id: string }[]; any_exact?: boolean }
  const ids = (data.matches ?? []).map((m) => m.id)
  check('июнь и июль: первой идёт профильная практика', ids[0] === 'fermentation-assistant', ids)
  check('июнь и июль: срок практики не подгоняем под месяцы — «можно на …» нет', !/можно на/.test(r.summary) && r.summary.includes('\nС марта или апреля до июля или середины августа'), r.summary)
}
{
  const ctx = newToolContext()
  const r = runTool('save_profile', { months: [6, 7, 8] }, ctx)
  const data = r.data as { matches?: { id: string }[]; any_exact?: boolean }
  check('лето целиком: подходит оплачиваемая практика — её срок обсуждают', data.any_exact === true && (data.matches ?? []).every((m) => vacancies.find((v) => v.id === m.id)?.format === 'Оплачиваемая практика'), data)
}
{
  const ctx = newToolContext()
  const r = runTool('save_profile', { study_field: 'история', months: [6, 7, 8] }, ctx)
  const ids = ((r.data as { matches?: { id: string }[] }).matches ?? []).map((m) => m.id)
  check('историку летом — практика в офисе, без чужих профильных практик', ids[0] === 'marketing-intern' && !ids.includes('microbiologist-intern') && !ids.includes('lab-chemist'), ids)
}
check('в базе знаний нет технических id', !/\(id /.test(knowledgeText()), knowledgeText().match(/.{30}\(id .{20}/)?.[0])
check('id в ответе модели убирается', tidyAnswer('Стажёр отдела маркетинга (id marketing-intern) — офис, стажировка.') === 'Стажёр отдела маркетинга — офис, стажировка.')
check('голый id вакансии меняется на название', tidyAnswer('Подойдёт bottling-operator.') === 'Подойдёт Оператор линии розлива.')

// ── Модерация и ошибки ───────────────────────────────────────────────────

console.log('\nМодерация и ошибки')
{
  const provider = scripted([{ kind: 'blacklist' }])
  const r = await createAssistant({ provider, log: quiet }).answer(input('Какие напитки делает завод?'))
  check('blacklist → вежливый возврат к работе', r.source === 'fallback' && r.text.includes('только про работу'), r)
}
{
  const provider = scripted([])
  const r = await createAssistant({ provider, log: quiet }).answer(input('расскажи про пиво'))
  check('вопрос про алкоголь не уходит в модель', provider.requests.length === 0 && r.text.includes('только про работу'), r)
}
{
  const provider = scripted([{ kind: 'error', reason: 'network' }])
  const r = await createAssistant({ provider, log: quiet }).answer(input('Где жить, если я не из Москвы?'))
  check('модель недоступна → отвечает офлайн-режим', r.source === 'fallback' && r.text.startsWith('В общежитии компании'), r)
}
{
  const gaps: KbGapInput[] = []
  const assistant = createAssistant({ provider: offlineProvider(), logGap: async (g) => void gaps.push(g), log: quiet })
  const r = await assistant.answer(input('А парковка у завода есть? Мой номер 89991234567'))
  check('вопрос без ответа уходит в пробелы базы с темой из словаря', r.escalated && gaps.length === 1 && gaps[0].topic === 'парковка', gaps)
  check('и человеку честно сказано, что делать сейчас', !/передал/i.test(r.text) && r.text.includes('оставь заявку') && r.actions.some((a) => a.type === 'start_application'), r)
  check('в пробелы не попадают личные данные', !gaps[0]?.question.includes('8999'), gaps[0])
  const masked = await assistant.answer(input('А парковка у завода большая? Мой номер 89991234567'))
  check('подстановка «[телефон]» не превращает вопрос в вопрос про контакты', masked.escalated && !masked.text.includes('Адрес завода'), masked)
}

// ── Клиент GigaChat на подменённом fetch ─────────────────────────────────

console.log('\nКлиент GigaChat')
type Logged = { url: string; headers: Record<string, string>; body: string }
function fakeFetch(handler: (url: string, n: { oauth: number; chat: number }) => { status: number; json?: unknown; headers?: Record<string, string> }) {
  const log: Logged[] = []
  const n = { oauth: 0, chat: 0 }
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('/oauth')) n.oauth++
    else n.chat++
    log.push({ url: u, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: String(init?.body ?? '') })
    const r = handler(u, n)
    return new Response(r.json === undefined ? '' : JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json', ...r.headers } })
  }) as typeof fetch
  return { impl, log, n }
}
const token = (value: string, expiresAt: number) => ({ status: 200, json: { access_token: value, expires_at: expiresAt } })
function chatText(content: string, finish = 'stop') {
  return { status: 200, json: { choices: [{ message: { role: 'assistant', content }, finish_reason: finish }] } }
}
{
  const fake = fakeFetch((url, n) => {
    if (url.includes('/oauth')) return token('tok-1', Date.now() + 30 * 60_000)
    if (n.chat === 1)
      return {
        status: 200,
        json: {
          choices: [
            {
              message: { role: 'assistant', content: '', function_call: { name: 'search_vacancies', arguments: '{"query":"склад"}' }, functions_state_id: 'fs-9' },
              finish_reason: 'function_call',
            },
          ],
        },
      }
    return chatText('На складе — Оператор склада, от 60 000 ₽ в месяц.')
  })
  const provider = createGigaChat({ authKey: 'a2V5OnNlY3JldA==', fetchImpl: fake.impl, retryBaseMs: 1, log: quiet })
  const r = await createAssistant({ provider, log: quiet }).answer(input('Сколько платят на складе?'))
  const oauth = fake.log.find((l) => l.url.includes('/oauth'))!
  const chats = fake.log.filter((l) => l.url.includes('/chat/completions'))
  const secondBody = JSON.parse(chats[1]?.body ?? '{}') as { model: string; messages: { role: string; functions_state_id?: string; name?: string }[] }
  check('OAuth: Basic-ключ, RqUID и scope', oauth.headers.authorization === 'Basic a2V5OnNlY3JldA==' && Boolean(oauth.headers.rquid) && oauth.body === 'scope=GIGACHAT_API_PERS')
  check('токен запрошен один раз на два запроса', fake.n.oauth === 1 && fake.n.chat === 2, fake.n)
  check('запросы с Bearer и X-Session-ID', chats.every((c) => c.headers.authorization === 'Bearer tok-1' && c.headers['x-session-id'] === 'test-session'))
  check('модели: GigaChat-2, затем GigaChat-2-Pro', JSON.parse(chats[0].body).model === 'GigaChat-2' && secondBody.model === 'GigaChat-2-Pro')
  check('аргументы-строка разобраны, functions_state_id вернулся', secondBody.messages.some((m) => m.functions_state_id === 'fs-9') && secondBody.messages.some((m) => m.role === 'function' && m.name === 'search_vacancies'))
  check('ответ GigaChat принят', r.source === 'llm' && plain(r.text).includes('60 000'), r)
}
{
  const fake = fakeFetch((url, n) => {
    if (url.includes('/oauth')) return token(`tok-${n.oauth}`, Math.floor(Date.now() / 1000) + 1800)
    if (n.chat === 1) return { status: 401 }
    if (n.chat === 2) return { status: 429, headers: { 'retry-after': '0' } }
    return chatText('Готово.')
  })
  const provider = createGigaChat({ authKey: 'k', fetchImpl: fake.impl, retryBaseMs: 1, log: quiet })
  const r = await provider.chat({ model: 'answer', messages: [{ role: 'user', content: 'привет' }] })
  check('401 → новый токен и повтор, 429 → повтор', r.kind === 'text' && fake.n.oauth === 2 && fake.n.chat === 3, { r, n: fake.n })
  const again = await provider.chat({ model: 'answer', messages: [{ role: 'user', content: 'ещё' }] })
  check('expires_at в секундах понят — токен из кэша', again.kind === 'text' && fake.n.oauth === 2, fake.n)
}
{
  const fake = fakeFetch((url) => (url.includes('/oauth') ? token('t', Date.now() + 1e6) : chatText('', 'blacklist')))
  const provider = createGigaChat({ authKey: 'k', fetchImpl: fake.impl, retryBaseMs: 1, log: quiet })
  const r = await provider.chat({ model: 'answer', messages: [{ role: 'user', content: 'x' }] })
  check('finish_reason blacklist распознан', r.kind === 'blacklist')
}
{
  const fake = fakeFetch((url) => (url.includes('/oauth') ? token('t', Date.now() + 1e6) : { status: 422, json: { message: 'bad' } }))
  const provider = createGigaChat({ authKey: 'k', fetchImpl: fake.impl, retryBaseMs: 1, log: quiet })
  const r = await provider.chat({ model: 'answer', messages: [{ role: 'user', content: 'x' }] })
  check('422 не повторяется', r.kind === 'error' && fake.n.chat === 1)
}

// ── Офлайн-режим: десять типичных вопросов ──────────────────────────────

console.log('\nОфлайн-режим: ответы на типичные вопросы')
const offline = createAssistant({ provider: offlineProvider(), log: quiet })
const questions: [string, (t: string) => boolean][] = [
  ['Сколько платят на складе?', (t) => t.startsWith('На складе платят 56 000–60 000 ₽') && !t.includes('магазина')],
  ['Можно на 2 месяца?', (t) => t.startsWith(plain(faqAnswer('summer-only')).slice(0, 40))],
  ['Где общежитие?', (t) => t.startsWith('Адрес общежития компании: ул. Рябиновая, 36, к. 2') && t.includes('3 400 ₽')],
  ['Есть общага?', (t) => t.startsWith('Да, у компании есть общежитие')],
  ['Что делают в лаборатории?', (t) => t.startsWith('В лаборатории проверяют') && t.includes('Лаборант')],
  ['Как варят квас?', (t) => t.includes('сусло') && t.includes('бродит')],
  ['Нужен ли опыт?', (t) => t.startsWith('Опыт не нужен') && t.includes('наставник')],
  ['Есть ночные смены?', (t) => t.startsWith('Ночные смены бывают у позиций') && t.includes('«Кладовщик»') && t.includes('по повышенному коэффициенту')],
  ['Я учусь на технолога, свободен летом', (t) => t.startsWith('Под учёбу на технолога') && t.includes('Оператор технологического цеха')],
  ['Как добраться до завода?', (t) => t.startsWith('До завода на ул. Рябиновая, 44 ходят корпоративный автобус') && t.includes('610') && t.includes('Озёрная')],
  ['Расскажи про пиво', (t) => t.includes('только про работу')],
  ['Можно работать только июль и август?', (t) => t.startsWith(plain(faqAnswer('summer-only')).slice(0, 40)) && !/можно на июль/i.test(t)],
  ['Какой график на линии?', (t) => t.startsWith('Оператор линии розлива: дневные и ночные смены по 12 часов') && t.includes('два дня отдыха')],
  ['Сколько получает оператор?', (t) => t.startsWith('Операторам платят 60 000–70 000 ₽')],
  ['Сколько заработаю за лето в магазине?', (t) => t.startsWith('За лето (с июня по август, 3 месяца) в фирменном магазине выйдет 171 000–267 000 ₽') && t.includes('на руки')],
  ['Какой график в магазине?', (t) => t.startsWith('Рабочий фирменного магазина') && !t.includes('Оператор')],
  // Вопросы с ручной проверки: первая фраза — прямой ответ
  ['сколько платят без опыта', (t) => t.startsWith('Без опыта платят от 56 000 ₽ в месяц кладовщиком')],
  ['где жить если я из твери', (t) => t.startsWith('В общежитии компании: ул. Рябиновая, 36, к. 2')],
  ['как доехать до завода', (t) => t.includes('м. «Озёрная»') && t.includes('610 и 807') && /корпоративный автобус/.test(t)],
  ['можно устроиться вместе с другом', (t) => t.includes('Иду с другом') && !t.includes('Сезон')],
  ['а пиво вы варите', (t) => t.startsWith('Я рассказываю только про работу')],
  ['когда ответят после заявки', (t) => t.startsWith('HR позвонит в течение двух рабочих дней после заявки.')],
  ['есть ли парковка для сотрудников', (t) => t.startsWith('Точного ответа в моих данных нет. Спроси в отделе персонала') && t.includes('оставь заявку')],
  ['форму дают?', (t) => t.startsWith('Спецодежду и обувь выдают при официальном оформлении') && !t.includes('Точного ответа')],
  ['больничный есть?', (t) => t.startsWith('Да, больничный оплачивается по закону') && t.includes('здравпункт')],
  ['автобус во скока ходит?', (t) => t.includes('м. «Озёрная»') && /расписани/i.test(t) && /отделе подбора/i.test(t)],
  // Справочник студента: быт, правила, документы, телефоны
  ['сколько длится обед', (t) => t.startsWith('Обед в столовой по будням с 11:30 до 14:30') && t.includes('перерыв')],
  ['кормят на заводе?', (t) => t.startsWith('Обед в столовой') && t.includes('Половину стоимости компенсирует компания')],
  ['когда первая зарплата', (t) => t.startsWith('Зарплату платят два раза в месяц, 12-го и 27-го')],
  ['что взять на собеседование', (t) => t.startsWith('Паспорт.')],
  ['где проходит собеседование', (t) => t.startsWith('Где и когда собеседование, HR пишет в приглашении')],
  ['можно ли совмещать с учебой', (t) => t.startsWith(faqAnswer('study').slice(0, 20))],
  ['можно ли иностранцу из казахстана', (t) => t.includes('Казахстана') && t.includes('разрешение на работу в России по закону не нужно')],
  ['сколько платят за ночную смену', (t) => t.startsWith('Ночные смены оплачиваются по повышенному коэффициенту')],
  ['есть ли наставник на линии', (t) => t.startsWith('Да, к каждому новичку прикрепляют наставника')],
  ['какой дресс-код в офисе', (t) => t.startsWith('Точного ответа в моих данных нет')],
  ['есть испытательный срок?', (t) => t === 'У студентов испытательного срока нет, вместо него идёт производственная практика.'],
  ['потерял пропуск', (t) => t.includes('отдел кадров') && t.includes('штраф 500 ₽')],
  ['телефон коменданта', (t) => t.startsWith('Телефон коменданта общежития: 8 495 446-42-55')],
  ['где учебный центр', (t) => t.includes('доб. 1244 или 3105') && t.includes('кабинет 525')],
  ['какие документы нужны для практики', (t) => t.startsWith(plain(faqAnswer('practice-docs')).slice(0, 40))],
  ['сколько стоит общежитие', (t) => t.startsWith('Для студентов койко-место стоит 3 400 ₽') && t.includes('6 800 ₽')],
  // Вопросы проверяющих из чата на сайте: ответ на каждую часть, без id, мимо темы — без передачи в HR
  ['Скока на руки без опыта, мне 18?', (t) => t.startsWith('Без опыта на руки выходит от 48 700 ₽ в месяц кладовщиком') && t.includes('До вычета налога') && t.includes('Возраст подходит')],
  ['Можно только июль и август, в июне практика?', (t) => t.includes('пересекается с практикой в июне') && t.includes('смены на это время не ставят') && !/можно на июль/i.test(t)],
  ['Хочу с другом в одну смену, и общага платная?', (t) => t.includes('«Иду с другом»') && /[вВ] одну смену/.test(t) && t.includes('койко-место стоит 3 400 ₽')],
  ['напиши стих про квас', (t) => t.startsWith('Стихи не по моей части, я рассказываю про смены и вакансии') && !t.includes('отдел персонала')],
  ['чем лучше кофейни', (t) => t.startsWith('На заводе официальный договор') && t.includes('общежити') && t.includes('у меня данных нет')],
  ['Я на маркетинге, хочу стажировку', (t) => t.includes('Практика в офисе') && t.includes('без оплаты')],
  ['какая погода завтра', (t) => t.startsWith('Тут не подскажу') && !t.includes('отдел персонала')],
  ['ты бот?', (t) => t.startsWith('Я Квасыч, бот «Очаково»') && t.includes('наставник')],
  // Сумма за срок по названной вакансии и честный ответ про неполный график
  [
    'Сколько на руки у кладовщика за лето и можно ли 3 дня в неделю',
    (t) =>
      t.startsWith('За июнь и июль (практика идёт до конца июля или середины августа) кладовщиком на руки выйдет от 97 400 ₽, до вычета налога от 112 000 ₽.') &&
      t.includes('около 15 смен в месяц') &&
      t.includes('Графика «3 дня в неделю» в вакансии нет') &&
      t.includes('решает отдел персонала'),
  ],
  ['сколько заработаю в магазине за 2 месяца', (t) => t.startsWith('За 2 месяца в фирменном магазине выйдет 114 000–178 000 ₽ до вычета налога, на руки 99 200–154 900 ₽')],
  [
    'Сколько получу на складе за сезон, и можно 2 дня в неделю?',
    (t) => t.startsWith('За всю практику с начала марта до конца июля (5 месяцев) на складе выйдет от 280 000 ₽ кладовщиком') && t.includes('Графика «2 дня в неделю» в вакансиях нет'),
  ],
  ['можно работать по выходным?', (t) => t.startsWith('Работы только по выходным в вакансиях нет') && t.includes('решает отдел персонала') && t.includes('2/2')],
  ['а неполный день в магазине бывает', (t) => t.startsWith('Рабочий фирменного магазина: график 2/2') && t.includes('решает отдел персонала')],
  ['что делает кладовщик', (t) => t.startsWith('Кладовщик: работа с накладными, управление комплектовщиками') && t.includes('Зарплата от 56 000 ₽ в месяц')],
  // Медкнижка, ночные смены, одна вакансия без списка остальных
  ['медкнижка нужна?', (t) => t.startsWith(plain(faqAnswer('medbook')).slice(0, 40)) && t.includes('«Оформлю до выхода»') && t.length <= 400],
  ['а мед книжку делать надо на линию?', (t) => t.startsWith('Для позиции «Оператор линии розлива» нужна личная медицинская книжка') && t.includes('«Оформлю до выхода»')],
  ['ночные есть?', (t) => t.startsWith('Ночные смены бывают у позиций') && t.includes('Только днём работают на позициях «Рабочий фирменного магазина» и «Мерчандайзер»')],
  ['по ночам на складе работают?', (t) => t.includes('На складе ночные смены бывают') || t.includes('на складе ночные смены бывают')],
  ['скок за лето на линии', (t) => t.startsWith('За июнь и июль (практика идёт до конца июля или середины августа) в цехе розлива выйдет от 140 000 ₽ до вычета налога, на руки от 121 800 ₽.')],
  ['скока на руки за лето в магазе', (t) => t.startsWith('За лето (с июня по август, 3 месяца) в фирменном магазине на руки выйдет 148 800–232 300 ₽')],
  ['сколько платят кладовщику', (t) => t.startsWith('Кладовщику платят от 56 000 ₽ в месяц до вычета налога, на руки от 48 700 ₽') && !t.includes('Оператор')],
  ['скок на руки на линии', (t) => t.startsWith('Оператору линии розлива платят на руки от 60 900 ₽ в месяц')],
  // Портфолио: где оставить и нужно ли
  ['а портфолио где прикрепить?', (t) => t.startsWith('Ссылку на портфолио (GitHub, Behance или папку на диске) оставь в заявке на практику в офисе') && t.includes('«Ссылка на портфолио»') && !t.includes('\n')],
  ['портфолио нужно?', (t) => t.startsWith('Не обязательно. Ссылку на работы') && !t.includes('\n')],
  // Кто платит за медкнижку — в данных нет: честно и к HR
  ['кто платит за медкнижку', (t) => t.startsWith('Кто оплачивает медкнижку, в моих данных нет. Это скажет HR на звонке') && t.includes('«Оформлю до выхода»')],
  ['медкнижка за свой счёт?', (t) => t.startsWith('Кто оплачивает медкнижку, в моих данных нет')],
  ['медкнижку оплачивают?', (t) => t.startsWith('Кто оплачивает медкнижку, в моих данных нет')],
]
/** Технические id вакансий в тексте человеку */
const vacancyIdRe = new RegExp(`\\(id |${vacancies.map((v) => v.id).join('|')}`)
/** Мимо темы — не в пробелы базы; вопрос о работе без ответа — в пробелы */
const escalation: [string, boolean][] = [
  ['напиши стих про квас', false],
  ['чем лучше кофейни', false],
  ['какая погода завтра', false],
  ['есть ли парковка для сотрудников', true],
  ['форму дают?', false],
  ['Хочу с другом в одну смену, и общага платная?', false],
  ['можно пройти практику от вуза?', false],
  ['кто будет учить?', false],
  ['кто платит за медкнижку', true],
]
// Портфолио: под одной фразой — кнопки офисных вакансий
{
  const r = await offline.answer(input('а портфолио где прикрепить?'))
  const ids = r.actions.flatMap((a) => (a.type === 'open_vacancy' ? [a.vacancyId] : []))
  check('портфолио: кнопки — вакансии, где в заявке спрашивают портфолио', ids.length > 0 && ids.every((id) => asksPortfolio(vacancies.find((v) => v.id === id)!)), r.actions)
}
/** Вопрос «да или нет» — только тогда ответ может начинаться с «Да». Знак вопроса без вопросительного слова — тоже «да или нет» */
const yesNoQuestion = (q: string) =>
  /^(а\s+)?(можно|могу|есть|нужен|нужна|нужно)(?![а-я])/i.test(q) ||
  /\s(есть|дают|выдают|бывает|платят)\s*\??$/i.test(q) ||
  (q.includes('?') && !/(?<![а-яё])(сколько|скока|где|как|когда|какой|какая|какие|что|чем|кто|почему|зачем|куда)(?![а-яё])/i.test(q))
for (const [q, expect] of questions) {
  const r = await offline.answer(input(q))
  console.log(`\n\x1b[1m— ${q}\x1b[22m\n${r.text}\n\x1b[2m[кнопки: ${r.actions.map((a) => a.type + ('vacancyId' in a && a.vacancyId ? `:${a.vacancyId}` : '')).join(', ') || 'нет'}]\x1b[22m`)
  const opener = /^(Всё просто|Отличный вопрос|Хороший вопрос|Конечно|Итак)/.test(r.text) || (!yesNoQuestion(q) && /^Да(?![а-я])/.test(r.text))
  check(`«${q}»`, expect(plain(r.text)) && !opener && !/!|undefined|null|NaN|…|передал|передам/.test(r.text) && !vacancyIdRe.test(r.text), r.text)
}
// Вопрос про одну вакансию — кнопки только про неё и «Другие вакансии», без стены чужих вакансий
for (const [q, id] of [['скок за лето на линии', 'bottling-operator'], ['сколько платят кладовщику', 'storekeeper']] as const) {
  const r = await offline.answer(input(q))
  check(
    `«${q}»: кнопки только про «${id}» и все вакансии`,
    r.actions.every((a) => !('vacancyId' in a) || !a.vacancyId || a.vacancyId === id) && r.actions.some((a) => a.type === 'open_vacancies'),
    r.actions,
  )
}
for (const [q, escalated] of escalation) {
  const r = await offline.answer(input(q))
  check(`«${q}» ${escalated ? 'уходит' : 'не уходит'} в отдел персонала`, r.escalated === escalated, r)
}

// ── Бот: свободный текст уходит помощнику, команды и заявка — нет ────────

console.log('\nИнтеграция с ботом')
{
  const storage = memoryStorage()
  const engine = createEngine(storage, { siteUrl: 'http://localhost:5180', assistant: offline })
  const user: DialogUser = { channel: 'telegram', id: 'test', firstName: 'Даня' }
  const ask = await engine.handle(user, { type: 'text', text: 'сколько платят на складе' })
  const buttons = ask.messages[0].buttons?.flat().map((b) => (b.kind === 'action' ? b.action : b.kind)) ?? []
  check('вопрос текстом → ответ помощника с кнопками', plain(ask.messages[0].text).includes('60 000') && buttons.includes('v:open:warehouse-operator') && buttons.includes('m'), ask)
  const menu = await engine.handle(user, { type: 'text', text: 'меню' })
  check('«меню» по-прежнему открывает меню', menu.messages[0].text.includes('Смена'))
  const askButton = menu.messages[0].buttons?.flat().some((b) => b.kind === 'action' && b.action === 'm:ask')
  check('в меню есть «Спросить Квасыча»', Boolean(askButton))
  await engine.handle(user, { type: 'action', action: 'm:apply' })
  // В заявке текст отвечает шаг заявки, а не помощник: вопрос не уходит в «Вопросы к Квасычу»
  const step = await engine.handle(user, { type: 'text', text: 'Даня' })
  const inApply = await storage.getSession(user)
  check('в заявке текст идёт в заявку, а не помощнику', inApply.flow === 'apply' && storage.gaps.length === 0 && !/Точного ответа|Тут не подскажу/.test(step.messages[0].text), step)
  const session = await storage.getSession(user)
  check('история разговора пережила переход в меню и заявку', Array.isArray((session.data.assistant as { history?: unknown[] })?.history))
  const typed = await engine.handle({ ...user, id: 'typed' }, { type: 'text', text: 'Спросить Квасыча' })
  check('набранная подпись кнопки открывает раздел, а не уходит в пробелы', typed.messages[0].text.startsWith('**Спросить Квасыча**') && storage.gaps.length === 0, typed)
  const web = await engine.handle({ channel: 'web', id: 'web-user' }, { type: 'start' })
  const webLinks = web.messages.flatMap((m) => m.buttons?.flat() ?? []).filter((b) => b.kind === 'link')
  check('на сайте в меню нет ссылки «Сайт»', webLinks.length === 0)
  const short = await offline.answer(input('ну ок'))
  check('короткая реплика без вопроса — приглашение спросить', short.text.startsWith('Спроси своими словами') && !short.escalated)
}

// ── Живой GigaChat, если задан ключ ──────────────────────────────────────

console.log('\nGigaChat вживую')
const live = gigaChatFromEnv()
if (!live) {
  console.log('  GIGACHAT_AUTH_KEY не задан — пропускаем')
} else {
  const r = await createAssistant({ provider: live }).answer(input('Сколько платят на складе и есть ли общежитие?'))
  console.log(`  источник: ${r.source}\n  ${r.text}`)
  check('живой ответ получен', r.text.length > 0)
}

console.log(`\n${failed ? '\x1b[31m' : '\x1b[32m'}Пройдено: ${passed}, провалено: ${failed}\x1b[39m`)
process.exit(failed ? 1 : 0)
