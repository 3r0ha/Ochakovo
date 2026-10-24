// Сценарии бота от начала до конца, без мессенджеров и сети: pnpm tsx scripts/dialog-test.ts
// Каждый раздел меню проходится нажатиями кнопок, как это делает человек. Помощник — офлайн.
// Даты рождения считаются от текущего момента — в проверке нет ни одной записанной даты.
// В конце все тексты бота проверяются на правила из docs/quality-brief.md.

import { existsSync } from 'node:fs'
import { CONSENT_VERSION } from '../shared/applications'
import { mskToday } from '../shared/birthDate'
import { responsePromise } from '../shared/candidateStatus'
import { COMPANY_QUIZ_ROUND, companyQuizById, companyQuizResult } from '../shared/content/companyQuiz'
import { TRAINING_CENTER_ROOM } from '../shared/content/handbook'
import { freePracticeInfo, paidPracticeInfo } from '../shared/content/practice'
import { asksPortfolio, estimateNote, formatRub, freePractice, maxEntryPay, minMonthlyPay, paidPractice, shiftPay, vacanciesByPay, vacancyById, vacancyFormats } from '../shared/content/vacancies'
import { buildDeck, contacts, DECK_SIZE, myths } from '../shared/content/content'
import { PLANT_BOTTLES_PER_HOUR, stages } from '../shared/content/production'
import { quiz, scoreQuiz } from '../shared/content/quiz'
import { dialogRoutes } from '../server/api/dialog'
import type { Registry } from '../server/channels/registry'
import { createAssistant } from '../server/assistant/assistant'
import { createEngine } from '../server/dialog/engine'
import { memoryStorage } from '../server/dialog/storage'
import type { Button, DialogEvent, DialogReply, DialogUser, HandleMeta } from '../server/dialog/types'
import { offlineProvider } from '../server/llm/offline'
import { perShiftLine, roles } from '../server/dialog/flows/money'

delete process.env.TELEGRAM_BOT_USERNAME
delete process.env.MAX_BOT_NICK

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

/** Повторяемые случайные числа: колода «Правда или миф» и раунды игры одинаковы от прогона к прогону */
function seeded(seed: number) {
  let x = seed >>> 0
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0
    return x / 2 ** 32
  }
}

const SITE = 'https://ochakovo.test'
const storage = memoryStorage()
const assistant = createAssistant({ provider: offlineProvider(), log: () => {} })
const engine = createEngine(storage, { siteUrl: SITE, assistant, random: seeded(7) })

/** Все тексты, которые бот отправил за прогон — для проверки правил в конце */
const seen = new Set<string>()
/** Самый длинный ряд кнопок за прогон: в Telegram и MAX больше трёх в ряд не читаются */
let widestRow = 0

async function send(user: DialogUser, event: DialogEvent | string, meta?: HandleMeta): Promise<DialogReply> {
  // Строка вида «v:list:0», «m» или «x» — нажатие кнопки, остальное — текст (в том числе ссылки https://…)
  const isAction = (x: string) => /^(m|x)$/.test(x) || /^[a-z]{1,3}:\S*$/.test(x)
  const e: DialogEvent = typeof event === 'string' ? (isAction(event) ? { type: 'action', action: event } : { type: 'text', text: event }) : event
  const r = await engine.handle(user, e, meta)
  for (const m of r.messages) {
    seen.add(m.text)
    for (const row of m.buttons ?? []) widestRow = Math.max(widestRow, row.length)
  }
  return r
}

const textOf = (r: DialogReply) => plain(r.messages.map((m) => m.text).join('\n\n'))
const buttonsOf = (r: DialogReply): Button[] => r.messages.flatMap((m) => (m.buttons ?? []).flat())
const labels = (r: DialogReply) => buttonsOf(r).map((b) => b.text)
const actions = (r: DialogReply) => buttonsOf(r).flatMap((b) => (b.kind === 'action' ? [b.action] : []))
const session = (u: DialogUser) => storage.getSession(u)

const user = (id: string, channel: DialogUser['channel'] = 'telegram', firstName = 'Саша'): DialogUser => ({ channel, id, firstName, username: `${id}_nick` })
const bare = (t: string) => t.replace(/\*\*/g, '')
const linksOf = (r: DialogReply) => buttonsOf(r).flatMap((b) => (b.kind === 'link' ? [{ text: b.text, url: b.url }] : []))
const applyState = async (u: DialogUser) => (await session(u)).data.apply as Record<string, unknown> & { step: string }

const pad = (n: number, len = 2) => String(n).padStart(len, '0')
/** Дата рождения в виде ДД.ММ.ГГГГ: ровно years лет назад от сегодняшнего дня по Москве, сдвинутая на days дней */
function birth(years: number, days = 0) {
  const [y, m, d] = mskToday().split('-').map(Number)
  const t = new Date(Date.UTC(y - years, m - 1, d + days))
  return `${pad(t.getUTCDate())}.${pad(t.getUTCMonth() + 1)}.${t.getUTCFullYear()}`
}
const ADULT = birth(20)

/** Уникальный телефон на прогон: повтор того же номера за 10 минут заявка не принимает */
let phoneSeq = 1000
const nextPhone = () => `+7926${String(phoneSeq++).padStart(7, '0')}`

/** Начать заявку и пройти шаг даты рождения */
async function startApply(u: DialogUser, action = 'a:start', meta?: HandleMeta) {
  await send(u, action, meta)
  return send(u, ADULT, meta)
}

/**
 * Заявка до выбора вакансии включительно: дата рождения, ФИО, телефон, вуз, месяцы как есть, «Сразу», вакансия.
 * Возвращает ответ на выбор вакансии — проверку заявки или шаг портфолио
 */
async function fillApply(u: DialogUser, opts: { vacancy?: string; phone?: string; name?: string; meta?: HandleMeta; months?: 'done' | 'none' } = {}) {
  const meta = opts.meta
  await startApply(u, opts.vacancy ? `a:start:${opts.vacancy}` : 'a:start', meta)
  await send(u, opts.name ?? 'Смирнова Анна', meta)
  await send(u, opts.phone ?? nextPhone(), meta)
  await send(u, 'МГУПП', meta)
  await send(u, opts.months === 'none' ? 'a:mnone' : 'a:mdone', meta)
  await send(u, 'a:sr:now', meta)
  return send(u, `a:v:${opts.vacancy ?? 'any'}`, meta)
}

// ── Старт, меню, помощь ─────────────────────────────────────────────

const practiceRange = `от ${minMonthlyPay.toLocaleString('ru-RU')} до ${formatRub(maxEntryPay)}`

console.log('\nСтарт и меню')
{
  const u = user('start')
  const r = await send(u, { type: 'start', payload: 'fair-mgupp' })
  check('приветствие: вилка оплачиваемой практики из shared и наставник', textOf(r).includes(`На оплачиваемой практике платят ${plain(practiceRange)} в месяц до вычета налога`) && textOf(r).includes('наставника'), textOf(r))
  check('приветствие без «бот-помощник» и «на лето»', !/помощник|на лето/.test(textOf(r)), textOf(r))
  check('в меню есть «Практика», «Позвать друга» и контрольные вопросы', ['Практика', 'Позвать друга', 'Что ты знаешь об «Очаково»'].every((l) => labels(r).includes(l)), labels(r))
  check('не больше трёх кнопок в ряду', r.messages.every((m) => (m.buttons ?? []).every((row) => row.length <= 3)))
  check('в начале объясняется, зачем задания', textOf(r).includes('Смена 0/4. Четыре коротких задания'))
  check('источник из диплинка сохранён', (await session(u)).source === 'fair-mgupp')
  await send(u, { type: 'start', payload: 'vk-ads' })
  check('первое касание не перезаписывается', (await session(u)).source === 'fair-mgupp')

  const help = await send(u, '/help')
  check('/help — коротко, что умеет бот, и меню', textOf(help).startsWith('Я Квасыч: расскажу про практику') && labels(help).includes('Вакансии и зарплаты'))
  const unknown = await send(u, '/settings')
  check('незнакомая команда — «Такой команды нет» и меню', textOf(unknown).startsWith('Такой команды нет') && labels(unknown).includes('Откликнуться'))
  const word = await send(u, 'Меню')
  check('слово «Меню» открывает меню', labels(word).includes('Поймай брак'))
}

// ── Вакансии ────────────────────────────────────────────────────────

console.log('\nВакансии')
{
  const u = user('vac')
  const first = await send(u, 'v:list:0')
  const t = textOf(first)
  const lines = t.split('\n').filter((l) => /^\d+\. /.test(l))
  check('первая страница — оплачиваемая практика под заголовком', t.includes(`**${paidPractice[0].format}**`) && lines[0]?.startsWith(`1. ${vacanciesByPay[0].title}`) && vacanciesByPay[0].format === 'Оплачиваемая практика', lines)
  check('порядок: оплачиваемая практика, бесплатная, работа', vacanciesByPay.every((v, i) => i === 0 || vacancyFormats.indexOf(vacanciesByPay[i - 1].format) <= vacancyFormats.indexOf(v.format)))
  check('сноска об источниках сумм — из shared', t.includes(plain(estimateNote)), t)
  check('у страницы понятный номер', t.includes('страница 1 из'))
  check('кнопка «Следующие», без «Предыдущие» на первой', labels(first).includes('Следующие') && !labels(first).includes('Предыдущие'))
  const second = await send(u, 'v:list:1')
  check('на второй странице обе стрелки и заголовок бесплатной практики', labels(second).includes('Предыдущие') && labels(second).includes('Следующие') && textOf(second).includes('**Бесплатная практика**'), textOf(second))
  check('у бесплатной практики — «без оплаты»', textOf(second).includes(`${freePractice[0].title} · без оплаты`), textOf(second))

  const card = await send(u, 'v:open:store-worker')
  const c = textOf(card)
  check('карточка: «Что делать» и «Кого берут»', c.includes('**Что делать**') && c.includes('**Кого берут**\nБез опыта'), c)
  check('зарплата в карточке — в месяц до вычета налога и на руки', c.includes('57 000–89 000 ₽ в месяц до вычета налога') && c.includes('На руки: от'), c)
  const lab = await send(u, 'v:open:lab-chemist')
  check('лаборант: «с ночными сменами больше» и часы смен', textOf(lab).includes('с ночными сменами больше') && textOf(lab).includes('Смены: днём с 8:00 до 20:00'), textOf(lab))
  const video = linksOf(lab).find((l) => l.text.startsWith('Посмотреть смену'))
  if (existsSync('public/video/manifest.json')) {
    check('лаборант: ролик «Посмотреть смену · 0:25» ссылкой на файл сайта', Boolean(video && /^Посмотреть смену · \d:\d\d$/.test(video.text) && video.url.startsWith(`${SITE}/video/lab-assistant-`) && video.url.endsWith('.mp4')), video)
  }
  const free = textOf(await send(u, `v:open:${freePractice[0].id}`))
  check('бесплатная практика: «Без оплаты», без строки «На руки»', free.includes('Без оплаты: практика по договорённости') && !free.includes('На руки'), free)
  const noVideo = await send(u, 'v:open:store-worker')
  check('у вакансии без ролика нет кнопки ролика', !linksOf(noVideo).some((l) => l.text.startsWith('Посмотреть смену')))
}

// ── Подбор работы ───────────────────────────────────────────────────

console.log('\nПодбор работы')
{
  const u = user('quiz')
  await send(u, 'm:quiz')
  let r: DialogReply | undefined
  for (let step = 0; step < quiz.length; step++) r = await send(u, `q:${step}:0`)
  check('после четырёх ответов — подходящая вакансия', textOf(r!).startsWith('**Тебе подойдёт**'), textOf(r!))
  check('задание засчитано', (await session(u)).progress.quiz !== undefined)
  check('есть «Откликнуться на эту вакансию»', actions(r!).some((a) => a.startsWith('a:start:')))
}

// ── Собери лето ─────────────────────────────────────────────────────

