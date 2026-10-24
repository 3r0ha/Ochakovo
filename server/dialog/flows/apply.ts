import {
  CONSENT_VERSION,
  checkApplication,
  isStartMonth,
  normalizePortfolio,
  NOT_STUDYING_LABEL,
  startReadyLabel,
  startReadyOptions,
  type ApplicationInput,
  type ConsentSource,
  type StartReady,
} from '@shared/applications'
import { ageOn, ageWords, birthDateMessages, birthDateProblem, formatBirthDate, parseBirthDate } from '@shared/birthDate'
import { responsePromise } from '@shared/candidateStatus'
import { isHiringLabel } from '../../booking'
import { SEASON, TRAINING_CENTER_ROOM } from '@shared/content/handbook'
import { asksPortfolio, openVacancyById, vacanciesByPay, vacancyById } from '@shared/content/vacancies'
import { formatPhone, parsePhone } from '@shared/phone'
import { PER_HOUR } from '../../candidate/intake'
import { reply, setState, siteBase, state, type Ctx } from '../context'
import { asName, looksLikeQuestion, parseAdult, refusesPhone } from '../intent'
import { dateFromWords, fullNameLine, parseFullName, parseLastName } from '../names'
import { doneCount } from '../progress'
import { btn, cancelRow, contactButton, link, menuRow, monthButtons, monthList, monthsPhrase, msg, plural, rows, toggle } from '../ui'
import type { Button, DialogReply, OutMessage } from '../types'
import * as ask from './ask'
import { refCode } from './friend'
import { APPLIED_KEY, show as showStatus, statusIntent } from './status'
import { TOUR_TITLE } from './tour'
import { payText } from './vacancies'

// Заявка в чате по полям кейса: дата рождения (с 18 лет) → ФИО → телефон или ник → вуз или колледж → месяцы →
// когда выйти → вакансия → (портфолио) → проверка и согласие → сохранение через acceptApplication, как с сайта.
// Дата рождения — первым шагом: моложе 18 дальше не идём и ничего не храним.
// На любом шаге с вводом текста вопрос не становится ответом: Квасыч отвечает и возвращает к тому же шагу.
// С экрана проверки любое поле можно исправить: шаг открывается заново и возвращает к проверке.

const KEY = 'apply'
type Step = 'birth' | 'name' | 'lastName' | 'phone' | 'school' | 'months' | 'start' | 'startMonth' | 'vacancy' | 'portfolio' | 'confirm' | 'friend'
type ApplyState = {
  step: Step
  /** Дата рождения YYYY-MM-DD, уже проверенная на 18+ */
  birthDate?: string
  /** Дата так, как её ввели: checkApplication проверяет ввод, а не нормализованное значение */
  birthTyped?: string
  name: string
  lastName?: string
  middleName?: string
  phone: string
  contact: string
  /** Вуз или колледж; при notStudying — пусто */
  school?: string
  notStudying?: boolean
  months: number[]
  startReady?: StartReady
  startMonth?: number
  vacancyId: string
  /** «Иду с другом»: имя друга или FRIEND_NO_NAME. Контакт друга не спрашиваем — согласия на его данные нет */
  friend?: string
  /** Ссылка на портфолио — только для вакансий, где её спрашивает сайт, необязательно */
  portfolio?: string
  /** Месяцы подставлены из «Собери лето» */
  monthsFromTask?: boolean
  /** Переключатели на экране проверки */
  practice?: boolean
  stay?: boolean
  /** Шаг открыт кнопкой «Исправить»: после него — снова проверка */
  back?: 'confirm'
}

/** Что пишем в поле «друг», если человек идёт с другом, но имя не назвал */
export const FRIEND_NO_NAME = 'имя не указано'

/** Подпись раздела контрольных вопросов — та же кнопка в меню и после отказа по возрасту */
export const COMPANY_QUIZ_TITLE = 'Что ты знаешь об «Очаково»'

const consentSource: Record<Ctx['user']['channel'], ConsentSource> = { web: 'site_chat', telegram: 'telegram', max: 'max' }

function save(ctx: Ctx, s: ApplyState) {
  setState(ctx, KEY, s)
  ctx.session.flow = 'apply'
}

function finish(ctx: Ctx) {
  setState(ctx, KEY, undefined)
  ctx.session.flow = null
}

/** Следующий шаг: после исправления поля — сразу проверка */
const after = (s: ApplyState, next: Step): Step => (s.back === 'confirm' ? 'confirm' : next)

/** Шаг закончен: сохранить и показать следующий */
function advance(ctx: Ctx, s: ApplyState, next: Step, notice?: string) {
  const n: ApplyState = { ...s, step: after(s, next) }
  if (n.step === 'confirm') delete n.back
  save(ctx, n)
  return send(promptFor(ctx, n), notice)
}

// ── Сообщения шагов. Каждое — вопрос шага и его кнопки: их же повторяем после ответа на вопрос ────

type Prompt = { question: string; text: string; buttons: Button[][]; input?: OutMessage['input'] }

const DATE_HINT = 'ДД.ММ.ГГГГ'

