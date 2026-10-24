import { monthGenitiveName, type HrApplication } from './applications'
import { contacts, RESPONSE_WORKDAYS } from './content/content'
import { TRAINING_CENTER_ROOM } from './content/handbook'
import { isPractice, needsMedBook, vacancyById } from './content/vacancies'
import { defaultWorkSettings, isWorkDay, mskAt, mskParts, workdayAfter, type WorkSettings } from './workdays'

// Статус заявки глазами кандидата — одна логика для страницы «Моя заявка», чата на сайте и ботов.
// Внутренние статусы HR («Не отвечает», причина отказа, ответственный) кандидату не показываем как есть:
// только что происходит и что делать дальше.

// Срок ответа HR — одно место для всех текстов. Число рабочих дней задано в shared/content/content.ts рядом с шагами
// «Как попасть» (так нет циклического импорта), отсюда его берут сайт, бот и Квасыч. Внутренний SLA HR (24 часа) — отдельно

/** Сколько рабочих дней HR обещает на первый звонок — то же обещание, что на странице заявки */
export { RESPONSE_WORKDAYS }

/** Тот же срок словами после «в течение»: «двух рабочих дней» */
export const RESPONSE_WORDS =
  ({ 1: 'одного рабочего дня', 2: 'двух рабочих дней', 3: 'трёх рабочих дней', 4: 'четырёх рабочих дней', 5: 'пяти рабочих дней' } as Record<number, string>)[
    RESPONSE_WORKDAYS
  ] ?? `${RESPONSE_WORKDAYS} рабочих дней`

/**
 * Обещание срока одной фразой без точки в конце — у кнопки отправки, на экране успеха, в боте и у Квасыча.
 * call — у кандидата есть телефон: «HR позвонит в течение двух рабочих дней»;
 * message — только ник в мессенджере: «HR напишет в мессенджер в течение двух рабочих дней»
 */
export const responsePromise = (how: 'call' | 'message') =>
  how === 'call' ? `HR позвонит в течение ${RESPONSE_WORDS}` : `HR напишет в мессенджер в течение ${RESPONSE_WORDS}`

export type CandidateStage = 'received' | 'contacted' | 'missed' | 'interview' | 'offer' | 'started' | 'closed'

export type CandidateStatus = {
  id: string
  stage: CandidateStage
  /** Короткий заголовок: «Заявка у отдела персонала» */
  title: string
  /** Что дальше — прямым текстом, без обещаний сверх того, что делает HR */
  text: string
  vacancyTitle: string | null
  /** Собеседование, если назначено и ещё не прошло */
  interview: { startsAt: string; address: string; bring: string } | null
  /** Новая заявка ждёт звонка дольше обещанного — показываем «не позвонили — напиши» */
  overdue: boolean
  /** Шаги для полосы прогресса: пройден ли каждый */
  steps: { id: 'received' | 'contacted' | 'interview' | 'offer' | 'started'; label: string; done: boolean }[]
  /**
   * Первая смена для шага «Первая смена»: дата от HR («пятница, 14 июля, с 8:00, дневная смена»), «не раньше июля»
   * по месяцам из заявки или «срок обсудят на собеседовании». null — заявка закрыта
   */
  firstShift: FirstShift | null
  /** «Как подготовиться» — только при «Собеседовании» и «К оформлению» */
  prepare: { title: string; items: string[] } | null
}

/** at — дата и время первой смены от HR (ISO); null — даты ещё нет, тогда text — «не раньше июля» или «срок обсудят…» */
export type FirstShift = { at: string | null; text: string }

/** Контакты отдела персонала одной строкой — для «не позвонили» и вопросов */
export const hrContactsLine = `${contacts.phone} (${contacts.phoneNote}), ${contacts.email}`

/** Рабочих дней между двумя моментами по Москве: день подачи не считается */
export function workdaysBetween(from: Date, to: Date, s: WorkSettings = defaultWorkSettings) {
  let n = 0
  const day = new Date(from.getTime())
  const end = mskParts(to).day
  for (let i = 0; i < 60; i++) {
    day.setTime(day.getTime() + 864e5)
    const d = mskParts(day).day
    if (d > end) break
    if (isWorkDay(d, s)) n++
  }
  return n
}

/**
 * Последний день срока ответа по Москве (ГГГГ-ММ-ДД): RESPONSE_WORKDAYS-й рабочий день после дня заявки — по календарю
 * отдела, с праздниками и переносами. Тот же счёт, что у overdue: на следующий рабочий день заявка уже просрочена
 */
export const responseDeadline = (createdAt: Date, s: WorkSettings = defaultWorkSettings) =>
  mskParts(workdayAfter(RESPONSE_WORKDAYS, 12, createdAt.getTime(), s)).day