console.log('\nСобери лето')
{
  const u = user('money')
  const intro = await send(u, 'm:money')
  check('роли «Собери лето» есть в данных и с суммой', roles.every((id) => vacancyById(id)?.pay) && actions(intro).filter((a) => a.startsWith('mo:r:')).length === roles.length, actions(intro))
  check('источник сумм — данные «Очаково» и hh.ru', textOf(intro).includes('Суммы взяты из данных «Очаково» и вакансий на hh.ru'), textOf(intro))
  const work = roles.indexOf('store-worker')
  await send(u, `mo:r:${work}`)
  const r = await send(u, 'mo:m:9')
  check('работа: сентябрь добавлен к лету', textOf(r).includes('июнь, июль, август, сентябрь, всего 4 месяца'), textOf(r))
  const done = await send(u, 'mo:done')
  check('итог: «с июня по сентябрь» и диапазон', textOf(done).includes('с июня по сентябрь') && textOf(done).includes('228 000–356 000 ₽'), textOf(done))
  check('итог: зарплата 12-го и 27-го', textOf(done).includes('Зарплата 12-го и 27-го'), textOf(done))
  check('месяцы запомнены для заявки', (await session(u)).progress.months?.length === 4)

  const p = user('money-practice')
  const practice = await send(p, 'mo:r:0')
  const v = vacancyById(roles[0])!
  check('практика: отмечены апрель — июль, сентября среди кнопок нет', textOf(practice).includes('Выбрано: апрель, май, июнь, июль') && !actions(practice).includes('mo:m:9') && actions(practice).includes('mo:m:8'), textOf(practice))
  check('практика: срок практики назван', textOf(practice).includes('с марта или апреля до конца июля или середины августа'))
  const sep = await send(p, 'mo:m:9')
  check('практика: сентябрь не добавляется даже старой кнопкой', !textOf(sep).includes('сентябрь'))
  const total = textOf(await send(p, 'mo:done'))
  check('практика: итог за 4 месяца по сумме из shared', total.includes(`от ${plain(formatRub(v.pay!.from * 4))} до вычета налога`), total)
}

// ── Правда или миф ──────────────────────────────────────────────────

/** Колода текущей игры из сессии: id карточек */
const deckOf = async (u: DialogUser) => ((await session(u)).data.myth as { deck: string[] } | undefined)?.deck ?? []
const card = (id: string) => myths.find((m) => m.id === id)!

console.log('\nПравда или миф')
{
  const u = user('myth')
  const first = await send(u, 'm:myth')
  const deck = await deckOf(u)
  check(`колода из ${DECK_SIZE} карточек общей колоды, id хранятся в сессии`, deck.length === DECK_SIZE && deck.every((id) => myths.some((m) => m.id === id)), deck)
  check('кнопки «my:<id>:t|f»', actions(first).join() === `my:${deck[0]}:t,my:${deck[0]}:f`, actions(first))
  let wrong = ''
  let r: DialogReply | undefined
  for (let i = 0; i < deck.length; i++) {
    const m = card(deck[i])
    r = await send(u, `my:${m.id}:${m.truth ? 'f' : 't'}`)
    if (i === 0) wrong = textOf(r)
    if (i < deck.length - 1) await send(u, 'my:next')
  }
  const end = textOf(r!)
  const last = card(deck.at(-1)!)
  check('ошибка — «Мимо», без «Не угадано»', wrong.startsWith('Мимо:'), wrong)
  check('итог 0 из 5 и задание засчитано', end.includes(`Итог: 0 из ${DECK_SIZE}`) && (await session(u)).progress.myth !== undefined, end)
  check('в итоге — факт из последней карточки с ошибкой, без «больше многих новичков»', end.includes(last.takeaway) && !end.includes('многих новичков'), end)
  check('в итоге «Позвать друга» отдельной строкой', r!.messages.at(-1)!.buttons!.some((row) => row.length === 1 && row[0].text === 'Позвать друга'))
  check('в итоге — «Путь кваса»', labels(r!).includes('Путь кваса'))
  const stale = await send(u, `my:${deck[0]}:t`)
  check('старая кнопка не ломает игру', stale.messages.length > 0)

  // Повтор: новая колода, кнопки прошлой игры не отвечают за чужую карточку
  const again = await send(u, 'm:myth')
  const deck2 = await deckOf(u)
  check('«Сыграть ещё раз» — новая колода', deck2.join() !== deck.join() && actions(again)[0] === `my:${deck2[0]}:t`, { deck, deck2 })
  const oldId = deck.find((id) => id !== deck2[0])!
  const oldPress = await send(u, `my:${oldId}:t`)
  const st = (await session(u)).data.myth as { i: number; score: number }
  check('кнопка прошлой колоды показывает текущую карточку и не засчитывается', oldPress.notice === 'Этот вопрос уже позади' && textOf(oldPress).includes(card(deck2[0]).claim) && st.i === 0 && st.score === 0, textOf(oldPress))
  const all = deck2.map(card)
  let ok: DialogReply | undefined
  for (let i = 0; i < all.length; i++) {
    ok = await send(u, `my:${all[i].id}:${all[i].truth ? 't' : 'f'}`)
    if (i < all.length - 1) await send(u, 'my:next')
  }
  check('без ошибок — «Без единой ошибки» и 5 из 5', textOf(ok!).includes(`Итог: ${DECK_SIZE} из ${DECK_SIZE}`) && textOf(ok!).includes('Без единой ошибки'), textOf(ok!))
  const same = buildDeck(seeded(3)).map((m) => m.id).join()
  check('колода по одному и тому же rng повторяется', same === buildDeck(seeded(3)).map((m) => m.id).join())

  // Сессия из прошлой версии бота: номер карточки вместо колоды — игра начинается заново
  const legacy = user('myth-legacy')
  await send(legacy, 'm')
  const sess = await session(legacy)
  sess.data.myth = { i: 2, score: 1 }
  await storage.saveSession(legacy, sess)
  const restart = await send(legacy, 'my:2:t')
  check('старая сессия «Правды или мифа» — новая колода с первой карточки', textOf(restart).includes(`Правда или миф · 1 из ${DECK_SIZE}`), textOf(restart))
}

// ── Поймай брак ─────────────────────────────────────────────────────

console.log('\nПоймай брак')
{
  const u = user('game')
  const intro = await send(u, 'm:game')
  check('правила: 4 бутылки, потом 6', textOf(intro).includes('четыре бутылки') && textOf(intro).includes('шесть бутылок'))
  check('брак называется как на сайте', textOf(intro).includes('без крышки, недолив или кривая этикетка'), textOf(intro))
  let r = await send(u, 'g:go')
  type Round = { at: number; count: number; subtle: boolean; kind: string }
  const rounds = ((await session(u)).data.game as { rounds: Round[] }).rounds
  check('раунды 1–2 — четыре бутылки, явный брак', rounds.slice(0, 2).every((x) => x.count === 4 && !x.subtle))
  check('раунды 3–5 — шесть бутылок, тонкий брак', rounds.slice(2).every((x) => x.count === 6 && x.subtle))

  for (let i = 0; i < rounds.length; i++) {
    const m = r.messages.at(-1)!
    const nums = (m.buttons ?? []).flat()
    check(`раунд ${i + 1}: ${rounds[i].count} кнопок и картинка на диске`, nums.length === rounds[i].count && !!m.image && existsSync(m.image.path), m.image?.path)
    if (i === 0) {
      const outOfRange = await send(u, `g:0:${rounds[0].count + 1}`)
      check('номер вне ряда — раунд показывается снова', textOf(outOfRange).includes('Раунд 1 из 5'))
    }
    // Первые три раунда — верно, последние два — мимо: проверяем обе ветки
    const pick = i < 3 ? rounds[i].at + 1 : ((rounds[i].at + 1) % rounds[i].count) + 1
    r = await send(u, `g:${i}:${pick}`)
    if (i === 2) check('тонкая этикетка называется «чуть съехала»', rounds[2].kind !== 'label' || textOf(r).includes('этикетка чуть съехала'))
    if (i === 3) check('промах честно называет брак и номер', textOf(r).startsWith(`Мимо, брак у бутылки ${rounds[3].at + 1}:`), textOf(r))
  }
  check('итог «Поймано 3 из 5»', textOf(r).includes('Поймано 3 из 5'), textOf(r))
  const seenBottles = rounds.reduce((n, x) => n + x.count, 0)
  check(
    `масштаб в итоге: ${seenBottles} бутылок за игру и ${PLANT_BOTTLES_PER_HOUR} в час из shared`,
    textOf(r).includes(`мимо тебя прошло ${seenBottles} бутылок`) && textOf(r).includes(`Завод разливает до ${plain(PLANT_BOTTLES_PER_HOUR.toLocaleString('ru-RU'))} бутылок в час`) && !textOf(r).includes('20 секунд'),
    textOf(r),
  )
  check('в итоге «Позвать друга» отдельной строкой', r.messages.at(-1)!.buttons!.some((row) => row.length === 1 && row[0].text === 'Позвать друга'))
  check('итог: учит наставник — факт из справочника студента', textOf(r).includes('учит наставник'), textOf(r))
  check('рекорд сохранён', (await session(u)).progress.game === 3)
  const stale = await send(u, 'g:4:1')
  check('кнопка из прошлой игры не падает', stale.messages.length > 0)
  const again = await send(u, 'g:go')
  check('новая игра начинается с раунда 1', textOf(again).includes('Раунд 1 из 5'))
}

// ── Путь кваса ──────────────────────────────────────────────────────

console.log('\nПуть кваса')
{
  const u = user('tour')
  let r = await send(u, 'm:tour')
  check('раздел называется «Путь кваса»', textOf(r).startsWith(`**Путь кваса · 1 из ${stages.length}**`), textOf(r))
  for (let i = 1; i <= stages.length; i++) r = await send(u, `t:${i}`)
  check('после последнего этапа — финал «Путь кваса пройден», про сезон и оплачиваемую практику', textOf(r).startsWith('**Путь кваса пройден**') && textOf(r).includes('с марта по сентябрь') && textOf(r).includes('оплачиваемую практику') && !textOf(r).includes('экскурсовод'), textOf(r))
  const v = await send(u, 't:v:1')
  check('вакансии этапа открываются, назад — «Вернуться к пути кваса»', actions(v).some((a) => a.startsWith('v:open:')) && labels(v).includes('Вернуться к пути кваса'), labels(v))
  const typed = await send(user('tour-typed'), 'путь кваса')
  check('«путь кваса» текстом — этап 1 из 8', textOf(typed).startsWith(`**Путь кваса · 1 из ${stages.length}**`), textOf(typed))
  const old = await send(user('tour-old'), 'Экскурсия по заводу')
  check('старое название текстом тоже открывает «Путь кваса»', textOf(old).startsWith('**Путь кваса · 1'), textOf(old))
  const menuReply = await send(u, 'm')
  check('в меню «Путь кваса», без «Экскурсия по заводу»', labels(menuReply).includes('Путь кваса') && !labels(menuReply).includes('Экскурсия по заводу'))
}

// ── Заявка с другом ─────────────────────────────────────────────────