/**
 * Подсказка поля на шаге даты рождения: в чате на сайте — цифровая клавиатура и маска ДД.ММ.ГГГГ.
 * Адаптеры Telegram и MAX подсказку не используют
 */
const BIRTH_INPUT: OutMessage['input'] = 'date'

function birthPrompt(s?: ApplyState): Prompt {
  return {
    question: `напиши дату рождения цифрами в формате ${DATE_HINT}.`,
    text: s?.back
      ? `Напиши дату рождения цифрами: ${DATE_HINT}.`
      : `**Заявка на практику или работу**\n\nЗаймёт пару минут, резюме не нужно. Берём с 18 лет, поэтому сначала напиши дату рождения цифрами в формате ${DATE_HINT}.`,
    buttons: [cancelRow()],
    input: BIRTH_INPUT,
  }
}

function namePrompt(ctx: Ctx): Prompt {
  const first = asName(ctx.user.firstName ?? '')
  return {
    question: 'напиши фамилию и имя, как в паспорте.',
    text: 'Как тебя зовут? Напиши фамилию и имя, как в паспорте, и отчество, если оно есть.',
    buttons: [...(first && !first.includes(' ') ? [[btn(`Меня зовут ${first}`.slice(0, 60), 'a:name')]] : []), cancelRow()],
    input: 'name',
  }
}

function lastNamePrompt(s: ApplyState): Prompt {
  return {
    question: 'напиши фамилию.',
    text: `${s.name}, напиши фамилию. Если есть отчество, добавь его через пробел.`,
    buttons: [cancelRow()],
    input: 'name',
  }
}

function phonePrompt(s: ApplyState): Prompt {
  return {
    question: 'оставь телефон или ник в Telegram или MAX.',
    text: `${s.name}, оставь телефон, по нему позвонит HR. Нажми кнопку, чтобы отправить номер, или напиши его. Если удобнее переписка, напиши ник в Telegram или MAX.`,
    buttons: [[contactButton('Отправить номер')], cancelRow()],
    input: 'phone',
  }
}

function schoolPrompt(): Prompt {
  return {
    question: 'напиши вуз или колледж или нажми «Уже не учусь».',
    text: `Где учишься? Напиши вуз или колледж, можно сокращённо. Если учёба позади, нажми «${NOT_STUDYING_LABEL}».`,
    buttons: [[btn(NOT_STUDYING_LABEL, 'a:nostudy')], cancelRow()],
    input: 'free',
  }
}

function monthsPrompt(s: ApplyState): Prompt {
  const chosen = s.months.length ? `Выбрано: ${monthList(s.months)}.` : 'Пока ничего не выбрано.'
  const lead = s.monthsFromTask
    ? 'Месяцы из «Собери лето» уже отмечены. Поправь, если планы другие.'
    : `Отметь месяцы, когда можешь работать, можно несколько. Сезон на заводе длится ${SEASON.text}.`
  return {
    question: 'отметь месяцы кнопками.',
    text: `${lead}\n\n${chosen}`,
    buttons: [...monthButtons(s.months, 'a:m:'), [btn('Готово', 'a:mdone'), btn('Пока не знаю', 'a:mnone')], cancelRow()],
  }
}

const startLabel = (id: StartReady) => startReadyOptions.find((o) => o.id === id)!.label

function startPrompt(s: ApplyState): Prompt {
  // Первый отмеченный месяц — готовая кнопка «С июня», чтобы не выбирать его второй раз
  const first = [...s.months].sort((a, b) => a - b)[0]
  const fromFirst = first ? [btn(startReadyLabel('month', first), `a:sm:${first}`)] : []
  return {
    question: 'когда сможешь выйти на работу?',
    text: 'Когда сможешь выйти на работу?',
    buttons: [
      [btn(startLabel('now'), 'a:sr:now'), btn(startLabel('two_weeks'), 'a:sr:two_weeks')],
      [btn(startLabel('after_session'), 'a:sr:after_session'), ...fromFirst],
      [btn(first ? 'С другого месяца' : startLabel('month'), 'a:sr:month')],
      cancelRow(),
    ],
  }
}

const shortMonths = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек']

function startMonthPrompt(): Prompt {
  return {
    question: 'выбери месяц, с которого сможешь выйти.',
    text: 'С какого месяца сможешь выйти?',
    buttons: [...rows(shortMonths.map((m, i) => btn(m, `a:sm:${i + 1}`)), 3), cancelRow()],
  }
}

function vacancyPrompt(s: ApplyState): Prompt {
  const picked = s.vacancyId ? vacancyById(s.vacancyId) : undefined
  return {
    question: 'выбери вакансию.',
    text: picked
      ? `Вакансия: **${picked.title}**, ${payText(picked)}. Оставить её или выбрать другую.`
      : 'Выбери вакансию. Если не знаешь, нажми «Любая подходящая», и HR предложит варианты.',
    buttons: [
      ...(picked ? [[btn('Оставить эту', `a:v:${picked.id}`)]] : []),
      [btn('Любая подходящая', 'a:v:any'), btn('Выбрать из списка', 'a:vl')],
      cancelRow(),
    ],
  }
}