const weekdayGenitive = ['', 'понедельника', 'вторника', 'среды', 'четверга', 'пятницы', 'субботы', 'воскресенья']

/**
 * Срок словами — чтобы не считать рабочие дни в уме: «сегодня до конца дня», «завтра до конца дня», «до конца среды»;
 * дальше недели (новогодние каникулы) — с числом: «до конца среды, 14 января». Всё по Москве
 */
export function deadlineWords(day: string, now: Date = new Date()): string {
  const today = mskParts(now).day
  const days = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 864e5)
  if (days <= 0) return 'сегодня до конца дня'
  if (days === 1) return 'завтра до конца дня'
  const at = mskAt(day, 12)
  const weekday = weekdayGenitive[mskParts(at).dow]
  if (days < 7) return `до конца ${weekday}`
  return `до конца ${weekday}, ${at.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long' })}`
}

const stepLabels = [
  ['received', 'Заявка получена'],
  ['contacted', 'Звонок HR'],
  ['interview', 'Собеседование'],
  ['offer', 'Оформление'],
  ['started', 'Первая смена'],
] as const

/** Поля заявки, по которым строятся первая смена и «Как подготовиться». Все необязательны: без них — общий текст */
type PrepareFields = Partial<
  Pick<HrApplication, 'firstShiftAt' | 'shiftKind' | 'months' | 'startReady' | 'startMonth' | 'citizenship' | 'practiceSchool' | 'format'>
>

const mskDate = (iso: string, o: Intl.DateTimeFormatOptions) => new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', ...o })

/**
 * Первая смена глазами кандидата. С датой от HR — «пятница, 14 июля, с 8:00, дневная смена». Без даты —
 * самый ранний месяц из заявки («не раньше июля»): месяц из «Когда может выйти» важнее месяцев работы.
 * Без месяцев — «срок обсудят на собеседовании», а после собеседования — «дату назовёт HR». На смене без даты — «уже позади»
 */
export function firstShiftOf(app: Pick<HrApplication, 'status'> & PrepareFields): FirstShift | null {
  if (app.status === 'declined') return null
  if (app.firstShiftAt && !Number.isNaN(Date.parse(app.firstShiftAt))) {
    const day = mskDate(app.firstShiftAt, { weekday: 'long', day: 'numeric', month: 'long' })
    const time = mskDate(app.firstShiftAt, { hour: 'numeric', minute: '2-digit' })
    const kind = app.shiftKind === 'day' ? ', дневная смена' : app.shiftKind === 'night' ? ', ночная смена' : ''
    return { at: new Date(app.firstShiftAt).toISOString(), text: `${day}, с ${time}${kind}` }
  }
  // На смене, а дату HR не отметил: первая смена уже позади — «не раньше июля» тут не к месту
  if (app.status === 'started') return { at: null, text: 'уже позади' }
  const month = app.startReady === 'month' && app.startMonth ? app.startMonth : app.months?.length ? Math.min(...app.months) : null
  if (month && monthGenitiveName(month)) return { at: null, text: `не раньше ${monthGenitiveName(month)}` }
  return { at: null, text: app.status === 'hired' ? 'дату назовёт HR' : 'срок обсудят на собеседовании' }
}

/**
 * «Как подготовиться» — при «Собеседовании» и «К оформлению». Документы — что обычно просят при приёме (ст. 65 ТК РФ),
 * точный список называет HR. Медкнижка — только у вакансий рядом с продуктом (needsMedBook), практика от вуза — по справочнику
 * студента: договор от вуза и Учебный центр, кабинет 525
 */
export function prepareOf(app: Pick<HrApplication, 'status' | 'vacancyId'> & PrepareFields): CandidateStatus['prepare'] {
  if (app.status !== 'interview' && app.status !== 'hired') return null
  const vacancy = vacancyById(app.vacancyId ?? '')
  const practice = Boolean(app.practiceSchool) || (vacancy ? isPractice(vacancy) : false) || app.format === 'Оплачиваемая практика' || app.format === 'Бесплатная практика'
  const items: string[] = []
  if (app.status === 'interview')
    items.push('На собеседовании спросят об учёбе, опыте, удобных сменах и когда можешь выйти, чтобы подобрать участок и график.')
  else items.push('Дальше будут медосмотр за счёт компании, договор и инструктаж по охране труда. Дату и время назовёт HR.')
  items.push('Для оформления обычно нужны паспорт, СНИЛС, документ об образовании, трудовая книжка (если есть) и военный билет (для военнообязанных). Точный список назовёт HR.')
  if (app.citizenship === 'eaeu' || app.citizenship === 'other') items.push('Если гражданство не российское, HR скажет, какие документы нужны ещё.')
  if (vacancy && needsMedBook(vacancy)) items.push('На этой работе нужна личная медицинская книжка. Если её нет, HR подскажет, как и где оформить.')
  if (practice)
    items.push(`Для практики от вуза или колледжа договор о практике подписывают до её начала. Документы по практике несут в Учебный центр, кабинет ${TRAINING_CENTER_ROOM}.`)
  return { title: app.status === 'interview' ? 'Как подготовиться к собеседованию' : 'Как подготовиться к оформлению', items }
}