console.log('\nЗаявка')
{
  const u = user('apply', 'telegram', 'Даня')
  await send(u, { type: 'start', payload: 'fair-mgupp' })
  const first = await send(u, 'a:start:bottling-operator')
  check('первый шаг заявки — дата рождения, «Берём с 18 лет»', bare(textOf(first)).startsWith('Заявка на практику или работу') && textOf(first).includes('Берём с 18 лет') && textOf(first).includes('ДД.ММ.ГГГГ'), textOf(first))
  const name = await send(u, ADULT)
  check('после даты — ФИО, с подсказкой поля name и кнопкой имени из профиля', textOf(name).startsWith('Как тебя зовут? Напиши фамилию и имя') && name.messages[0].input === 'name' && labels(name).includes('Меня зовут Даня'), name.messages[0])
  const surname = await send(u, 'a:name')
  check('«Меня зовут Даня» — отдельно спрашиваем фамилию', textOf(surname).startsWith('Даня, напиши фамилию') && (await applyState(u)).step === 'lastName', textOf(surname))
  const phoneAsk = await send(u, 'Петров Сергеевич')
  const named = await applyState(u)
  check('фамилия и отчество через пробел', named.lastName === 'Петров' && named.middleName === 'Сергеевич' && named.name === 'Даня', named)
  check('на шаге телефона — подсказка поля phone', phoneAsk.messages[0].input === 'phone' && buttonsOf(phoneAsk).some((b) => b.kind === 'contact'))
  const bad = await send(u, 'не скажу')
  check('непонятный контакт — подсказка с примером', textOf(bad).includes('например +7 999 123-45-67'), textOf(bad))
  const school = await send(u, '8 916 123 45 67')
  check('после телефона — вуз или колледж и кнопка «Уже не учусь»', textOf(school).startsWith('Где учишься?') && labels(school).includes('Уже не учусь'), textOf(school))
  const longSchool = 'Российский химико-технологический университет имени Д. И. Менделеева'
  const months = await send(u, longSchool)
  check('длинное название вуза — ответ шага, а не вопрос Квасычу', textOf(months).startsWith('Отметь месяцы') && (await applyState(u)).school === longSchool, textOf(months))
  await send(u, 'a:m:6')
  await send(u, 'a:m:7')
  const startAsk = await send(u, 'a:mdone')
  check('когда выйти: варианты из shared и «С июня» по первому месяцу', ['Сразу', 'Через 1–2 недели', 'После сессии', 'С июня', 'С другого месяца'].every((l) => labels(startAsk).includes(l)), labels(startAsk))
  const vacancyAsk = await send(u, 'a:sr:after_session')
  check('после «После сессии» — вакансия из «Откликнуться» уже выбрана', textOf(vacancyAsk).includes('Оператор линии розлива') && labels(vacancyAsk).includes('Оставить эту'), textOf(vacancyAsk))
  const confirm0 = await send(u, 'a:v:bottling-operator')
  const c0 = textOf(confirm0)
  check('проверка: ФИО, дата рождения с возрастом, учёба, выход, месяцы', c0.includes('ФИО: Петров Даня Сергеевич') && c0.includes(`Дата рождения: ${ADULT}, 20 лет`) && c0.includes(`Учёба: ${longSchool}`) && c0.includes('Выход на работу: после сессии') && c0.includes('Месяцы: июнь и июль'), c0)
  check('проверка: «Даю согласие, отправить», ссылки «Текст согласия» и «Политика»', labels(confirm0).includes('Даю согласие, отправить') && linksOf(confirm0).some((l) => l.text === 'Текст согласия' && l.url === `${SITE}/consent`) && linksOf(confirm0).some((l) => l.text === 'Политика' && l.url === `${SITE}/privacy`), linksOf(confirm0))
  check('согласие — в нейтральном роде', c0.includes('ты соглашаешься') && !/согласен|согласна|готов/.test(c0), c0)
  check('переключатели «Практика от вуза», «Хочу остаться после сезона» и «Исправить»', ['Практика от вуза', 'Хочу остаться после сезона', 'Исправить'].every((l) => labels(confirm0).includes(l)), labels(confirm0))

  // Переключатели меняют поля без новых шагов и правят то же сообщение
  const practice = await send(u, 'a:practice')
  check('«Практика от вуза» — отмечено, строка в заявке, то же сообщение', labels(practice).includes('Практика от вуза ✓') && textOf(practice).includes('Практика от вуза: да') && practice.messages[0].replace === true, textOf(practice))
  const stay = await send(u, 'a:stay')
  check('«Хочу остаться после сезона» — отмечено', labels(stay).includes('Хочу остаться после сезона ✓') && textOf(stay).includes('После сезона: хочу остаться'))
  const offAgain = await send(u, 'a:stay')
  check('повторное нажатие снимает отметку', labels(offAgain).includes('Хочу остаться после сезона') && !textOf(offAgain).includes('После сезона'))
  await send(u, 'a:stay')

  // «Исправить»: шаг открывается заново и возвращает к проверке
  const edit = await send(u, 'a:edit')
  check('«Исправить» — список полей', ['ФИО', 'Дата рождения', 'Телефон', 'Учёба', 'Месяцы', 'Выход на работу', 'Вакансия'].every((l) => labels(edit).includes(l)), labels(edit))
  await send(u, 'a:e:name')
  const fixed = await send(u, 'Петров Данила Сергеевич')
  check('исправленное ФИО — сразу проверка, остальное на месте', textOf(fixed).startsWith('**Проверь заявку**') && textOf(fixed).includes('ФИО: Петров Данила Сергеевич') && textOf(fixed).includes('Практика от вуза: да'), textOf(fixed))
  await send(u, 'a:edit')
  await send(u, 'a:e:start')
  await send(u, 'a:sr:month')
  const monthFixed = await send(u, 'a:sm:7')
  check('исправленный выход: «С другого месяца» → месяц → проверка', textOf(monthFixed).includes('Выход на работу: с июля') && textOf(monthFixed).startsWith('**Проверь заявку**'), textOf(monthFixed))
  const back = await send(u, 'a:edit')
  const stillConfirm = await send(u, 'a:e:back')
  check('«Вернуться к проверке» — без изменений', labels(back).includes('Вернуться к проверке') && textOf(stillConfirm).startsWith('**Проверь заявку**'))

  const friendAsk = await send(u, 'a:friend')
  check('про друга: только имя, без обещания одной смены и без контакта', textOf(friendAsk).includes('если получится') && !/телефон|ник/.test(textOf(friendAsk).split('.')[0]), textOf(friendAsk))
  const withPhone = await send(u, 'Оля +7 916 000-11-22')
  check('контакт друга не принимается — просим только имя', textOf(withPhone).startsWith('Нужно только имя друга'), textOf(withPhone))
  const confirm = await send(u, 'Оля')
  check('в заявке видно друга', textOf(confirm).includes('С другом: Оля'))
  const done = await send(u, 'a:ok')
  const app = storage.applications[0]
  check('заявка сохранена', !!app && textOf(done).includes(`Заявка № ${app.id} отправлена`), textOf(done))
  check('channelUserId — id пользователя в мессенджере', app?.channelUserId === 'apply')
  check('телефон +7XXXXXXXXXX, вакансия и источник на месте', app?.phone === '+79161234567' && app?.vacancyId === 'bottling-operator' && app?.source === 'fair-mgupp', app)
  check('поля кейса: фамилия, имя, отчество, дата рождения, вуз, когда выйти', app?.lastName === 'Петров' && app?.name === 'Данила' && app?.middleName === 'Сергеевич' && app?.birthDate === ADULT.split('.').reverse().join('-') && app?.school === longSchool && app?.notStudying === false && app?.startReady === 'month' && app?.startMonth === 7, app)
  check('18+ из даты рождения, согласие с версией и источником', app?.adult === true && app?.consentVersion === CONSENT_VERSION && app?.consentSource === 'telegram' && Boolean(app?.consentAt), app)
  check('практика и «хочу остаться» дошли до заявки', app?.practiceSchool === true && app?.wantsToStay === true, app)
  check('друг — только имя', app?.friend === 'Оля', app?.friend)
  check('код приглашения записан в заявку', /^[a-z2-9]{6}$/.test(app?.refCode ?? ''), app?.refCode)
  check('срок ответа — из responsePromise, «двух рабочих» не захардкожено', textOf(done).includes(`${responsePromise('call')} по номеру +7 916 123-45-67.`), textOf(done))
  check('после заявки — наставник и документы по практике в Учебный центр', textOf(done).includes('прикрепляют наставника') && textOf(done).includes(`Учебный центр, кабинет ${TRAINING_CENTER_ROOM}`), textOf(done))
  check('после заявки — «Позвать друга» и «Путь кваса»', labels(done).includes('Позвать друга') && labels(done).includes('Путь кваса'))
  check('с другом в заявке — напоминание, что заявка нужна и от друга', textOf(done).includes('Заявка нужна и от друга'))
  check('в мессенджер номер и токен заявки не уходят', done.application === undefined)

  // Друг без имени, «Уже не учусь», «Сразу»
  const n = user('apply-friend-noname', 'max', 'Ника')
  await startApply(n)
  await send(n, 'Ника Орлова')
  await send(n, nextPhone())
  await send(n, 'a:nostudy')
  await send(n, 'a:mnone')
  await send(n, 'a:sr:now')
  await send(n, 'a:v:any')
  await send(n, 'a:friend')
  const skip = await send(n, 'a:fskip')
  check('«Без имени» — в заявке «С другом: имя не указано»', textOf(skip).includes('С другом: имя не указано'), textOf(skip))
  check('«Ника Орлова» — имя первым понято по списку имён', textOf(skip).includes('ФИО: Орлова Ника') && textOf(skip).includes('Учёба: Уже не учусь') && textOf(skip).includes('Выход на работу: сразу'), textOf(skip))
  await send(n, 'a:ok')
  const maxApp = storage.applications[0]
  check('заявка из MAX: источник согласия max, без практики, «Уже не учусь»', maxApp?.consentSource === 'max' && maxApp?.practiceSchool === false && maxApp?.wantsToStay === false && maxApp?.notStudying === true && maxApp?.school === '' && maxApp?.startReady === 'now', maxApp)

  // Младше 18 — данные не собираются
  const kid = user('apply-kid', 'telegram', 'Петя')
  const before = storage.applications.length
  await send(kid, 'a:start')
  const no = await send(kid, birth(17))
  const kidSession = await session(kid)
  check('моложе 18 по дате — «Берём с 18 лет», заявка закрыта, данные не сохранены', textOf(no).startsWith('Берём с 18 лет') && textOf(no).includes('не сохраняю') && kidSession.flow === null && kidSession.data.apply === undefined, textOf(no))
  check('после отказа — «Путь кваса» и контрольные вопросы', actions(no).includes('m:tour') && actions(no).includes('m:cq'), actions(no))
  const after = await send(kid, 'Петя')
  check('после отказа имя не собирается: текст уходит не в заявку', !textOf(after).includes('напиши фамилию') && storage.applications.length === before, textOf(after))
  // Границы 18 лет — по сегодняшнему дню по Москве. 29 февраля такой даты 18 лет назад нет — границу в этот день не проверяем
  if (!mskToday().endsWith('-02-29')) {
    const eve = user('apply-kid-eve')
    await send(eve, 'a:start')
    const eveReply = await send(eve, birth(18, 1))
    check('18 исполнится завтра — ещё нельзя', textOf(eveReply).startsWith('Берём с 18 лет'), textOf(eveReply))
    const today = user('apply-birthday')
    await send(today, 'a:start')
    const todayReply = await send(today, birth(18))
    check('18 исполнилось сегодня — дальше к ФИО', textOf(todayReply).startsWith('Как тебя зовут?'), textOf(todayReply))
  }
  const typed17 = user('apply-kid-text')
  await send(typed17, 'a:start')
  const t17 = await send(typed17, 'мне 17')
  check('«мне 17» текстом — тот же отказ', textOf(t17).startsWith('Берём с 18 лет'), textOf(t17))
  const typedYes = user('apply-adult-text')
  await send(typedYes, 'a:start')
  const yes = await send(typedYes, 'да, есть')
  check('«да, есть» — просим дату целиком, шаг тот же', textOf(yes).startsWith('Нужна дата целиком') && (await applyState(typedYes)).step === 'birth', textOf(yes))
  const typo = await send(typedYes, `31.02.${ADULT.slice(-4)}`)
  check('невозможная дата — «Такой даты нет в календаре»', textOf(typo).startsWith('Такой даты нет в календаре'), textOf(typo))
  const old = await send(typedYes, birth(80))
  check('возраст больше 70 — «похоже на опечатку»', textOf(old).includes('похоже на опечатку'), textOf(old))
  const future = await send(typedYes, birth(-1))
  check('дата в будущем — «ещё не наступила»', textOf(future).includes('ещё не наступила'), textOf(future))
  const words = ADULT.split('.')
  const monthWord = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'][Number(words[1]) - 1]
  const byWords = await send(typedYes, `${Number(words[0])} ${monthWord} ${words[2]} г.`)
  check('дата словами «14 мая …» — принята', textOf(byWords).startsWith('Как тебя зовут?') && (await applyState(typedYes)).birthDate === ADULT.split('.').reverse().join('-'), textOf(byWords))
  const legacy = user('apply-legacy')
  await send(legacy, 'm')
  const ls = await session(legacy)
  ls.flow = 'apply'
  ls.data.apply = { step: 'confirm', name: 'Старый', phone: '+79160000000', contact: '', months: [6], vacancyId: '', adult: true }
  await storage.saveSession(legacy, ls)
  const legacyOk = await send(legacy, 'a:ok')
  check('заявка, начатая до шага даты рождения, не уходит — начинается заново', bare(textOf(legacyOk)).startsWith('Заявка на практику или работу') && !storage.applications.some((a) => a.name === 'Старый'), textOf(legacyOk))
  const oldButton = await send(legacy, 'a:adult:y')
  check('старая кнопка «Да, есть 18» — тот же шаг даты рождения', textOf(oldButton).includes('ДД.ММ.ГГГГ') && (await applyState(legacy)).step === 'birth', textOf(oldButton))
}