function portfolioPrompt(error = false): Prompt {
  return {
    question: 'пришли ссылку на портфолио или нажми «Пропустить».',
    text: error
      ? 'Нужна ссылка, например behance.net/твоё-имя или github.com/ник. Файл прикрепить нельзя, только ссылку.'
      : 'Пришли ссылку на портфолио или нажми «Пропустить». Подойдёт GitHub, Behance, учебный проект или папка на диске.',
    buttons: [[btn('Пропустить', 'a:noportfolio')], cancelRow()],
    input: 'free',
  }
}

function friendPrompt(error = false): Prompt {
  return {
    question: 'напиши имя друга или нажми «Без имени».',
    text: error
      ? 'Нужно только имя друга, без телефона и ника. Свою заявку друг оставит отдельно.'
      : 'Как зовут друга? HR увидит, что вы хотите работать вместе. В одну смену вас поставят, если получится, это обсудят на собеседовании. Заявка нужна и от друга, ссылку для него дам после отправки.',
    buttons: [[btn('Без имени', 'a:fskip'), btn('Без друга', 'a:nofriend')], cancelRow()],
    input: 'free',
  }
}

/** Переключатель на экране проверки: отмечен — с галочкой, как месяцы */
const toggleButton = (label: string, on: boolean | undefined, action: string) => btn(on ? `${label} ✓` : label, action)

const lowerFirst = (t: string) => t.charAt(0).toLowerCase() + t.slice(1)

/** «ДД.ММ.ГГГГ, 20 лет» */
function birthLine(birthDate: string) {
  const age = ageOn(birthDate)
  return `${formatBirthDate(birthDate)}${age !== null ? `, ${ageWords(age)}` : ''}`
}

function confirmPrompt(ctx: Ctx, s: ApplyState): Prompt {
  const v = s.vacancyId ? vacancyById(s.vacancyId) : undefined
  const lines = [
    `ФИО: ${fullNameLine(s)}`,
    ...(s.birthDate ? [`Дата рождения: ${birthLine(s.birthDate)}`] : []),
    s.phone ? `Телефон: ${formatPhone(s.phone)}` : `Связь: ${s.contact}`,
    `Учёба: ${s.notStudying ? NOT_STUDYING_LABEL : s.school || 'не указана'}`,
    `Выход на работу: ${lowerFirst(startReadyLabel(s.startReady, s.startMonth)) || 'не указан'}`,
    `Месяцы: ${s.months.length ? monthsPhrase(s.months) : 'обсудим с HR'}`,
    `Вакансия: ${v ? v.title : 'любая подходящая'}`,
    ...(s.portfolio ? [`Портфолио: ${s.portfolio}`] : []),
    ...(s.friend ? [`С другом: ${s.friend}`] : []),
    ...(s.practice ? ['Практика от вуза: да'] : []),
    ...(s.stay ? ['После сезона: хочу остаться'] : []),
    `Смена: ${doneCount(ctx.session.progress)}/4`,
  ]
  const base = siteBase(ctx)
  return {
    question: 'проверь заявку и нажми «Даю согласие, отправить».',
    text:
      `**Проверь заявку**\n\n${lines.join('\n')}\n\n` +
      'Кнопкой «Даю согласие, отправить» ты соглашаешься на обработку персональных данных для рассмотрения заявки и на связь по телефону, в мессенджере или по SMS. ' +
      'Текст согласия и политика открываются по кнопкам ниже.',
    buttons: [
      [btn('Даю согласие, отправить', 'a:ok')],
      [toggleButton('Практика от вуза', s.practice, 'a:practice')],
      [toggleButton('Хочу остаться после сезона', s.stay, 'a:stay')],
      s.friend ? [btn('Исправить', 'a:edit')] : [btn('Иду с другом', 'a:friend'), btn('Исправить', 'a:edit')],
      [link('Текст согласия', `${base}/consent`), link('Политика', `${base}/privacy`)],
      cancelRow(),
    ],
  }
}

/** «Исправить» на экране проверки: какое поле открыть заново */
function editPrompt(): Prompt {
  return {
    question: 'выбери, что исправить.',
    text: 'Что исправить?',
    buttons: [
      [btn('ФИО', 'a:e:name'), btn('Дата рождения', 'a:e:birth')],
      [btn('Телефон', 'a:e:phone'), btn('Учёба', 'a:e:school')],
      [btn('Месяцы', 'a:e:months'), btn('Выход на работу', 'a:e:start')],
      [btn('Вакансия', 'a:e:vacancy')],
      [btn('Вернуться к проверке', 'a:e:back')],
    ],
  }
}

/** Вопрос текущего шага и его кнопки */
function promptFor(ctx: Ctx, s: ApplyState): Prompt {
  switch (s.step) {
    case 'birth':
      return birthPrompt(s)
    case 'name':
      return namePrompt(ctx)
    case 'lastName':
      return lastNamePrompt(s)
    case 'phone':
      return phonePrompt(s)
    case 'school':
      return schoolPrompt()
    case 'months':
      return monthsPrompt(s)
    case 'start':
      return startPrompt(s)
    case 'startMonth':
      return startMonthPrompt()
    case 'vacancy':
      return vacancyPrompt(s)
    case 'portfolio':
      return portfolioPrompt()
    case 'friend':
      return friendPrompt()
    case 'confirm':
      return confirmPrompt(ctx, s)
  }
}