export function candidateStatus(
  app: Pick<HrApplication, 'id' | 'status' | 'statusUpdatedAt' | 'createdAt' | 'vacancyId' | 'interview' | 'reached'> &
    Partial<Pick<HrApplication, 'phone' | 'contact'>> &
    PrepareFields,
  now: Date = new Date(),
  settings: WorkSettings = defaultWorkSettings,
): CandidateStatus {
  const vacancyTitle = vacancyById(app.vacancyId ?? '')?.title ?? null
  const reached = new Set(app.reached ?? [])
  const interview =
    app.status === 'interview' && app.interview && new Date(app.interview.startsAt).getTime() > now.getTime()
      ? { startsAt: app.interview.startsAt, address: app.interview.address, bring: app.interview.bring }
      : null
  const overdue = app.status === 'new' && workdaysBetween(new Date(app.createdAt), now, settings) > RESPONSE_WORKDAYS
  // Срок ответа конкретным днём: «HR позвонит до конца среды», без «двух рабочих дней с момента заявки»
  const by = deadlineWords(responseDeadline(new Date(app.createdAt), settings), now)

  // Без телефона, только ник — HR напишет в мессенджер, а не позвонит
  const byMessage = !app.phone && Boolean(app.contact)
  const base = { id: app.id, vacancyTitle, interview, overdue }
  let stage: CandidateStage
  let title: string
  let text: string

  switch (app.status) {
    case 'new':
      stage = 'received'
      title = 'Заявка у отдела персонала'
      text = overdue
        ? `Ответа от HR ещё не было, так бывает в пик сезона. Позвони или напиши: ${hrContactsLine}. Назови номер заявки ${app.id}.`
        : byMessage
          ? `HR напишет тебе в мессенджер ${by}.`
          : `HR позвонит ${by}. Держи телефон рядом.`
      break
    case 'contacted':
      stage = 'contacted'
      title = 'HR на связи'
      text = 'С тобой уже поговорили. Дальше HR пригласит на собеседование, время и адрес придут сюда и в сообщении.'
      break
    case 'no_answer':
      stage = 'missed'
      title = 'Не дозвонились'
      text = `Из отдела персонала звонили, но не застали. Перезвони или напиши: ${hrContactsLine}. Назови номер заявки ${app.id}.`
      break
    case 'interview':
      stage = 'interview'
      title = interview ? 'Собеседование назначено' : 'Собеседование'
      text = interview
        ? 'Возьми с собой то, что указано ниже. Если время не подходит, позвони заранее, и собеседование перенесут.'
        : `Время собеседования уточнит HR. Вопросы: ${hrContactsLine}.`
      break
    case 'hired':
      stage = 'offer'
      title = 'Ждём на оформление'
      text = `Тебя готовы взять. HR скажет, когда прийти на оформление и медосмотр. Вопросы: ${hrContactsLine}.`
      break
    case 'started':
      stage = 'started'
      title = 'Ты в команде'
      text = 'Первая смена отмечена. С вопросами по графику и зарплате обращайся к мастеру смены или в отдел персонала.'
      break
    case 'declined':
    default:
      stage = 'closed'
      title = 'Заявка закрыта'
      text = 'Сейчас по этой заявке не получилось. Можно откликнуться на другую вакансию, заявка займёт минуту.'
      break
  }

  const order = ['received', 'contacted', 'interview', 'offer', 'started'] as const
  const reachedStep = (id: (typeof order)[number]) =>
    id === 'received' ||
    (id === 'contacted' && (reached.has('contacted') || reached.has('no_answer') || reached.has('interview') || reached.has('hired') || reached.has('started'))) ||
    (id === 'interview' && (reached.has('interview') || reached.has('hired') || reached.has('started'))) ||
    (id === 'offer' && (reached.has('hired') || reached.has('started'))) ||
    (id === 'started' && reached.has('started'))
  const steps = stepLabels.map(([id, label]) => ({ id, label: id === 'contacted' && byMessage ? 'Связь с HR' : label, done: reachedStep(id) }))

  return { ...base, stage, title, text, steps, firstShift: firstShiftOf(app), prepare: prepareOf(app) }
}