// ── Портфолио в заявке на офисную вакансию ──────────────────────────

console.log('\nПортфолио')
{
  const a = user('portfolio-yes', 'telegram', 'Алиса')
  const ask = await fillApply(a, { vacancy: 'marketing-intern', name: 'Лебедева Алиса' })
  check('офисная практика — шаг «Ссылка на портфолио» с «Пропустить»', textOf(ask).startsWith('Пришли ссылку на портфолио или нажми «Пропустить»') && labels(ask).includes('Пропустить'), textOf(ask))
  const bad = await send(a, 'мои работы в телеграме')
  check('не ссылка — подсказка с примером', textOf(bad).startsWith('Нужна ссылка, например behance.net'), textOf(bad))
  const long = await send(a, `https://example.com/${'a'.repeat(300)}`)
  check('ссылка длиннее 300 знаков не принимается', textOf(long).startsWith('Нужна ссылка'))
  const ok = await send(a, 'behance.net/alisa')
  check('ссылка видна в проверке заявки', textOf(ok).includes('Портфолио: https://behance.net/alisa'), textOf(ok))
  check('бесплатная практика — «Практика от вуза» отмечена сразу', textOf(ok).includes('Практика от вуза: да') && labels(ok).includes('Практика от вуза ✓'), textOf(ok))
  await send(a, 'a:ok')
  check('портфолио сохранено в заявке', storage.applications[0]?.portfolio === 'https://behance.net/alisa' && storage.applications[0]?.practiceSchool === true, storage.applications[0])

  const b = user('portfolio-skip', 'telegram', 'Боря')
  await fillApply(b, { vacancy: 'marketing-intern', name: 'Борисов Боря' })
  const skipped = await send(b, 'a:noportfolio')
  check('«Пропустить» — сразу проверка заявки', textOf(skipped).startsWith('**Проверь заявку**') && !textOf(skipped).includes('Портфолио'))
  await send(b, 'a:ok')
  check('без портфолио заявка уходит', storage.applications[0]?.name === 'Боря' && !storage.applications[0]?.portfolio, storage.applications[0])

  const c = user('portfolio-none', 'telegram', 'Вика')
  const line = await fillApply(c, { vacancy: 'bottling-operator', name: 'Вика Соколова' })
  check('на линию портфолио не спрашивают', textOf(line).startsWith('**Проверь заявку**'), textOf(line))
  // Портфолио спрашивают ровно там, где его спрашивает форма на сайте (shared asksPortfolio)
  const mismatch: string[] = []
  for (const v of vacanciesByPay) {
    const r = await fillApply(user(`portfolio-${v.id}`, 'telegram', 'Гоша'), { vacancy: v.id, name: 'Гоша Петров' })
    if (textOf(r).startsWith('Пришли ссылку на портфолио') !== asksPortfolio(v)) mismatch.push(v.id)
  }
  check('шаг портфолио совпадает с asksPortfolio для всех вакансий', mismatch.length === 0, mismatch)
}

// ── Позвать друга ───────────────────────────────────────────────────

console.log('\nПозвать друга')
{
  const a = user('referrer', 'telegram', 'Аня')
  const r = await send(a, 'm:friend')
  const t = textOf(r)
  const code = /ref_([a-z0-9]+)/.exec(t)?.[1] ?? ''
  check('без имени бота — ссылка на сайт с меткой', t.includes(`${SITE}/?src=ref_${code}`) && code.length === 6, t)
  check('текст для пересылки честный: вилка практики из вакансий, без бонусов', t.includes(`${plain(practiceRange)} в месяц до вычета налога`) && !/бонус|премия|подарок/i.test(t), t)
  check('в Telegram есть кнопка «Поделиться»', buttonsOf(r).some((b) => b.kind === 'link' && b.url.startsWith('https://t.me/share/url?url=')))
  await send(a, 'm')
  await send(a, 'm:vac')
  const again = textOf(await send(a, 'm:friend'))
  check('код не меняется между заходами', again.includes(`ref_${code}`))

  process.env.TELEGRAM_BOT_USERNAME = '@ochakovo_kvasych_bot'
  const tg = textOf(await send(a, 'm:friend'))
  check('с именем бота — ссылка https://t.me/<бот>?start=ref_<код>', tg.includes(`https://t.me/ochakovo_kvasych_bot?start=ref_${code}`), tg)
  process.env.MAX_BOT_NICK = 'kvasych'
  const max = user('referrer-max', 'max', 'Аня')
  const mx = await send(max, 'm:friend')
  const maxCode = /ref_([a-z0-9]+)/.exec(textOf(mx))?.[1]
  check('в MAX — ссылка https://max.ru/<ник>?start=ref_<код>', textOf(mx).includes(`https://max.ru/kvasych?start=ref_${maxCode}`))
  check('в MAX нет телеграмной кнопки', !buttonsOf(mx).some((b) => b.kind === 'link' && b.url.includes('t.me/share')))
  check('у разных людей разные коды', maxCode !== code)
  const web = textOf(await send(user('referrer-web', 'web'), 'm:friend'))
  check('на сайте — ссылка на сайт и «Скопируй»', web.includes(`${SITE}/?src=ref_`) && web.includes('Скопируй'))
  delete process.env.TELEGRAM_BOT_USERNAME
  delete process.env.MAX_BOT_NICK

  const b = user('invited', 'telegram', 'Оля')
  await send(b, `/start ref_${code}`)
  check('друг по ссылке получает источник friend-<код>', (await session(b)).source === `friend-${code}`)
  await send(b, { type: 'start', payload: 'fair-mgupp' })
  check('первое касание сохраняется', (await session(b)).source === `friend-${code}`)
  await fillApply(b, { name: 'Оля Белова', months: 'none' })
  await send(b, 'a:ok')
  check('заявка друга несёт источник friend-<код>', storage.applications[0]?.source === `friend-${code}`, storage.applications[0])

  await send(a, { type: 'start', payload: `ref_${code}` })
  check('своя ссылка не засчитывается', (await session(a)).source === null)
  const c = user('fresh')
  await send(c, { type: 'start', payload: 'ref_HACK!!' })
  check('мусор в метке очищается и не становится friend-', !String((await session(c)).source).startsWith('friend-'))
}

// ── Чат на сайте ────────────────────────────────────────────────────

console.log('\nЧат на сайте')
{
  const u = user('web-chat', 'web')
  const r = await send(u, { type: 'start' })
  const lines = r.messages[0]?.text.split('\n') ?? []
  check('приветствие на сайте — одно сообщение в две строки', r.messages.length === 1 && lines.length === 2, r.messages)
  check('три главные кнопки и «Ещё»', labels(r).join() === 'Вакансии,Подобрать работу,Откликнуться,Ещё', labels(r))
  check('без картинки и ссылки на сайт', !r.messages[0].image && !buttonsOf(r).some((b) => b.kind === 'link'))
  const more = await send(u, 'm')
  check('«Ещё» — полное меню', labels(more).includes('Поймай брак') && labels(more).includes('Позвать друга'))
  const tg = await send(user('tg-greeting'), { type: 'start' })
  check('в Telegram приветствие — с вилкой практики и отделами', textOf(tg).includes('На оплачиваемой практике платят') && textOf(tg).includes('технологический цех'), textOf(tg))

  // Прогресс со страницы: «Смена» в чате совпадает с сайтом
  const p = user('web-progress', 'web')
  const meta = { siteProgress: { game: true, quiz: true, quizVacancy: 'store-worker', money: true, months: [7, 8], conveyorBest: 9 } }
  const menuReply = await engine.handle(p, { type: 'action', action: 'm' }, meta)
  check('задания с сайта засчитаны: «Смена 3/4»', plain(menuReply.messages[0].text).includes('Смена 3/4. Осталось: «Правда или миф».'), menuReply.messages[0].text)
  const sp = (await session(p)).progress
  check('вакансия из подбора и месяцы перешли в сессию', sp.quiz === 'store-worker' && sp.months?.join() === '7,8' && sp.game === 9, sp)
  const apply = await engine.handle(p, { type: 'action', action: 'a:start' }, meta)
  check('заявка в чате видит прогресс сайта', apply.messages.length > 0 && (await session(p)).flow === 'apply')
  await engine.handle(p, { type: 'action', action: 'x' }, { siteProgress: { myth: true, quizVacancy: 'no-such-id' } })
  const after = (await session(p)).progress
  check('сайт только добавляет: свою вакансию не затирает, выдуманный id не принимается', after.quiz === 'store-worker' && after.myth === 0, after)
  const tgUser = user('tg-progress')
  await engine.handle(tgUser, { type: 'action', action: 'm' }, meta)
  check('прогресс сайта не применяется к Telegram', (await session(tgUser)).progress.game === undefined)

  // То же через HTTP: /api/dialog принимает siteProgress и отбрасывает мусор
  const bots = { get: () => undefined, active: () => [], failed: () => [], start: () => {} } as unknown as Registry
  const app = dialogRoutes({ engine, bots })
  const post = (body: unknown) => app.request('/api/dialog', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const res = await post({ user: { channel: 'web', id: 'web-http' }, event: { type: 'action', action: 'm' }, siteProgress: { game: true, myth: true, months: [1, 7, 'x'], quizVacancy: '../etc' } })
  const json = (await res.json()) as DialogReply
  check('HTTP: прогресс сайта учтён в «Смене»', res.status === 200 && plain(json.messages[0].text).includes('Смена 2/4'), json)
  const http = (await storage.getSession({ channel: 'web', id: 'web-http' })).progress
  check('HTTP: месяцы вне сезона и кривой id отброшены', http.months?.join() === '7' && http.quiz === undefined, http)
  const bad = await post({ user: { channel: 'web', id: 'web-http' }, event: { type: 'action', action: 'm' }, siteProgress: 'всё пройдено' })
  check('HTTP: siteProgress не объект — запрос всё равно обработан', bad.status === 200)

  // Снаружи — только чат на сайте: чужой id из Telegram не открывает чужую заявку
  const spoof = await post({ user: { channel: 'telegram', id: '123456789' }, event: { type: 'text', text: 'что с моей заявкой' } })
  check('HTTP: канал telegram без серверного токена — 403', spoof.status === 403)
  check('HTTP: канал max без серверного токена — 403', (await post({ user: { channel: 'max', id: '42' }, event: { type: 'start' } })).status === 403)
  process.env.DIALOG_API_TOKEN = 'x'.repeat(32)
  const trusted = await app.request('/api/dialog', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dialog-token': 'x'.repeat(32) },
    body: JSON.stringify({ user: { channel: 'telegram', id: 'tg-trusted' }, event: { type: 'start' } }),
  })
  const wrongToken = await app.request('/api/dialog', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dialog-token': 'y'.repeat(32) },
    body: JSON.stringify({ user: { channel: 'telegram', id: 'tg-trusted' }, event: { type: 'start' } }),
  })
  delete process.env.DIALOG_API_TOKEN
  check('HTTP: внешний канал с серверным токеном — 200, с чужим — 403', trusted.status === 200 && wrongToken.status === 403)
}

// ── Подбор работы: результат как на сайте ──────────────────────────