const asMessage = (p: Prompt, extra: Partial<OutMessage> = {}): OutMessage => msg(p.text, { buttons: p.buttons, ...(p.input ? { input: p.input } : {}), ...extra })

/** Сообщение шага ответом движка */
const send = (p: Prompt, notice?: string, extra: Partial<OutMessage> = {}) => reply(asMessage(p, extra), notice)

/**
 * Ошибка ввода и тот же шаг с его кнопками. Текст ошибки — в самом сообщении: всплывающее уведомление Telegram и MAX
 * показывают только в ответ на кнопку, а ошибка здесь — в ответ на текст. withPrompt — добавить вопрос шага:
 * когда ошибка пришла с экрана проверки и человек не видел этого шага
 */
const retry = (p: Prompt, error: string, withPrompt = false) =>
  reply(
    msg(`${error.replace(/\.$/, '')}.${withPrompt ? `\n\n${p.text.replace(/^\*\*[^*]+\*\*\n\n/, '')}` : ''}`, {
      buttons: p.buttons,
      ...(p.input ? { input: p.input } : {}),
    }),
  )

/** «Вернёмся к заявке: …» — тот же шаг, те же кнопки */
const backToStep = (p: Prompt): OutMessage => msg(`Вернёмся к заявке: ${p.question}`, { buttons: p.buttons, ...(p.input ? { input: p.input } : {}) })

/**
 * Вопрос посреди заявки: отвечаем по теме и возвращаем к шагу. Кнопки ответа убираем —
 * «Откликнуться» или «Вакансия» из ответа увели бы из заявки, а шаг потерялся бы
 */
async function answerInside(ctx: Ctx, s: ApplyState, text: string): Promise<DialogReply> {
  const personal = statusIntent(text) === 'personal'
  const answer = personal ? await showStatus(ctx) : await ask.answer(ctx, text)
  const texts = answer.messages.map((m) => msg(m.text, m.image ? { image: m.image } : {}))
  return reply([...texts, backToStep(promptFor(ctx, s))])
}

// ── Разбор ввода ─────────────────────────────────────────────────────────

/** Телефон в виде +7XXXXXXXXXX (shared/phone) или null. «Мой номер 8 916 …» — слова вокруг номера отбрасываем */
function phoneOf(text: string) {
  for (const candidate of [text, text.replace(/[^\d+()\s-]/g, ' ').trim()]) {
    const r = parsePhone(candidate)
    if (r && 'e164' in r) return r.e164
  }
  return null
}

const parseHandle = (text: string) => (/^@[A-Za-z0-9_.]{3,64}$/.test(text.trim()) ? text.trim() : null)

/** Имя друга без телефонов, ников, почты и ссылок: данные друга без его согласия не храним */
function friendName(text: string) {
  const raw = text.trim()
  if (/\d{3}|@|https?:|www\.|\.ru\b|\.com\b/i.test(raw)) return null
  return asName(raw)
}

/** «Уже не учусь» словами: «не учусь», «нет», «нигде», «уже закончил», «выпускница» */
const notStudying = (text: string) =>
  /^(нет|не\s+учусь(\s+сейчас)?|уже\s+не\s+учусь|сейчас\s+не\s+учусь|нигде|(уже\s+)?(закончил[аи]?|окончил[аи]?)(\s+учёбу|\s+учебу)?|выпускни(к|ца))$/i.test(
    text.trim().replace(/[.!]+$/, ''),
  )

/** Месяцы словами: «июнь, июль», «с мая по август» — номера 3–9 в порядке года; пусто — месяцев в тексте нет */
function monthsFromText(text: string): number[] {
  const t = text.toLowerCase().replace(/ё/g, 'е')
  const found = new Set<number>()
  const stems: [RegExp, number][] = [[/март/, 3], [/апрел/, 4], [/(^|[^а-я])ма[йяюе]([^а-я]|$)/, 5], [/июн/, 6], [/июл/, 7], [/август/, 8], [/сентябр/, 9]]
  for (const [re, m] of stems) if (re.test(t)) found.add(m)
  const list = [...found].sort((a, b) => a - b)
  // «с мая по август» — весь промежуток
  if (/(^|\s)с\s/.test(t) && /\sпо\s/.test(t) && list.length === 2) return Array.from({ length: list[1] - list[0] + 1 }, (_, i) => list[0] + i)
  return list
}

/** «Сразу», «через 1–2 недели», «после сессии» словами — готовность выйти; null — не понять */
function startFromText(text: string): StartReady | null {
  const t = text.toLowerCase().replace(/ё/g, 'е').trim()
  if (/^(сразу|сейчас|хоть\s+завтра|в\s+любое\s+время|уже\s+сейчас)/.test(t)) return 'now'
  if (/через\s+(1|2|одну|две|пару|1-2|1–2)\s*(-|–)?\s*(2\s*)?недел/.test(t)) return 'two_weeks'
  if (/после\s+(сессии|экзаменов|зачетов)/.test(t)) return 'after_session'
  return null
}

/** Вуз или колледж: буквы, без телефона, ника и ссылки. «МГУПП», «Колледж № 54», «РХТУ им. Менделеева» */
function schoolName(text: string) {
  const raw = text.trim().replace(/\s+/g, ' ')
  if (raw.length < 2 || raw.length > 200 || !/\p{L}{2}/u.test(raw)) return null
  if (/\d{5}|@|https?:|www\./i.test(raw)) return null
  return raw
}

// ── Шаги ─────────────────────────────────────────────────────────────────

/** Заявка начата до шага даты рождения (старая сессия): без проверки возраста дальше не идём — начинаем заново */
const needsBirth = (s: ApplyState) => s.step !== 'birth' && !s.birthDate

export function start(ctx: Ctx, vacancyId = '') {
  const fromQuiz = ctx.session.progress.quiz ?? ''
  const fromTask = ctx.session.progress.months
  const v = openVacancyById(vacancyId) ?? openVacancyById(fromQuiz)
  save(ctx, {
    step: 'birth',
    name: '',
    phone: '',
    contact: '',
    months: fromTask?.length ? [...fromTask] : [],
    monthsFromTask: Boolean(fromTask?.length),
    vacancyId: v?.id ?? '',
    // Бесплатная практика — всегда практика от вуза или колледжа
    practice: v?.format === 'Бесплатная практика' ? true : undefined,
  })
  return send(birthPrompt())
}

/** Моложе 18: заявку не принимаем и ничего из неё не храним */
function underage(ctx: Ctx) {
  finish(ctx)
  return reply(
    msg(`${birthDateMessages.underage}. Данные из заявки я не сохраняю. Пока можно пройти «${TOUR_TITLE}» и вопросы об «Очаково».`, {
      buttons: [[btn(TOUR_TITLE, 'm:tour'), btn(COMPANY_QUIZ_TITLE, 'm:cq')], menuRow()],
    }),
  )
}

function acceptBirth(ctx: Ctx, s: ApplyState, input: string) {
  const typed = dateFromWords(input)
  const iso = parseBirthDate(typed)
  if (!iso) {
    // «да», «мне 19» — возраст словами: нужна дата целиком; «мне 17», «нет» — сразу отказ
    const adult = parseAdult(input)
    if (adult === 'no') return underage(ctx)
    if (adult === 'yes') return retry(birthPrompt(s), `Нужна дата целиком: день, месяц и год цифрами в формате ${DATE_HINT}`)
    // Похоже на дату, но такой нет или формат другой: «31.02…», «5/13/…» — объясняем, что не так
    if (/^\d{1,4}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{1,4}$/.test(typed)) return retry(birthPrompt(s), birthDateProblem(typed)?.message ?? birthDateMessages.format)
    return null
  }
  const problem = birthDateProblem(typed)
  if (problem?.code === 'underage') return underage(ctx)
  if (problem) return retry(birthPrompt(s), problem.message)
  return advance(ctx, { ...s, birthDate: iso, birthTyped: typed }, 'name')
}

function acceptName(ctx: Ctx, s: ApplyState, input: string) {
  const parsed = parseFullName(input, asName(ctx.user.firstName ?? '') ?? '')
  if (!parsed) return retry(namePrompt(ctx), 'Нужны фамилия и имя буквами, например: Смирнова Анна')
  const next: ApplyState = { ...s, name: parsed.name, lastName: parsed.lastName, middleName: parsed.middleName }
  // Одно слово — это имя: фамилию спросим отдельно, и после исправления тоже
  if (!parsed.lastName) {
    save(ctx, { ...next, step: 'lastName' })
    return send(lastNamePrompt(next))
  }
  return advance(ctx, next, 'phone')
}

function acceptLastName(ctx: Ctx, s: ApplyState, input: string) {
  const parsed = parseLastName(input, s.name)
  if (!parsed?.lastName) return retry(lastNamePrompt(s), 'Нужна фамилия буквами')
  return advance(ctx, { ...s, ...parsed }, 'phone')
}

function acceptContact(ctx: Ctx, s: ApplyState, phone: string | null, handle: string | null) {
  if (!phone && !handle) {
    return reply(
      msg('Не получилось распознать. Нужен номер телефона, например +7 999 123-45-67, или ник с @, например @kvas_fan.', {
        buttons: [[contactButton('Отправить номер')], cancelRow()],
        input: 'phone',
      }),
    )
  }
  return advance(ctx, { ...s, phone: phone ?? '', contact: handle ?? '' }, 'school')
}

function acceptStart(ctx: Ctx, s: ApplyState, ready: StartReady, month?: number) {
  if (ready === 'month' && !isStartMonth(month)) {
    save(ctx, { ...s, step: 'startMonth' })
    return send(startMonthPrompt())
  }
  return advance(ctx, { ...s, startReady: ready, startMonth: ready === 'month' ? month : undefined }, 'vacancy')
}