console.log('\nПодбор работы: результат как на сайте')
{
  // Свойства подбора (кто куда попадает) проверяет scripts/tests/c2-facts-quiz.test.ts. Здесь — что бот считает так же, как shared
  const picks = [1, 0, 1, 1]
  const u = user('quiz-same')
  await send(u, 'm:quiz')
  let r: DialogReply | undefined
  for (let step = 0; step < quiz.length; step++) r = await send(u, `q:${step}:${picks[step]}`)
  const id = scoreQuiz(picks.map((a, s) => quiz[s].answers[a]))
  check('бот подбирает ту же вакансию, что scoreQuiz на сайте', textOf(r!).includes(`**${vacancyById(id)!.title}**`) && (await session(u)).progress.quiz === id, { id, text: textOf(r!) })
  check('в итоге подбора — «Откликнуться на эту вакансию» с id', actions(r!).includes(`a:start:${id}`))
}

// ── «Сколько заданий я прошёл?» ─────────────────────────────────────

console.log('\nПрогресс заданий')
{
  const gapsBefore = storage.gaps.length
  const u = user('progress-tg')
  const zero = await send(u, 'скок заданий я уже прошёл?')
  check('«скок заданий я уже прошёл?» — «Смена 0/4» и что осталось', textOf(zero).startsWith('Смена 0/4: заданий пока не пройдено. Осталось «Поймай брак»'), textOf(zero))
  check('в боте — кнопки к четырём заданиям', ['m:game', 'm:money', 'm:quiz', 'm:myth'].every((a) => actions(zero).includes(a)), actions(zero))
  await send(u, 'm:myth')
  const progressDeck = await deckOf(u)
  for (let i = 0; i < progressDeck.length; i++) {
    await send(u, `my:${progressDeck[i]}:t`)
    if (i < progressDeck.length - 1) await send(u, 'my:next')
  }
  for (const q of ['какие задания мне остались', 'что мне ещё осталось пройти', 'мой прогресс']) {
    const r = await send(u, q)
    check(
      `«${q}» — «Смена 1/4», пройдено «Правда или миф», кнопок к нему нет`,
      textOf(r).startsWith('Смена 1/4: пройдено «Правда или миф». Осталось «Поймай брак», «Собери лето» и «Подбор работы».') && !actions(r).includes('m:myth') && actions(r).includes('m:game'),
      textOf(r),
    )
  }
  const job = await send(u, 'какие задания у оператора склада')
  check('«какие задания у оператора склада» — про работу, а не про прогресс', !textOf(job).startsWith('Смена') && textOf(job).includes('Оператор склада'), textOf(job))
  check('вопросы о прогрессе не уходят в пробелы базы', storage.gaps.length === gapsBefore)

  const w = user('progress-web', 'web')
  const meta = { siteProgress: { game: true, quiz: true, money: true, myth: true } }
  const all = await engine.handle(w, { type: 'text', text: 'скок заданий я уже прошёл?' }, meta)
  check('на сайте прогресс берётся со страницы: «Смена 4/4» и «Откликнуться»', plain(all.messages[0].text).startsWith('Смена 4/4: все задания пройдены') && labels(all).includes('Откликнуться'), all.messages[0].text)
  const w2 = user('progress-web-2', 'web')
  const part = await engine.handle(w2, { type: 'text', text: 'сколько заданий я прошла?' }, { siteProgress: { game: true } })
  const links = buttonsOf(part).flatMap((b) => (b.kind === 'link' ? [b.url] : []))
  check('на сайте — ссылки на блоки главной с оставшимися заданиями', plain(part.messages[0].text).startsWith('Смена 1/4') && links.join() === `${SITE}/#money,${SITE}/#quiz,${SITE}/#myth`, links)
}

// ── Вопрос своими словами ───────────────────────────────────────────

console.log('\nВопрос Квасычу')
{
  const u = user('ask')
  await send(u, 'm:ask')
  const r = await send(u, 'Сколько платят на складе?')
  const store = [vacancyById('warehouse-operator')!, vacancyById('storekeeper')!].map((v) => plain(formatRub(v.pay!.from)))
  check('офлайн-ответ с цифрой из вакансий склада', store.some((s) => textOf(r).includes(s)), textOf(r))
}

// ── Вопрос про одну вакансию и честный ответ без данных ─────────────

console.log('\nОдна вакансия и вопросы без ответа')
{
  const u = user('one-vacancy')
  const r = await send(u, 'скок за лето на линии')
  const vacancyButtons = actions(r).filter((a) => a.startsWith('v:open:'))
  check('за лето на линии — сумма в ответе', /\d[\d\s\u00A0\u202F]*₽/.test(textOf(r)), textOf(r))
  check('без стены вакансий: не больше одной кнопки вакансии', vacancyButtons.length <= 1, actions(r))
  const unknown = await send(u, 'есть ли парковка для сотрудников')
  check('нет ответа — не «передал», а контакты и «Откликнуться»', !/передал/i.test(textOf(unknown)) && labels(unknown).includes('Откликнуться'), textOf(unknown))
  const intro = await send(u, 'm:ask')
  check('в «Спросить Квасыча» не обещают передать вопрос', !/передам|передал/.test(textOf(intro)))
}

// ── «Что с моей заявкой» ────────────────────────────────────────────

console.log('\nМоя заявка')
{
  const u = user('status-tg', 'telegram', 'Даня')
  const none = await send(u, 'заявку уже кидал, чо с ней?')
  check('без заявки — прямо так и сказано, кнопка «Откликнуться»', textOf(none).startsWith('Заявки из этого чата я не вижу') && labels(none).includes('Откликнуться'), textOf(none))
  for (const q of ['что с моей заявкой', 'я подавала заявку, когда позвонят?', 'статус заявки']) {
    check(`«${q}» без заявки — тот же честный ответ`, textOf(await send(u, q)).startsWith('Заявки из этого чата я не вижу'))
  }
  const generic = await send(u, 'когда позвонят после заявки?')
  check('«когда позвонят» без заявки — про порядок, а не «не вижу заявки»', !textOf(generic).startsWith('Заявки из этого'), textOf(generic))

  // Заявка из чата: меню сразу меняется
  await fillApply(u, { vacancy: 'store-worker', name: 'Даня Волков', phone: '+7 916 555-44-33' })
  await send(u, 'a:ok')
  const menuAfter = await send(u, 'm')
  check('после заявки в меню «Моя заявка» вместо «Откликнуться»', labels(menuAfter).includes('Моя заявка') && !labels(menuAfter).includes('Откликнуться'), labels(menuAfter))
  check('и без призыва «подставит вакансию в заявку»', !textOf(menuAfter).includes('подставит вакансию в заявку'))

  const app = storage.applications[0]
  const set = (patch: Partial<typeof app>) => Object.assign(app, { status: undefined, interview: undefined, reached: undefined }, patch)
  const ask = async (q = 'заявку уже кидал, чо с ней?') => {
    const r = await send(u, q)
    check(`«${q}» — кнопки «Позвать друга» и «Вакансии»`, labels(r).includes('Позвать друга') && labels(r).includes('Вакансии'), labels(r))
    return textOf(r)
  }

  set({})
  const fresh = await ask()
  check('новая: номер и вакансия первой строкой, «Заявка у отдела персонала», срок звонка конкретным днём', bare(fresh).startsWith(`Заявка № ${app.id} · ${vacancyById('store-worker')!.title}\nЗаявка у отдела персонала.`) && /HR позвонит (сегодня до конца дня|завтра до конца дня|до конца [а-яё]+)\./.test(fresh), fresh)
  check('«когда позвонят?» с заявкой — статус', bare(await ask('когда позвонят?')).startsWith(`Заявка № ${app.id}`))

  set({ createdAt: new Date(Date.now() - 12 * 864e5).toISOString() })
  const overdue = await ask('чё там с моей заявкой')
  check('новая и просроченная: честно «ответа ещё не было» и контакты с номером заявки', overdue.includes('Ответа от HR ещё не было') && overdue.includes(contacts.phone) && overdue.includes(app.id), overdue)

  set({ status: 'no_answer', reached: ['new', 'no_answer'] })
  const missed = await ask('мне так и не позвонили')
  check('«Не дозвонились»: перезвонить, контакты', missed.includes('\nНе дозвонились.') && missed.includes('Перезвони'), missed)

  const startsAt = new Date(Date.now() + 3 * 864e5).toISOString()
  set({ status: 'interview', reached: ['new', 'contacted', 'interview'], interview: { id: 1, startsAt, address: 'Москва, ул. Рябиновая, 44', bring: 'паспорт', attended: '', attendedAt: null, selfBooked: false } })
  const interview = await ask('когда собеседование?')
  check('собеседование: время по Москве, адрес и что взять', interview.includes('\nСобеседование назначено.') && interview.includes('по Москве') && interview.includes('Адрес: Москва, ул. Рябиновая, 44') && interview.includes('Взять с собой: паспорт'), interview)

  set({ status: 'declined', reached: ['new', 'declined'] })
  const closed = await send(u, 'моя заявка')
  check('закрыта: честно и с «Откликнуться» на другую вакансию', textOf(closed).includes('\nЗаявка закрыта.') && labels(closed).includes('Откликнуться'), textOf(closed))

  // Сайт: заявка из формы, чат знает номер и токен браузера
  const webApp = await storage.saveApplication({ ...app, channel: 'web', channelUserId: 'form-browser', name: 'Оля', status: undefined, consent: true, consentVersion: CONSENT_VERSION, consentSource: 'site_form' } as never)
  const w = user('status-web', 'web')
  const meta = { application: { id: webApp.id, token: webApp.statusToken! } }
  const greet = await engine.handle(w, { type: 'start' }, meta)
  check('сайт: в приветствии «Моя заявка» вместо «Откликнуться»', labels(greet).includes('Моя заявка') && !labels(greet).includes('Откликнуться'), labels(greet))
  const webStatus = await engine.handle(w, { type: 'text', text: 'что с заявкой' }, meta)
  check('сайт: статус по номеру и токену', plain(webStatus.messages[0].text).includes(`Заявка № ${webApp.id}`), webStatus.messages[0].text)
  const wrong = await engine.handle(user('status-web-2', 'web'), { type: 'text', text: 'что с заявкой' }, { application: { id: webApp.id, token: 'чужой' } })
  check('сайт: чужой токен — заявку не показываем', plain(wrong.messages[0].text).startsWith('Заявки из этого браузера я не вижу'), wrong.messages[0].text)
  const wrongMenu = await engine.handle(user('status-web-2', 'web'), { type: 'action', action: 'm' }, { application: { id: webApp.id, token: 'чужой' } })
  check('сайт: с чужим токеном в меню по-прежнему «Откликнуться»', labels(wrongMenu).includes('Откликнуться'))
}

// ── Вопрос посреди заявки ──────────────────────────────────────────