/** Текстовый ввод внутри заявки */
export async function text(ctx: Ctx, input: string): Promise<DialogReply> {
  const s = state<ApplyState>(ctx, KEY)
  if (!s) return start(ctx)
  if (needsBirth(s)) return start(ctx, s.vacancyId)

  switch (s.step) {
    case 'birth': {
      const r = acceptBirth(ctx, s, input)
      if (r) return r
      if (looksLikeQuestion(input)) return answerInside(ctx, s, input)
      return retry(birthPrompt(s), birthDateMessages.format)
    }
    case 'name': {
      if (looksLikeQuestion(input)) return answerInside(ctx, s, input)
      return acceptName(ctx, s, input)
    }
    case 'lastName': {
      if (looksLikeQuestion(input)) return answerInside(ctx, s, input)
      return acceptLastName(ctx, s, input)
    }
    case 'phone': {
      // «Можно без телефона?» — да, подойдёт ник
      if (refusesPhone(input)) {
        return reply(
          msg('Можно без телефона: напиши ник в Telegram или MAX, например @kvas_fan. HR напишет туда.', {
            buttons: [[contactButton('Отправить номер')], cancelRow()],
            input: 'phone',
          }),
        )
      }
      const phone = phoneOf(input)
      const handle = parseHandle(input)
      if (!phone && !handle && looksLikeQuestion(input)) return answerInside(ctx, s, input)
      return acceptContact(ctx, s, phone, handle)
    }
    case 'school': {
      // Длинное название вуза — не вопрос: только «?» и вопросительное слово в начале
      if (looksLikeQuestion(input, true)) return answerInside(ctx, s, input)
      if (notStudying(input)) {
        return advance(ctx, { ...s, school: '', notStudying: true }, 'months')
      }
      const school = schoolName(input)
      if (!school) return retry(schoolPrompt(), 'Напиши название вуза или колледжа буквами, например МГУПП')
      return advance(ctx, { ...s, school, notStudying: false }, 'months')
    }
    case 'months': {
      if (looksLikeQuestion(input)) return answerInside(ctx, s, input)
      // «июнь, июль» текстом — отмечаем их и показываем кнопки, чтобы проверить и нажать «Готово»
      const typed = monthsFromText(input)
      if (typed.length) {
        const next: ApplyState = { ...s, months: typed, monthsFromTask: false }
        save(ctx, next)
        return send(monthsPrompt(next))
      }
      return retry(monthsPrompt(s), 'Отметь месяцы кнопками или напиши их словами, например: июнь, июль')
    }
    case 'start': {
      // «После сессии» — ответ, хотя «сессия» — тема вопросов; со знаком вопроса — вопрос
      if (input.includes('?')) return answerInside(ctx, s, input)
      const ready = startFromText(input)
      if (ready) return acceptStart(ctx, s, ready)
      const month = monthsFromText(input)
      if (month.length === 1) return acceptStart(ctx, s, 'month', month[0])
      if (looksLikeQuestion(input)) return answerInside(ctx, s, input)
      return retry(startPrompt(s), 'Выбери вариант кнопкой')
    }
    case 'startMonth': {
      if (looksLikeQuestion(input)) return answerInside(ctx, s, input)
      const month = monthsFromText(input)
      if (month.length === 1) return acceptStart(ctx, s, 'month', month[0])
      return retry(startMonthPrompt(), 'Выбери месяц кнопкой')
    }
    case 'vacancy':
      if (looksLikeQuestion(input)) return answerInside(ctx, s, input)
      return send(vacancyPrompt(s))
    case 'portfolio': {
      // Та же проверка, что на сайте и на сервере: http(s)-ссылка до 300 знаков
      const portfolio = normalizePortfolio(input)
      if (portfolio) return advance(ctx, { ...s, portfolio }, 'confirm')
      if (looksLikeQuestion(input, true)) return answerInside(ctx, s, input)
      return send(portfolioPrompt(true))
    }
    case 'friend': {
      if (looksLikeQuestion(input, true)) return answerInside(ctx, s, input)
      const friend = friendName(input)
      if (!friend) return send(friendPrompt(true))
      return advance(ctx, { ...s, friend }, 'confirm')
    }
    case 'confirm':
      if (looksLikeQuestion(input)) return answerInside(ctx, s, input)
      return send(confirmPrompt(ctx, s))
  }
}

/** Номер из кнопки «Отправить номер» */
export async function contact(ctx: Ctx, phone: string) {
  const s = state<ApplyState>(ctx, KEY)
  if (!s || needsBirth(s)) return start(ctx, s?.vacancyId)
  if (s.step !== 'phone') return text(ctx, phone)
  // Мессенджер присылает номер без «+» — shared/phone его распознаёт; незнакомый формат оставляем цифрами
  const digits = phone.replace(/\D/g, '')
  return acceptContact(ctx, s, phoneOf(phone) ?? (digits.length >= 10 && digits.length <= 15 ? `+${digits}` : null), null)
}