console.log('\nВопрос посреди заявки')
{
  const u = user('inside', 'telegram', 'Аня')
  const birthStep = await send(u, 'a:start')
  const early = await send(u, 'а сколько платят?')
  check('вопрос на шаге даты — ответ и «Вернёмся к заявке» с той же кнопкой', /\d[\d\s\u00A0\u202F]*₽/.test(textOf(early)) && early.messages.at(-1)!.text.startsWith('Вернёмся к заявке: напиши дату рождения') && JSON.stringify(early.messages.at(-1)!.buttons) === JSON.stringify(birthStep.messages[0].buttons), textOf(early))
  const askName = await send(u, ADULT)
  const pay = await send(u, 'а сколько платят?')
  const st = (await session(u)).data.apply as { step: string; name: string }
  check('«а сколько платят?» на шаге ФИО — ответ про деньги', /\d[\d\s\u00A0\u202F]*₽/.test(textOf(pay)), textOf(pay))
  check(
    'вторым сообщением «Вернёмся к заявке: напиши фамилию и имя» с теми же кнопками',
    pay.messages.length === 2 && pay.messages[1].text === 'Вернёмся к заявке: напиши фамилию и имя, как в паспорте.' && JSON.stringify(pay.messages[1].buttons) === JSON.stringify(askName.messages[0].buttons),
    pay.messages.at(-1),
  )
  check('имя пустое, шаг тот же', st.step === 'name' && st.name === '', st)
  check('кнопки ответа помощника из заявки не уводят', pay.messages.slice(0, -1).every((m) => !m.buttons?.length))

  // Как пишут ФИО: фамилия первой, имя первым, с отчеством, одно имя
  for (const [typed, expected, step] of [
    ['Иванов Иван Иванович', { lastName: 'Иванов', name: 'Иван', middleName: 'Иванович' }, 'phone'],
    ['Иван Иванович Петров', { lastName: 'Петров', name: 'Иван', middleName: 'Иванович' }, 'phone'],
    ['Аня Смирнова', { lastName: 'Смирнова', name: 'Аня', middleName: '' }, 'phone'],
    ['кузнецова мария', { lastName: 'Кузнецова', name: 'Мария', middleName: '' }, 'phone'],
    ['Анна-Мария', { lastName: '', name: 'Анна-Мария', middleName: '' }, 'lastName'],
    ['меня зовут Аня', { lastName: '', name: 'Аня', middleName: '' }, 'lastName'],
  ] as const) {
    const n = user(`inside-name-${typed}`, 'telegram', 'Аня')
    await startApply(n)
    const r = await send(n, typed)
    const saved = await applyState(n)
    const ok = saved.lastName === expected.lastName && saved.name === expected.name && saved.middleName === expected.middleName && saved.step === step
    check(`«${typed}» — ${[expected.lastName, expected.name, expected.middleName].filter(Boolean).join(' ')}, дальше ${step === 'phone' ? 'телефон' : 'фамилия'}`, ok, { saved, text: textOf(r) })
  }
  const single = user('inside-surname', 'telegram', 'Аня')
  await startApply(single)
  await send(single, 'Аня')
  const full = await send(single, 'Смирнова Анна Сергеевна')
  const fs = await applyState(single)
  check('на шаге фамилии ФИО целиком — имя берётся полное', fs.lastName === 'Смирнова' && fs.name === 'Анна' && fs.middleName === 'Сергеевна' && textOf(full).startsWith('Анна, оставь телефон'), fs)
  const digits = user('inside-digits')
  await startApply(digits)
  const dig = await send(digits, '89161234567')
  check('цифры вместо ФИО — просим буквами, текстом в сообщении', textOf(dig).startsWith('Нужны фамилия и имя буквами') && (await applyState(digits)).step === 'name', textOf(dig))

  // Телефон
  await send(u, 'Смирнова Аня')
  const nophone = await send(u, 'можно без телефона?')
  check('«можно без телефона?» — про ник, шаг phone', textOf(nophone).startsWith('Можно без телефона: напиши ник в Telegram или MAX, например @kvas_fan') && (await applyState(u)).step === 'phone', textOf(nophone))
  const wordy = user('inside-wordy-phone')
  await startApply(wordy)
  await send(wordy, 'Гоша Петров')
  await send(wordy, 'мой номер 8 916 765-43-21')
  check('«мой номер 8 916 …» — номер принят, а не ушёл помощнику', (await applyState(wordy)).phone === '+79167654321')
  const wontGive = await send(u, 'не хочу давать номер')
  check('«не хочу давать номер» — тот же ответ', textOf(wontGive).startsWith('Можно без телефона'))
  const where = await send(u, 'где находится завод?')
  check('вопрос на шаге телефона — ответ и «Вернёмся к заявке»', where.messages.at(-1)!.text.startsWith('Вернёмся к заявке: оставь телефон') && where.messages.at(-1)!.input === 'phone', where.messages.at(-1))
  await send(u, '@anya_kvas')
  const schoolQ = await send(u, 'а практику от колледжа засчитают?')
  check('вопрос на шаге учёбы — ответ и возврат с «Уже не учусь»', schoolQ.messages.at(-1)!.text.startsWith('Вернёмся к заявке: напиши вуз или колледж') && actions({ messages: [schoolQ.messages.at(-1)!] }).includes('a:nostudy'), schoolQ.messages.at(-1))
  const noStudy = await send(u, 'уже не учусь')
  check('«уже не учусь» текстом — как кнопка', (await applyState(u)).notStudying === true && textOf(noStudy).startsWith('Отметь месяцы'), textOf(noStudy))
  const monthsQ = await send(u, 'а ночные смены есть?')
  check('вопрос на шаге месяцев — ответ и возврат с кнопками месяцев', monthsQ.messages.at(-1)!.text.startsWith('Вернёмся к заявке: отметь месяцы') && actions({ messages: [monthsQ.messages.at(-1)!] }).includes('a:mdone'), monthsQ.messages.at(-1))
  await send(u, 'a:mdone')
  const startQ = await send(u, 'а можно выйти после экзаменов?')
  check('вопрос на шаге «когда выйти» — ответ и возврат с вариантами', startQ.messages.at(-1)!.text.startsWith('Вернёмся к заявке: когда сможешь выйти') && actions({ messages: [startQ.messages.at(-1)!] }).includes('a:sr:after_session'), startQ.messages.at(-1))
  await send(u, 'a:sr:two_weeks')
  const store = vacancyById('warehouse-operator')!
  const vacQ = await send(u, 'какая зарплата на складе?')
  check('вопрос на шаге вакансии — ответ по складу и возврат', textOf(vacQ).includes(plain(formatRub(store.pay!.from))) && vacQ.messages.at(-1)!.text.startsWith('Вернёмся к заявке: выбери вакансию'), textOf(vacQ))
  await send(u, 'a:v:marketing-intern')
  const portQ = await send(u, 'а зачем портфолио?')
  check('вопрос на шаге портфолио — ответ и возврат к портфолио', portQ.messages.at(-1)!.text.startsWith('Вернёмся к заявке: пришли ссылку на портфолио') && (await applyState(u)).step === 'portfolio', portQ.messages.at(-1))
  const mine = await send(u, 'что с моей заявкой')
  check('«что с моей заявкой» внутри заявки — статус и возврат к шагу', textOf(mine).startsWith('Заявки из этого чата я не вижу') && mine.messages.at(-1)!.text.startsWith('Вернёмся к заявке'), textOf(mine))

  // Заявку открывают словами
  for (const phrase of ['хочу откликнуться', 'где заявку оставить', 'хочу оставить заявку', 'запиши меня']) {
    const r = await send(user(`open-${phrase}`), phrase)
    check(`«${phrase}» — открывает заявку`, bare(r.messages[0].text).startsWith('Заявка на практику или работу'), r.messages[0].text)
  }
  const status = await send(user('open-status'), 'моя заявка')
  check('«моя заявка» — статус, а не новая заявка', textOf(status).startsWith('Заявки из этого чата я не вижу'), textOf(status))
  const menuFromApply = await send(u, 'Вакансии и зарплаты')
  check('подпись раздела внутри заявки открывает раздел, а не становится ответом', textOf(menuFromApply).startsWith('**Практика и вакансии**') && (await session(u)).flow === null, textOf(menuFromApply))
}

// ── Заявка из чата на сайте ─────────────────────────────────────────

console.log('\nЗаявка из чата на сайте')
{
  const w: DialogUser = { channel: 'web', id: 'web-apply' }
  const meta: HandleMeta = { refCode: 'kvas23' }
  const named = await startApply(w, 'a:start', meta)
  check('на сайте нет кнопки «Меня зовут …»: имени из профиля нет', !labels(named).some((l) => l.startsWith('Меня зовут')), labels(named))
  const confirm = await fillApply(w, { meta, vacancy: 'store-worker', name: 'Оля Морозова', phone: '+7 (926) 123-45-67' })
  check('в веб-чате ссылки на /consent и /privacy сайта', linksOf(confirm).map((l) => l.url).join() === `${SITE}/consent,${SITE}/privacy`)
  const done = await send(w, 'a:ok', meta)
  const app = storage.applications[0]
  check('ответ движка несёт application с токеном', done.application?.id === app.id && typeof done.application?.token === 'string' && done.application.token.length > 20, done.application)
  check('в application — имя, телефон, контакт, вакансия, друг', done.application?.name === 'Оля' && done.application?.phone === '+79261234567' && done.application?.vacancyId === 'store-worker' && done.application?.friend === '' && done.application?.contact === '', done.application)
  check('источник согласия — site_chat, канал web', app.consentSource === 'site_chat' && app.channel === 'web' && app.consentVersion === CONSENT_VERSION, app)
  check('код браузера уходит в заявку', app.refCode === 'kvas23', app.refCode)
  check('memoryStorage нормализует как PostgreSQL: у web нет channelUserId', app.channelUserId === undefined, app)
  const refused = await storage.saveApplication({ ...app, consent: false } as never).then(() => 'сохранено', (e: Error) => e.name)
  check('memoryStorage, как PostgreSQL, не сохраняет заявку без согласия', refused === 'ConsentRequiredError', refused)
  const young = await storage.saveApplication({ ...app, consent: true, consentVersion: CONSENT_VERSION, consentSource: 'site_chat', birthDate: birth(17) } as never).then(() => 'сохранено', (e: Error) => e.name)
  check('memoryStorage, как PostgreSQL, не сохраняет заявку моложе 18', young === 'UnderageError', young)
  const second = await storage.saveApplication({ ...app, consent: true, consentVersion: CONSENT_VERSION, consentSource: 'site_chat', refCode: 'kvas23' } as never)
  check('занятый код приглашения: заявка принята, код не записан', second.refCode === null, second.refCode)
  const status = await send(w, 'Моя заявка', { ...meta, application: { id: done.application!.id, token: done.application!.token } })
  check('после заявки в веб-чате «Моя заявка» начинается с «Заявка №»', bare(textOf(status)).startsWith(`Заявка № ${app.id}`), textOf(status))
  const noToken = await send(w, 'Моя заявка', meta)
  check('браузер не прислал токен — номер заявки и ссылка на «Мою заявку»', textOf(noToken).startsWith(`Заявка № ${app.id}`) && linksOf(noToken).some((l) => l.url === `${SITE}/apply`), textOf(noToken))
  const friend = await send(w, 'm:friend', meta)
  check('веб-чат зовёт друга кодом браузера', textOf(friend).includes(`${SITE}/?src=ref_kvas23`), textOf(friend))
  const own = user('web-own-link', 'web')
  await send(own, { type: 'start', payload: 'ref_kvas23' }, meta)
  check('своя ссылка браузера в веб-чате не засчитывается', (await session(own)).source === null)
}

// ── Заявка словами вместо кнопок ────────────────────────────────────

console.log('\nЗаявка словами')
{
  const u = user('typed-apply')
  await startApply(u)
  await send(u, 'Морозов Илья')
  await send(u, nextPhone())
  const school = await send(u, 'нет')
  check('«нет» на вопрос об учёбе — «Уже не учусь»', (await applyState(u)).notStudying === true && textOf(school).startsWith('Отметь месяцы'), textOf(school))
  const months = await send(u, 'с мая по август')
  check('«с мая по август» — отмечены май — август, кнопки для проверки', textOf(months).includes('Выбрано: май, июнь, июль, август') && actions(months).includes('a:mdone'), textOf(months))
  const unclear = await send(u, 'всё лето')
  check('непонятные месяцы — подсказка текстом в сообщении', textOf(unclear).startsWith('Отметь месяцы кнопками или напиши их словами'), textOf(unclear))
  await send(u, 'a:mdone')
  const start = await send(u, 'после сессии')
  check('«после сессии» текстом — ответ шага, а не вопрос Квасычу', (await applyState(u)).startReady === 'after_session' && textOf(start).startsWith('Выбери вакансию'), textOf(start))
  const v = user('typed-apply-month')
  await startApply(v)
  await send(v, 'Морозова Ира')
  await send(v, nextPhone())
  await send(v, 'Колледж')
  await send(v, 'a:mnone')
  await send(v, 'с июля')
  check('«с июля» текстом — «С определённого месяца», июль', (await applyState(v)).startReady === 'month' && (await applyState(v)).startMonth === 7)
}

// ── Приём заявки: повтор и лимит, как с сайта ───────────────────────