/** Код приглашения в заявку: по нему HR находит друзей, пришедших по ссылке этого человека */
function applicationRefCode(ctx: Ctx) {
  try {
    return refCode(ctx)
  } catch {
    return undefined
  }
}

/** Поле с ошибкой → шаг, который его спрашивает */
const stepOfField: Record<string, Step> = {
  birthDate: 'birth',
  name: 'name',
  lastName: 'name',
  phone: 'phone',
  school: 'school',
  startReady: 'start',
  startMonth: 'start',
  portfolio: 'portfolio',
}

async function submit(ctx: Ctx, s: ApplyState) {
  const v = s.vacancyId ? vacancyById(s.vacancyId) : undefined
  const quizVacancy = ctx.session.progress.quiz ? vacancyById(ctx.session.progress.quiz) : undefined
  const input: ApplicationInput = {
    channel: ctx.user.channel,
    // Чтобы HR мог сообщить о статусе заявки в тот же мессенджер
    channelUserId: ctx.user.id,
    name: s.name,
    lastName: s.lastName ?? '',
    middleName: s.middleName ?? '',
    birthDate: s.birthDate ?? '',
    phone: s.phone,
    contact: s.contact || (ctx.user.username ? `@${ctx.user.username}` : ''),
    school: s.notStudying ? '' : (s.school ?? ''),
    notStudying: s.notStudying === true,
    course: '',
    startReady: s.startReady ?? '',
    startMonth: s.startReady === 'month' ? (s.startMonth ?? null) : null,
    department: v?.department ?? quizVacancy?.department ?? '',
    vacancyId: v?.id ?? '',
    format: v?.format ?? '',
    months: s.months,
    comment: '',
    friend: s.friend ?? '',
    ...(s.portfolio ? { portfolio: s.portfolio } : {}),
    game: {
      quizResult: quizVacancy?.department ?? null,
      conveyorBest: ctx.session.progress.game ?? 0,
      activities: doneCount(ctx.session.progress),
    },
    source: ctx.session.source,
    // Согласие — кнопкой «Даю согласие, отправить». 18+ выводится из даты рождения
    consent: true,
    consentVersion: CONSENT_VERSION,
    consentSource: consentSource[ctx.user.channel],
    refCode: applicationRefCode(ctx),
    practiceSchool: Boolean(s.practice),
    wantsToStay: Boolean(s.stay),
  }
  // Та же проверка, что у формы на сайте; дата рождения — в том виде, как её ввели
  const { errors, codes } = checkApplication({ ...input, birthDate: s.birthTyped ?? s.birthDate ?? '' }, { candidate: true })
  if (codes.birthDate === 'underage') return underage(ctx)
  const field = Object.keys(errors)[0]
  if (field) {
    const back: ApplyState = { ...s, step: stepOfField[field] ?? 'confirm', back: 'confirm' }
    save(ctx, back)
    return retry(promptFor(ctx, back), errors[field], true)
  }

  const result = await ctx.storage.acceptApplication(input)
  if (!result.ok && result.error === 'already_applied') {
    finish(ctx)
    const who = s.phone ? 'этим номером' : 'этим ником'
    return reply(
      msg(`Заявка с ${who} уже пришла несколько минут назад, HR её видит. Второй раз отправлять не нужно.`, {
        buttons: [[btn('Позвать друга', 'm:friend'), btn(TOUR_TITLE, 'm:tour')], menuRow()],
      }),
    )
  }
  if (!result.ok) {
    // Заявка остаётся на экране проверки: через retryAfter её можно отправить той же кнопкой
    const minutes = Math.max(1, Math.ceil(result.retryAfter / 60))
    return reply(
      msg(
        `С ${s.phone ? 'этого номера' : 'этого ника'} за час уже пришло ${PER_HOUR} ${plural(PER_HOUR, 'заявка', 'заявки', 'заявок')}. ` +
          `Следующую можно отправить через ${minutes} ${plural(minutes, 'минуту', 'минуты', 'минут')}.`,
        { buttons: [[btn('Даю согласие, отправить', 'a:ok')], cancelRow()] },
      ),
    )
  }

  const app = result.application
  finish(ctx)
  // С этого шага меню показывает «Моя заявка» вместо «Откликнуться»
  ctx.session.data[APPLIED_KEY] = app.id
  ctx.hasApplication = true
  const how = s.phone ? `${responsePromise('call')} по номеру ${formatPhone(s.phone)}.` : `${responsePromise('message')}: ${s.contact}.`
  const practiceLine = s.practice
    ? `\n\nДля практики от вуза понадобятся договор с вузом или колледжем и дневник практики. Документы несут в Учебный центр, кабинет ${TRAINING_CENTER_ROOM}.`
    : ''
  const friendLine = s.friend ? '\n\nЗаявка нужна и от друга: нажми «Позвать друга» и отправь ему ссылку.' : ''
  const done = reply(
    msg(
      `**Заявка № ${app.id} отправлена**\n\n${how} Дальше собеседование, медосмотр, договор и инструктаж. К каждому новичку прикрепляют наставника.${practiceLine}${friendLine}`,
      {
        buttons: [
          // Пришли по ссылке дня найма — час собеседования выбирают сразу
          ...(isHiringLabel(ctx.session.source) ? [[btn('Выбрать час собеседования', 'b:list')]] : []),
          [btn('Позвать друга', 'm:friend'), btn(TOUR_TITLE, 'm:tour')],
          menuRow(),
        ],
      },
    ),
  )
  // Чат на сайте запоминает заявку в браузере — «Моя заявка» на сайте и в чате покажет её статус.
  // В мессенджеры номер и токен не отдаём: там заявку находят по id пользователя
  if (ctx.user.channel === 'web' && app.statusToken) {
    done.application = { id: app.id, token: app.statusToken, name: app.name, phone: app.phone, contact: app.contact, vacancyId: app.vacancyId, friend: app.friend ?? '' }
  }
  return done
}

const editSteps: Record<string, Step> = { name: 'name', birth: 'birth', phone: 'phone', school: 'school', months: 'months', start: 'start', vacancy: 'vacancy' }

/**
 * Кнопки внутри заявки: a:start[:id], a:name, a:nostudy, a:m:<месяц>, a:mdone, a:mnone, a:sr:<готовность>, a:sm:<месяц>,
 * a:v:<id|any>, a:vl, a:noportfolio, a:friend, a:fskip, a:nofriend, a:practice, a:stay, a:edit, a:e:<поле|back>, a:ok
 */
export async function route(ctx: Ctx, parts: string[]): Promise<DialogReply> {
  const [, cmd, arg] = parts
  if (cmd === 'start') return start(ctx, arg ?? '')
  const s = state<ApplyState>(ctx, KEY)
  if (!s || needsBirth(s)) return start(ctx, s?.vacancyId)

  if (cmd === 'name' && s.step === 'name') {
    const first = asName(ctx.user.firstName ?? '')
    if (first) {
      const next: ApplyState = { ...s, name: first, lastName: '', middleName: '', step: 'lastName' }
      save(ctx, next)
      return send(lastNamePrompt(next))
    }
  }
  if (cmd === 'nostudy' && s.step === 'school') return advance(ctx, { ...s, school: '', notStudying: true }, 'months')
  if (cmd === 'm' && s.step === 'months') {
    const next = { ...s, months: toggle(s.months, Number(arg)) }
    save(ctx, next)
    return send(monthsPrompt(next), undefined, { replace: true })
  }
  if ((cmd === 'mdone' || cmd === 'mnone') && s.step === 'months') {
    return advance(ctx, { ...s, months: cmd === 'mnone' ? [] : s.months }, 'start')
  }
  if (cmd === 'sr' && s.step === 'start' && startReadyOptions.some((o) => o.id === arg)) return acceptStart(ctx, s, arg as StartReady)
  if (cmd === 'sm' && (s.step === 'start' || s.step === 'startMonth')) return acceptStart(ctx, s, 'month', Number(arg))
  if (cmd === 'vl' && s.step === 'vacancy') {
    return reply(msg('Выбери вакансию.', { buttons: [...vacanciesByPay.map((v) => [btn(`${v.title} · ${payText(v)}`.slice(0, 120), `a:v:${v.id}`)]), cancelRow()] }))
  }
  if (cmd === 'v' && s.step === 'vacancy') {
    const v = arg === 'any' ? undefined : openVacancyById(arg ?? '')
    const next: ApplyState = { ...s, vacancyId: v ? v.id : '', ...(v?.format === 'Бесплатная практика' ? { practice: true } : {}) }
    if (v && asksPortfolio(v)) {
      // Портфолио спрашиваем и при исправлении вакансии; после него — проверка
      save(ctx, { ...next, step: 'portfolio' })
      return send(portfolioPrompt())
    }
    return advance(ctx, { ...next, portfolio: undefined }, 'confirm')
  }
  if (cmd === 'noportfolio' && s.step === 'portfolio') return advance(ctx, { ...s, portfolio: undefined }, 'confirm')
  if (s.step === 'confirm') {
    if (cmd === 'ok') return submit(ctx, s)
    if (cmd === 'practice' || cmd === 'stay') {
      const next: ApplyState = cmd === 'practice' ? { ...s, practice: !s.practice } : { ...s, stay: !s.stay }
      save(ctx, next)
      return send(confirmPrompt(ctx, next), undefined, { replace: true })
    }
    if (cmd === 'friend') {
      save(ctx, { ...s, step: 'friend' })
      return send(friendPrompt())
    }
    if (cmd === 'edit') return send(editPrompt())
    if (cmd === 'e') {
      const step = editSteps[arg ?? '']
      if (!step) return send(confirmPrompt(ctx, s))
      const next: ApplyState = { ...s, step, back: 'confirm' }
      save(ctx, next)
      return send(promptFor(ctx, next))
    }
  }
  if (s.step === 'friend' && (cmd === 'fskip' || cmd === 'nofriend')) {
    return advance(ctx, { ...s, friend: cmd === 'fskip' ? FRIEND_NO_NAME : undefined }, 'confirm')
  }

  // Кнопка из прошлого шага — показываем текущий
  return send(promptFor(ctx, s))
}