console.log('\nПовтор и лимит заявок')
{
  const phone = nextPhone()
  const a = user('dup-a')
  await fillApply(a, { phone, name: 'Зайцева Полина' })
  await send(a, 'a:ok')
  const firstId = storage.applications[0].id
  const b = user('dup-b')
  await fillApply(b, { phone, name: 'Зайцева Полина' })
  const before = storage.applications.length
  const dup = await send(b, 'a:ok')
  check('тот же телефон за 10 минут — «уже пришла», новой заявки нет', textOf(dup).startsWith('Заявка с этим номером уже пришла') && storage.applications.length === before, textOf(dup))
  check('ответ о повторе не раскрывает номер и данные первой заявки', !textOf(dup).includes(firstId) && !/916|926|Полина|Зайцева/.test(textOf(dup)), textOf(dup))
  check('после повтора заявка закрыта, меню без «Моя заявка»', (await session(b)).flow === null && !(await session(b)).data.applied, (await session(b)).data)

  // Три заявки с одного номера за час — четвёртую не принимаем, подсказываем, когда можно
  const limited = nextPhone()
  for (let i = 0; i < 3; i++) {
    const x = user(`limit-${i}`)
    await fillApply(x, { phone: limited, name: 'Лимитова Вера' })
    await send(x, 'a:ok')
    // Повтор считается за 10 минут: двигаем время прошлой заявки назад, как будто прошло 15 минут
    storage.applications[0].createdAt = new Date(Date.now() - 15 * 60_000).toISOString()
  }
  const sent = storage.applications.filter((x) => x.phone === limited.replace(/\s/g, '')).length
  const y = user('limit-3')
  await fillApply(y, { phone: limited, name: 'Лимитова Вера' })
  const limit = await send(y, 'a:ok')
  check('три заявки за час прошли, четвёртая — «следующую можно отправить через …»', sent === 3 && textOf(limit).includes('за час уже пришло 3 заявки') && /через \d+ минут/.test(textOf(limit)), { sent, text: textOf(limit) })
  check('после лимита заявка остаётся на проверке: ту же кнопку можно нажать позже', (await applyState(y)).step === 'confirm' && actions(limit).includes('a:ok'))
}

// ── Практика ────────────────────────────────────────────────────────

console.log('\nПрактика')
{
  const u = user('practice')
  const paid = await send(u, 'm:prac')
  const t = textOf(paid)
  check('оплачиваемая практика: вилка, срок и четыре отдела из shared', t.startsWith('**Оплачиваемая практика**') && t.toLowerCase().includes(plain(practiceRange)) && t.includes('с начала марта или апреля') && paidPracticeInfo.units.every((u) => t.toLowerCase().includes(u.toLowerCase())), t)
  check('все пять ролей с суммами', paidPractice.every((v) => t.includes(`${v.title}: от ${plain(formatRub(v.pay!.from))}`)), t)
  check('два сообщения: деньги и роли, потом что даёт компания с кнопками', paid.messages.length === 2 && !paid.messages[0].buttons && paid.messages[1].text.startsWith('**Что даёт компания**'), paid.messages.map((m) => m.text.slice(0, 40)))
  check('что даёт компания: общежитие 3 400 ₽, медосмотр, без испытательного срока', t.includes('3 400 ₽') && t.includes('медосмотр') && t.includes('Без испытательного срока'), t)
  check('ночные — «с ночными сменами больше» одной строкой', (t.match(/с ночными сменами больше/g) ?? []).length === 1, t)
  if (existsSync('public/video/manifest.json')) {
    const videos = linksOf(paid).filter((l) => l.url.endsWith('.mp4'))
    check('ролики «Смена изнутри» — ссылки на файлы сайта с длительностью', videos.length >= 2 && videos.every((v) => v.url.startsWith(`${SITE}/video/`) && /· \d:\d\d$/.test(v.text)), videos)
    check('у роликов без речи — подпись «нет речи, только музыка и титры»', t.includes('В них нет речи, только музыка и титры.'), t)
  }
  check('кнопки: бесплатная практика, документы, вакансии практики, откликнуться', ['pr:free', 'pr:docs', 'v:list:0', 'm:apply'].every((a) => actions(paid).includes(a)), actions(paid))
  const free = await send(u, 'pr:free')
  check('бесплатная практика: все задачи из «Описания практики» и направления', freePracticeInfo.tasks.every((task) => textOf(free).includes(task)) && freePractice.every((v) => actions(free).includes(`v:open:${v.id}`)), textOf(free))
  check('бесплатная практика без сумм', !/\d\s?000\s?₽/.test(textOf(free)), textOf(free))
  const docs = await send(u, 'pr:docs')
  check('документы: договор, приказ, дневник, характеристика и кабинет 525', ['Договор', 'Приказ', 'Дневник', 'Характеристика'].every((d) => textOf(docs).includes(d)) && textOf(docs).includes(`кабинет ${TRAINING_CENTER_ROOM}`) && textOf(docs).includes('доб. 1244 или 3105'), textOf(docs))
  const typed = await send(user('practice-typed'), 'Оплачиваемая практика')
  check('«Оплачиваемая практика» текстом открывает раздел', textOf(typed).startsWith('**Оплачиваемая практика**'), textOf(typed))
}

// ── Что ты знаешь об «Очаково» ──────────────────────────────────────

console.log('\nЧто ты знаешь об «Очаково»')
{
  const u = user('company-quiz')
  const first = await send(u, 'm:cq')
  type Cq = { ids: string[]; orders: number[][]; i: number; score: number }
  const st = (await session(u)).data.cq as Cq
  check(`раунд из ${COMPANY_QUIZ_ROUND} вопросов без повторов`, st.ids.length === COMPANY_QUIZ_ROUND && new Set(st.ids).size === COMPANY_QUIZ_ROUND && st.ids.every((id) => companyQuizById(id)), st.ids)
  check('заголовок «Что ты знаешь об «Очаково» · 1 из 7»', textOf(first).startsWith(`**Что ты знаешь об «Очаково» · 1 из ${COMPANY_QUIZ_ROUND}**`), textOf(first))
  const q0 = companyQuizById(st.ids[0])!
  check('кнопки cq:<id>:<вариант> — по одной на вариант', actions(first).filter((a) => a.startsWith(`cq:${q0.id}:`)).length === q0.options.length, actions(first))
  // Отвечаем: первые четыре — верно, остальные — мимо
  let r: DialogReply = first
  let correct = 0
  for (let i = 0; i < st.ids.length; i++) {
    const q = companyQuizById(st.ids[i])!
    const right = i < 4
    const pick = right ? q.answer : (q.answer + 1) % q.options.length
    if (right) correct++
    r = await send(u, `cq:${q.id}:${pick}`)
    const t = textOf(r)
    if (i === 0) check('верный ответ — «Верно.», объяснение и источник', t.startsWith('Верно.') && t.includes(plain(q.explain)) && t.includes(`Источник: ${q.source}.`), t)
    if (i === 4) check('неверный ответ — «Мимо.» и правильный ответ в объяснении', t.startsWith('Мимо.') && t.includes(plain(q.explain)), t)
    if (i === 0) {
      const again = await send(u, `cq:${q.id}:${q.answer}`)
      check('второе нажатие на тот же вопрос не засчитывается', again.notice === 'Этот вопрос уже позади' && ((await session(u)).data.cq as Cq).score === 1)
    }
    if (i < st.ids.length - 1) await send(u, 'cq:next')
  }
  const end = textOf(r)
  check('итог — счёт из companyQuizResult и путь к практике', end.includes(plain(companyQuizResult(correct, COMPANY_QUIZ_ROUND))) && actions(r).includes('m:prac'), end)
  check('лучший счёт сохранён, в «Смену» не входит', (await session(u)).progress.companyQuiz === correct && !textOf(await send(u, 'm')).includes('Смена 1/4'))
  const stale = await send(u, `cq:${st.ids[0]}:0`)
  check('кнопка из прошлого раунда начинает новый раунд', textOf(stale).includes(`1 из ${COMPANY_QUIZ_ROUND}`), textOf(stale))
  // Длинные варианты — списком в тексте, на кнопках номера
  const longQ = st.ids.map((id) => companyQuizById(id)!).find((q) => q.options.some((o) => o.length > 30))
  if (longQ) {
    const s2 = (await session(u)).data.cq as Cq
    const at = s2.ids.indexOf(longQ.id)
    if (at >= 0) {
      s2.i = at
      const sess = await session(u)
      sess.data.cq = s2
      await storage.saveSession(u, sess)
      const shown = await send(u, 'cq:next')
      check('длинные варианты — нумерованным списком, на кнопках номера', /\n1\. /.test(textOf(shown)) && labels(shown).includes('1'), textOf(shown))
    }
  }
}

// ── Заявка с сайта получает ответы в боте (start=app_<токен>) ────────

console.log('\nЗаявка с сайта → бот')
{
  const names = { telegram: 'ochakovo_kvasych_bot', max: 'kvasych' }
  const web = await storage.saveApplication({
    channel: 'web', name: 'Лена', lastName: 'Сайтова', phone: nextPhone(), contact: '', school: 'МГУПП', course: '', department: '', vacancyId: 'lab-chemist', format: '', months: [],
    comment: '', game: { quizResult: null, conveyorBest: 0 }, source: 'vk-ads', birthDate: ADULT.split('.').reverse().join('-'), startReady: 'now',
    consent: true, consentVersion: CONSENT_VERSION, consentSource: 'site_form',
  })
  const links = await storage.createBotLink(web.id, names)
  const token = /start=app_([A-Za-z0-9_-]+)$/.exec(links?.telegram ?? '')?.[1] ?? ''
  check('ссылки на подключённых ботов: t.me и max.ru с start=app_<токен>, до 64 символов', Boolean(links?.telegram?.startsWith('https://t.me/ochakovo_kvasych_bot?start=app_') && links?.max?.startsWith('https://max.ru/kvasych?start=app_') && `app_${token}`.length <= 64 && token.length >= 20), links)
  check('без подключённых ботов ссылки нет', (await storage.createBotLink(web.id, { telegram: null, max: null })) === null)
  const memApp = storage.applications.find((a) => a.id === web.id)!
  check('в хранилище — только хеш токена', memApp.botLinkHash !== token && memApp.botLinkHash?.length === 64)

  const tg = user('linked-tg', 'telegram', 'Лена')
  await send(tg, { type: 'start', payload: 'fair-mgupp' })
  const linked = await send(tg, { type: 'start', payload: `app_${token}` })
  check('привязка: «Заявка № N у HR. Сообщения о ней придут сюда», без имени и телефона', textOf(linked).startsWith(`Заявка № ${web.id} у HR. Сообщения о ней придут сюда.`) && !textOf(linked).includes('Лена') && !textOf(linked).includes(web.phone.slice(-4)), textOf(linked))
  check('app_<токен> не стал источником, первая метка на месте', (await session(tg)).source === 'fair-mgupp')
  check('у заявки канал web и прежний источник, в ней id чата', memApp.channel === 'web' && memApp.source === 'vk-ads' && memApp.botChannel === 'telegram' && memApp.botUserId === 'linked-tg', memApp)
  check('latestApplicationFor видит привязанную заявку', (await storage.latestApplicationFor!('telegram', 'linked-tg'))?.id === web.id)
  const status = await send(tg, 'что с моей заявкой')
  check('«Моя заявка» в боте — статус заявки с сайта', bare(textOf(status)).startsWith(`Заявка № ${web.id} · Лаборант`), textOf(status))

  const other = user('linked-other', 'telegram', 'Чужой')
  const again = await send(other, { type: 'start', payload: `app_${token}` })
  check('повторный токен — нейтральный ответ, без номера заявки', textOf(again).startsWith('Ссылка уже использована или устарела') && !textOf(again).includes(web.id), textOf(again))
  check('повторный токен не привязал второй чат', memApp.botUserId === 'linked-tg' && (await storage.latestApplicationFor!('telegram', 'linked-other')) === null)
  const forged = await send(other, { type: 'start', payload: `app_${'A'.repeat(32)}` })
  check('чужой токен — тот же ответ', textOf(forged) === textOf(again))
  const fresh = await storage.createBotLink(web.id, names)
  const expiredToken = /start=app_([A-Za-z0-9_-]+)$/.exec(fresh?.telegram ?? '')?.[1] ?? ''
  memApp.botLinkExpiresAt = Date.now() - 60_000
  const expired = await send(other, { type: 'start', payload: `app_${expiredToken}` })
  check('просроченный токен — тот же ответ', textOf(expired) === textOf(again), textOf(expired))

  const stopped = await send(tg, '/stop')
  check('/stop отвязывает: сообщения о заявке с сайта сюда больше не придут', textOf(stopped).startsWith('Заявка с сайта отвязана') && memApp.botUserId === null && (await storage.latestApplicationFor!('telegram', 'linked-tg')) === null, textOf(stopped))
  const nothing = await send(tg, '/stop')
  check('/stop второй раз — «выключать нечего»', textOf(nothing).includes('выключать нечего'), textOf(nothing))
  const webStart = await send(user('linked-web', 'web'), { type: 'start', payload: `app_${token}` })
  check('в чате на сайте app_<токен> ничего не привязывает', textOf(webStart).startsWith('Ссылка уже использована') || !textOf(webStart).includes(web.id))
}

// ── «Напомнить о наборе» ────────────────────────────────────────────

console.log('\nНапомнить о наборе')
{
  const u = user('remind-tg')
  const menu0 = await send(u, 'm')
  check('в меню без заявки — «Напомнить о наборе»', actions(menu0).includes('m:remind'), labels(menu0))
  const offer = await send(u, 'm:remind')
  check('текст подписки: когда напишу и как отписаться, без дат', textOf(offer).includes('Напишу, когда откроется набор на сезон и когда до конца приёма останется неделя. Чтобы отписаться, нажми «Не присылать».') && !/\d{1,2}\.\d{2}|\d{4}/.test(textOf(offer)), textOf(offer))
  check('выбор направления: все направления и «Любое»', actions(offer).includes('rm:any') && actions(offer).filter((a) => /^rm:[a-z]+$/.test(a) && a !== 'rm:any' && a !== 'rm:off').length === 6, actions(offer))
  const on = await send(u, 'rm:quality')
  const r = storage.reminds.get('telegram:remind-tg')
  check('подписка: время, направление; кнопка «Не присылать»', Boolean(r?.at) && r?.dept === 'quality' && r?.offAt === null && labels(on).includes('Не присылать') && textOf(on).includes('«Лаборатория»'), { r, text: textOf(on) })
  const menu1 = await send(u, 'm')
  check('подписанному в меню — «Не присылать о наборе» одной кнопкой', actions(menu1).includes('rm:off') && !actions(menu1).includes('m:remind'), labels(menu1))
  const off = await send(u, 'rm:off')
  check('«Не присылать» — одной кнопкой, флаг выключен', Boolean(storage.reminds.get('telegram:remind-tg')?.offAt) && textOf(off).startsWith('Больше не напоминаю о наборе'), textOf(off))
  check('после отписки в меню снова «Напомнить о наборе»', actions(await send(u, 'm')).includes('m:remind'))

  const fair = user('remind-fair')
  const deep = await send(fair, { type: 'start', payload: 'remind-fair-mgupp' })
  check('start=remind-fair-mgupp: источник fair-mgupp и сразу выбор направления', (await session(fair)).source === 'fair-mgupp' && textOf(deep).startsWith('**Напомнить о наборе**'), textOf(deep))
  await send(fair, 'rm:any')
  check('в подписке сохранена исходная метка', storage.reminds.get('telegram:remind-fair')?.source === 'fair-mgupp')
  const plainRemind = user('remind-plain')
  await send(plainRemind, { type: 'start', payload: 'remind' })
  check('start=remind без метки — источника нет', (await session(plainRemind)).source === null)
  const webMenu = await send(user('remind-web', 'web'), 'm')
  check('в чате на сайте подписки нет', !actions(webMenu).includes('m:remind'))
  const withApp = await send(user('apply', 'telegram', 'Даня'), 'm')
  check('с заявкой кнопки подписки нет', labels(withApp).includes('Моя заявка') && !actions(withApp).includes('m:remind'), labels(withApp))
  const game = user('remind-after-game')
  await send(game, 'g:go')
  const rounds = ((await session(game)).data.game as { rounds: { at: number }[] }).rounds
  let end: DialogReply | undefined
  for (let i = 0; i < rounds.length; i++) end = await send(game, `g:${i}:${rounds[i].at + 1}`)
  check('после задания без заявки — «Напомнить о наборе»', actions(end!).includes('m:remind'), labels(end!))
}

// ── Самозапись: кнопки b:… ──────────────────────────────────────────

console.log('\nСамозапись в боте')
{
  const seenParts: string[][] = []
  const withBooking = createEngine(storage, {
    siteUrl: SITE,
    assistant,
    booking: (_ctx, parts) => {
      seenParts.push(parts)
      return { messages: [{ text: 'Выбери время собеседования' }] }
    },
  })
  const r = await withBooking.handle(user('booking'), { type: 'action', action: 'b:list' })
  check('b:list доходит до сценария записи с разобранным действием', seenParts.length === 1 && seenParts[0].join(':') === 'b:list' && r.messages[0].text === 'Выбери время собеседования', seenParts)
  const r2 = await withBooking.handle(user('booking'), { type: 'action', action: 'b:pick:3' })
  check('и любые другие b:… — тоже', seenParts.at(-1)?.join(':') === 'b:pick:3' && r2.messages.length === 1)
  if (!existsSync('server/dialog/flows/booking.ts')) {
    const fallback = await send(user('booking-none'), 'b:list')
    check('без сценария записи — честно: время назначает HR, контакты', textOf(fallback).startsWith('Время собеседования назначает отдел персонала') && textOf(fallback).includes(contacts.phone), textOf(fallback))
  }
}

// ── «Удалить мои данные» ────────────────────────────────────────────

console.log('\nУдалить мои данные')
{
  const u = user('erase-me', 'telegram', 'Стёпа')
  await fillApply(u, { name: 'Удалов Стёпа' })
  await send(u, 'a:ok')
  const app = storage.applications.find((a) => a.channelUserId === 'erase-me')!
  await send(u, 'm:remind')
  await send(u, 'rm:any')
  const status = await send(u, 'моя заявка')
  check('в «Моей заявке» — «Удалить мои данные»', actions(status).includes('del:ask'), labels(status))
  const ask = await send(u, 'del:ask')
  check('сначала подтверждение: что сотру и что это нельзя отменить', textOf(ask).includes('отменить удаление нельзя') && actions(ask).includes('del:yes') && actions(ask).includes('x'), textOf(ask))
  const usersBefore = storage.botUsers.size
  const done = await send(u, 'del:yes')
  // Запись аудитории — сразу после удаления: следующее сообщение человека снова запишет имя из мессенджера, как в PostgreSQL
  const audience = { size: storage.botUsers.size, me: storage.botUsers.get('telegram:erase-me') }
  const s = await session(u)
  check('после «Да, удалить» — заявка обезличена, диалог и подписка удалены', Boolean(app.anonymizedAt) && app.name === '' && app.phone === '' && s.flow === null && Object.keys(s.data).length === 0 && !storage.reminds.has('telegram:erase-me'), { app, s })
  check('запись аудитории осталась без имени и ника: счётчики не меняются', audience.size === usersBefore && audience.me?.username === null && audience.me?.firstName === null, audience)
  check('ответ без данных и с «/start»', textOf(done).startsWith('Заявки, история разговора и подписка удалены') && !textOf(done).includes('Стёпа'), textOf(done))
  const cmd = await send(user('erase-cmd'), '/delete')
  check('/delete — то же подтверждение', actions(cmd).includes('del:yes'))
  const webDel = await send(user('erase-web', 'web'), '/delete')
  check('на сайте — «Моя заявка» и контакты, без удаления', textOf(webDel).startsWith('Заявку с сайта удаляют на странице «Моя заявка»') && !actions(webDel).includes('del:yes'), textOf(webDel))
}

// ── Подготовка и первая смена в «Моей заявке» ───────────────────────

console.log('\nПервая смена и подготовка')
{
  const u = user('first-shift', 'telegram', 'Рита')
  await fillApply(u, { vacancy: 'bottling-operator', name: 'Рита Сменова' })
  await send(u, 'a:ok')
  const app = storage.applications.find((a) => a.channelUserId === 'first-shift')!
  const fresh = textOf(await send(u, 'моя заявка'))
  check('новая заявка — без «Первая смена» и «Как подготовиться»', !fresh.includes('Первая смена') && !fresh.includes('Как подготовиться'), fresh)
  const at = new Date(Date.now() + 5 * 864e5)
  at.setUTCHours(5, 0, 0, 0)
  Object.assign(app, { status: 'hired', reached: ['new', 'contacted', 'interview', 'hired'], firstShiftAt: at.toISOString(), shiftKind: 'day' })
  const hired = textOf(await send(u, 'моя заявка'))
  const day = at.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long' })
  check('«К оформлению» с датой: «Первая смена» с датой и «Как подготовиться к оформлению»', hired.includes(`Первая смена: `) && hired.includes(day) && hired.includes('дневная смена') && hired.includes('**Как подготовиться к оформлению**'), hired)
  check('медкнижка — у вакансии рядом с продуктом', hired.includes('медицинская книжка'), hired)
  Object.assign(app, { status: 'interview', firstShiftAt: null, interview: null, startReady: 'month', startMonth: 7 })
  const interview = textOf(await send(u, 'моя заявка'))
  check('собеседование без даты смены — «не раньше июля» и подготовка к собеседованию', interview.includes('Первая смена: не раньше июля') && interview.includes('**Как подготовиться к собеседованию**'), interview)
}

// ── Цифры и тексты из shared ────────────────────────────────────────

console.log('\nЦифры из shared')
{
  const u = user('shared-numbers')
  const list = await send(u, 'v:list:0')
  check('вводный текст вакансий — сноска об источниках сумм из shared', textOf(list).includes(plain(estimateNote)), textOf(list))
  const months = await send(u, 'mo:r:0')
  const v = vacancyById(roles[0])!
  const line = perShiftLine(v)
  const sp = shiftPay(v)
  check('строка «за смену» в «Собери лето» — из shiftPay', sp ? textOf(months).includes(plain(line)) && line.startsWith(`≈ ${formatRub(sp.perShift)} на руки за смену`) : !textOf(months).includes('за смену'), textOf(months))
  const done = await send(u, 'mo:done')
  check('в итоге «Собери лето» — «Позвать друга»', labels(done).includes('Позвать друга'))
  check('график из scheduleLine в «Собери лето»', textOf(months).includes('График: '), textOf(months))
}

// ── Правила текстов ─────────────────────────────────────────────────

console.log('\nПравила текстов')
{
  const texts = [...seen]
  const rules: [string, RegExp][] = [
    ['восклицательные знаки', /[а-яё»]!/i],
    ['многоточия', /…|\.\.\./],
    ['эмодзи', /\p{Extended_Pictographic}/u],
    ['гендерные скобки', /\((а|на|ла)\)/],
    ['мужской род для собеседника', /(?<![а-яё])(согласен|готов|поймал|нашёл)(?![а-яё])/i],
    ['вступления', /Всё просто|Отличный вопрос|Давай разберёмся/],
    ['пиво и алкоголь', /(?<![а-яё])пив[оа](?![а-яё])|алкогол/i],
    ['«Не угадано»', /Не угадано/],
  ]
  for (const [name, re] of rules) {
    const bad = texts.filter((t) => re.test(t) && !t.startsWith('Я рассказываю только про работу'))
    check(`нет: ${name}`, bad.length === 0, bad.map((t) => t.slice(0, 120)))
  }
  check(`прочитано ${texts.length} разных сообщений`, texts.length > 60)
  check('не больше трёх кнопок в ряду во всех ответах', widestRow <= 3, widestRow)
}

console.log(`\n${passed} прошло, ${failed} упало`)
if (failed) process.exit(1)
