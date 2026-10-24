import type postgres from 'postgres'
import {
  citizenshipOptions,
  CONSENT_VERSION,
  interviewDefaults,
  medBookOptions,
  seasonLeaveReasonLabel,
  seasonOutcomes,
  shiftOptions,
  type Application,
  type ApplicationStatus,
  type ConsentSource,
  type DeclineReason,
  type PracticeDoc,
  type SeasonLeaveReason,
  type SeasonOutcome,
  type ShiftKind,
} from '@shared/applications'
import { checkinAnswerLabel, checkinHardNote, checkinReasonLabel, checkinStepLabel, checkinSteps, checkinTime, type CheckinAnswer, type CheckinReason } from '@shared/adaptation'
import { departmentList } from '@shared/content/departments'
import { isWorkday, mskAt, mskParts, nextWorkTime } from '@shared/workdays'
import { vacancies } from '@shared/content/vacancies'
import { demoApplications, demoBirthDate, demoTaskList, makeApplicationId, type DemoTask } from '@shared/demo'
import { gapTopic, TOPIC } from '../assistant/topics'
import type { Sql } from './index'

// Демо-данные для показа панели: заявки с правдоподобной историей, ответственными, собеседованиями
// (в том числе прошедшими без отметки явки и с самозаписью), недозвонами, причинами отказа и парой дублей; кандидаты,
// добавленные HR; аудитория ботов с подпиской «Напомнить о наборе», приглашения друзей, события воронки сайта
// и вопросы к Квасычу без ответа. Поля кейса — дата рождения, когда может выйти, учёба; у «К оформлению» —
// даты оформления и первой смены, у «На смене» — наставник, документы по практике, итог сезона и резерв.
// Служебные записи аудитории и посетители помечены префиксом demo-.

const pick = <T,>(list: readonly T[]) => list[Math.floor(Math.random() * list.length)]
const between = (min: number, max: number) => min + Math.random() * (max - min)
const HOUR = 3600e3
const DAY = 24 * HOUR
const MSK = 3 * HOUR

/** Код приглашения — 6 символов того же алфавита, что у бота и сайта */
const REF_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
const refCode = () => Array.from({ length: 6 }, () => pick([...REF_ALPHABET])).join('')
const rnd = () => Math.random().toString(36).slice(2, 10)

/**
 * Что происходит с демо-заявкой. fresh — новая за последние 2–20 часов, overdue — новая без ответа дольше суток,
 * interview_past — собеседование прошло, явку ещё не отметили
 */
type Scenario =
  | 'fresh'
  | 'overdue'
  | 'contacted'
  | 'no_answer'
  | 'interview_future'
  | 'interview_past'
  | 'declined_no_show'
  | 'declined_after'
  | 'declined_early'
  | 'hired'
  | 'started'
  | 'season_done'

/**
 * Набор на 24 заявки. Главное для показа — первым: и маленький набор покажет прошедшие собеседования и просрочку.
 * season_done — практикант от вуза: вышел на смену около трёх недель назад, практика кончилась, итог «Сезон отработан»
 */
const BASE: Scenario[] = [
  'interview_past', 'interview_past', 'interview_past', 'overdue', 'fresh', 'hired', 'started', 'declined_no_show',
  'contacted', 'interview_future', 'fresh', 'no_answer', 'started', 'contacted', 'interview_future', 'declined_after',
  'season_done', 'hired', 'declined_early', 'no_answer', 'season_done', 'started', 'interview_future', 'fresh',
]
/** Сверх 24 — без просрочек и прошедших собеседований: их в наборе ровно столько, сколько задумано */
const EXTRA: Scenario[] = ['fresh', 'contacted', 'no_answer', 'interview_future', 'declined_early', 'declined_after', 'hired', 'started']

function scenarios(count: number): Scenario[] {
  const list = Array.from({ length: count }, (_, i) => BASE[i] ?? pick(EXTRA))
  // Просроченных одна или две
  const fresh = list.lastIndexOf('fresh')
  if (count >= 12 && fresh >= 0 && Math.random() < 0.5) list[fresh] = 'overdue'
  return list
}

/** Время собеседования по Москве в будний день: сдвиг в днях от сегодня, на выходных — к пятнице или понедельнику */
function weekdaySlot(days: number, hour: number) {
  const d = new Date(Date.now() + MSK + days * DAY)
  d.setUTCHours(hour, 0, 0, 0)
  const weekday = d.getUTCDay()
  if (weekday === 6) d.setUTCDate(d.getUTCDate() + (days < 0 ? -1 : 2))
  if (weekday === 0) d.setUTCDate(d.getUTCDate() + (days < 0 ? -2 : 1))
  return new Date(d.getTime() - MSK)
}
const slotHour = () => pick([10, 11, 14, 15])

/** Момент по Москве days дней назад, с 8 до 23 часов: вопросы задают днём и вечером, а не равномерно по суткам */
function daytime(days: number, now: number) {
  const d = new Date(now + MSK - days * DAY)
  d.setUTCHours(8 + Math.floor(Math.random() * 15), Math.floor(Math.random() * 60), 0, 0)
  return Math.min(d.getTime() - MSK, now - HOUR)
}

type Step = { status: ApplicationStatus; at: number }
type Timeline = {
  created: number
  steps: Step[]
  interview?: { startsAt: number; createdAt: number; attended: '' | 'yes' | 'no' }
  declineReason?: DeclineReason
  /** Итог сезона отметили недавно: практика кончилась */
  seasonAt?: number
}

/** История заявки по сценарию: когда пришла, когда HR что сделал, когда собеседование и чем кончилось */
function timeline(s: Scenario, now = Date.now()): Timeline {
  if (s === 'fresh') return { created: now - between(2, 20) * HOUR, steps: [] }
  if (s === 'overdue') return { created: now - between(27, 44) * HOUR, steps: [] }
  if (s === 'contacted' || s === 'no_answer') {
    const created = now - between(1.5, 6) * DAY
    return { created, steps: [{ status: s, at: created + between(2, 20) * HOUR }] }
  }
  if (s === 'declined_early') {
    const created = now - between(2, 10) * DAY
    return { created, steps: [{ status: 'declined', at: created + between(3, 30) * HOUR }], declineReason: pick(['age', 'schedule', 'no_slots'] as const) }
  }
  if (s === 'interview_future') {
    const created = now - between(2, 7) * DAY
    const contacted = created + between(2, 12) * HOUR
    const invited = Math.min(contacted + between(1, 24) * HOUR, now - HOUR)
    const slot = weekdaySlot(1 + Math.floor(Math.random() * 5), slotHour()).getTime()
    return {
      created,
      steps: [
        { status: 'contacted', at: contacted },
        { status: 'interview', at: invited },
      ],
      interview: { startsAt: slot, createdAt: invited, attended: '' },
    }
  }
  // Собеседование уже было: сначала слот в прошлом, история — до него. Практикант с итогом сезона пришёл около
  // четырёх недель назад — в пределах 30 дней, которые «Воронка» показывает по умолчанию
  const daysAgo =
    s === 'season_done' ? between(21, 23) : s === 'started' ? between(9, 16) : s === 'hired' ? between(3, 8) : s === 'interview_past' ? 1 + Math.floor(Math.random() * 3) : between(2, 6)
  const slot = weekdaySlot(-Math.round(daysAgo), slotHour()).getTime()
  const created = slot - (s === 'season_done' ? between(1.5, 3) : between(3, 7)) * DAY
  const contacted = created + between(2, 12) * HOUR
  const invited = contacted + between(2, 24) * HOUR
  const before: Step[] = [
    { status: 'contacted', at: contacted },
    { status: 'interview', at: invited },
  ]
  if (s === 'interview_past') return { created, steps: before, interview: { startsAt: slot, createdAt: invited, attended: '' } }
  if (s === 'declined_no_show')
    return { created, steps: [...before, { status: 'declined', at: slot + 3 * HOUR }], interview: { startsAt: slot, createdAt: invited, attended: 'no' }, declineReason: 'no_show' }
  if (s === 'declined_after')
    return {
      created,
      steps: [...before, { status: 'declined', at: Math.min(slot + between(2, 30) * HOUR, now - HOUR) }],
      interview: { startsAt: slot, createdAt: invited, attended: 'yes' },
      declineReason: pick(['schedule', 'documents', 'candidate_refused', 'no_slots'] as const),
    }
  const hired = Math.min(slot + between(2, 26) * HOUR, now - 2 * HOUR)
  const steps: Step[] = [...before, { status: 'hired', at: hired }]
  if (s === 'started') steps.push({ status: 'started', at: Math.min(hired + between(3, 6) * DAY, now - HOUR) })
  if (s === 'season_done') {
    steps.push({ status: 'started', at: hired + between(2, 4) * DAY })
    return { created, steps, interview: { startsAt: slot, createdAt: invited, attended: 'yes' }, seasonAt: now - between(3, 30) * HOUR }
  }
  return { created, steps, interview: { startsAt: slot, createdAt: invited, attended: 'yes' } }
}

/** Начало суток по Москве для момента t */
const mskMidnight = (t: number) => {
  const d = new Date(t + MSK)
  d.setUTCHours(0, 0, 0, 0)
  return d.getTime() - MSK
}

/** Ближайший будний день через days суток от t, в hour часов по Москве */
const weekdayAt = (t: number, days: number, hour: number) => {
  let day = mskMidnight(t) + days * DAY
  while ([0, 6].includes(new Date(day + MSK).getUTCDay())) day += DAY
  return day + hour * HOUR
}

/** Наставники — сотрудники, прошедшие обучение в Учебном центре. Имена выдуманы, как и у кандидатов */
const demoMentors = ['Наталья Белова', 'Андрей Ершов', 'Виктор Лаптев', 'Елена Сафонова']

/** Оформление и первая смена, наставник и документы по практике — по тому, как далеко зашла заявка */
type Onboarding = {
  onboardingAt: Date | null
  firstShiftAt: Date | null
  shiftKind: ShiftKind | ''
  mentor: string
  docs: PracticeDoc[]
}

function onboarding(t: Timeline, status: ApplicationStatus, practice: boolean, scenario: Scenario, now: number): Onboarding {
  const none: Onboarding = { onboardingAt: null, firstShiftAt: null, shiftKind: '', mentor: '', docs: [] }
  const hired = t.steps.find((x) => x.status === 'hired')?.at
  if (!hired || (status !== 'hired' && status !== 'started')) return none
  if (status === 'hired') {
    // Оформление — в ближайшие будни, первая смена — через пару дней после него; у части дата смены ещё не назначена
    const onboardingAt = weekdayAt(Math.max(hired, now), 1 + Math.floor(Math.random() * 3), 10)
    const night = Math.random() < 0.3
    const firstShiftAt = Math.random() < 0.75 ? mskMidnight(onboardingAt) + (2 + Math.floor(Math.random() * 3)) * DAY + (night ? 20 : 8) * HOUR : null
    return {
      onboardingAt: new Date(onboardingAt),
      firstShiftAt: firstShiftAt ? new Date(firstShiftAt) : null,
      shiftKind: firstShiftAt ? (night ? 'night' : 'day') : '',
      mentor: Math.random() < 0.5 ? pick(demoMentors) : '',
      docs: practice ? ['contract'] : [],
    }
  }
  // На смене: первая смена — накануне перехода в «На смене», оформление — за день-два до неё
  const started = t.steps.find((x) => x.status === 'started')!.at
  let night = Math.random() < 0.25
  let firstShiftAt = mskMidnight(started) - (night ? 2 : 1) * DAY + (night ? 20 : 8) * HOUR
  // Между решением взять и первой сменой — хотя бы полсуток на оформление
  if (firstShiftAt < hired + 14 * HOUR) {
    night = false
    firstShiftAt = mskMidnight(hired + 14 * HOUR) + 8 * HOUR
    if (firstShiftAt < hired + 14 * HOUR) firstShiftAt += DAY
  }
  const onboardingAt = Math.min(Math.max(hired + 2 * HOUR, firstShiftAt - 2 * DAY), firstShiftAt - 12 * HOUR)
  const docs: PracticeDoc[] = !practice ? [] : scenario === 'season_done' ? ['contract', 'order', 'diary', 'reference'] : Math.random() < 0.5 ? ['contract', 'order', 'diary'] : ['contract', 'order']
  return { onboardingAt: new Date(onboardingAt), firstShiftAt: new Date(firstShiftAt), shiftKind: night ? 'night' : 'day', mentor: pick(demoMentors), docs }
}

/** Причины ухода до конца сезона в демо */
const demoLeaveReasons: SeasonLeaveReason[] = ['commute', 'schedule', 'study']

/** «Чего не хватает, чтобы решиться» в демо-ответах фокус-группы */
const demoFocusMissing = ['Расписание корпоративного автобуса', 'Как совмещать смены с учёбой', 'Сколько мест в общежитии', 'Отзывы тех, кто уже был на практике']

/** Вузы для практиканта с итогом сезона: у него практика от вуза, значит, он учится */
const practiceSchools = ['МГУПП', 'РХТУ им. Менделеева', 'Московский Политех']

/**
 * Вопросы, на которые у Квасыча нет ответа в данных, — такие обычно и уходят к HR. Только темы, которых нет
 * ни в «Справочнике студента», ни в «Описании практики» (archive/case-materials): общежитие, медосмотр, дневник
 * практики, сверхурочные, экзамены и скидка на продукцию там описаны, и Квасыч будет отвечать на них сам.
 * По два вопроса на тему разными словами — так видно, что сводка собирает их в одну строку
 */
const demoQuestions: { q: string; channel: string }[] = [
  { q: 'есть парковка для сотрудников у завода?', channel: 'web' },
  { q: 'можно машину оставить у проходной?', channel: 'telegram' },
  { q: 'нужна московская прописка, если я из Тулы?', channel: 'max' },
  { q: 'нужна временная регистрация, если живу в общежитии?', channel: 'telegram' },
  { q: 'ДМС действует, если я на практике?', channel: 'web' },
  { q: 'медицинскую страховку практикантам оформляют?', channel: 'max' },
  { q: 'можно приходить на смену с татуировками и пирсингом?', channel: 'telegram' },
  { q: 'с цветными волосами возьмут на линию?', channel: 'web' },
  { q: 'на смене можно пользоваться телефоном?', channel: 'web' },
  { q: 'в наушниках на линии работать можно?', channel: 'telegram' },
  { q: 'практику можно пройти удалённо?', channel: 'web' },
  { q: 'девушку возьмут на склад?', channel: 'max' },
  { q: 'где почитать отзывы сотрудников о заводе?', channel: 'telegram' },
]

/** Учётные записи для проверок не должны «вести» демо-заявки */
const serviceAccount = /probe|test|jury|e2e|demo/i

const consentFor = (channel: string): ConsentSource => (channel === 'telegram' ? 'telegram' : channel === 'max' ? 'max' : 'site_form')

export async function seedDemo(sql: Sql, count = 24): Promise<number> {
  const now = Date.now()
  const staff = (await sql<{ id: string; name: string; email: string }[]>`select id, name, email from hr_users where not disabled order by id`)
    .filter((u) => !serviceAccount.test(`${u.name} ${u.email}`))
    .map((u) => ({ id: Number(u.id), name: u.name }))
  const demo = demoApplications(count)
  const plan = scenarios(demo.length)
  const story = new Map<Application, Scenario>(demo.map((a, i) => [a, plan[i]]))

  // Двоих добавил отдел персонала: отклик с hh.ru из импорта и звонок в отдел
  const manual = [
    { scenario: 'contacted' as const, source: 'hh', note: 'Импорт из файла: hh.ru', consent: 'job_board' as const },
    { scenario: 'interview_future' as const, source: 'phone', note: 'Добавлено вручную: Звонок в отдел персонала', consent: 'hr_verbal' as const },
  ]
  const byHr = new Map<Application, (typeof manual)[number]>()
  for (const m of manual) {
    const a = [...demo].reverse().find((x) => story.get(x) === m.scenario && !byHr.has(x))
    if (!a || demo.length < 12) continue
    Object.assign(a, { channel: 'hr', source: m.source, contact: '', game: { quizResult: null, conveyorBest: 0, activities: 0 } })
    byHr.set(a, m)
  }

  // Боты: у каждой заявки из бота есть пользователь; двое из них позвали друзей
  const botApps = demo.filter((a) => a.channel === 'telegram' || a.channel === 'max')
  for (const a of botApps) a.channelUserId = `demo-${rnd()}`
  const referrers = botApps.slice(0, 2).map((a) => ({ app: a, code: refCode() }))
  const webApps = demo.filter((a) => (a.channel ?? 'web') === 'web')
  const invitedByBot = webApps.slice(0, referrers.length * 2)
  invitedByBot.forEach((a, i) => (a.source = `friend-${referrers[i % referrers.length].code}`))

  // Пара с сайта: один отправил заявку со своим кодом браузера, другой пришёл по его ссылке. Приглашённый по возможности
  // уже на смене — так в «Воронке» видно приглашение, дошедшее до смены
  const free = webApps.filter((a) => !invitedByBot.includes(a))
  const invitee = free.find((a) => ['started', 'season_done'].includes(story.get(a)!)) ?? free[1]
  const pair = [free.find((a) => a !== invitee), invitee].filter((a): a is Application => Boolean(a))
  if (pair.length === 2) {
    pair[0].refCode = refCode()
    pair[1].source = `friend-${pair[0].refCode}`
    pair[1].friend = pair[0].name.split(' ')[0]
  }

  // Практикант с итогом сезона — студент на бесплатной практике по договорённости с вузом
  const freePractice = vacancies.filter((v) => v.format === 'Бесплатная практика')
  for (const a of demo.filter((x) => story.get(x) === 'season_done')) {
    const v = pick(freePractice)
    Object.assign(a, {
      vacancyId: v.id,
      department: v.department,
      format: v.format,
      practiceSchool: true,
      notStudying: false,
      school: a.school || pick(practiceSchools),
      course: 'Вуз: 3–4 курс',
      birthDate: demoBirthDate(20, 22, now),
    })
  }

  // Итог сезона и резерв: первый практикант доработал и хочет остаться — его зовут в штат или резерв,
  // второй «На смене» ушёл до конца сезона, остальные ещё работают
  const outcome = new Map<Application, { outcome: SeasonOutcome; reason: SeasonLeaveReason | ''; reserve: boolean }>()
  const done = demo.filter((x) => story.get(x) === 'season_done')
  done.forEach((a, i) => outcome.set(a, { outcome: 'completed', reason: '', reserve: i === 0 }))
  if (done[0]) done[0].wantsToStay = true
  const working = demo.filter((x) => story.get(x) === 'started')
  if (working[1]) outcome.set(working[1], { outcome: 'left', reason: pick(demoLeaveReasons), reserve: false })
  if (working[0]) working[0].wantsToStay = true
  // «Как дела на смене»: ушедший до конца сезона на неделе отвечал «Тяжело», ещё одному тяжело сейчас — у HR задача перезвонить
  const hardNow = working[2] ?? demo.find((x) => story.get(x) === 'hired')

  // Самозапись: двое сами выбрали время собеседования по предложению HR
  const selfBooked = new Set(demo.filter((x) => story.get(x) === 'interview_future' && !byHr.has(x)).slice(0, 2))

  // День найма: ближайший рабочий день через три дня и позже, часы с 10 до 15 без обеда. Двое из самозаписи пришли
  // по ссылке дня — у заявок его метка, собеседования в его часах. Открытый день с меткой hiringday уже есть
  // (демо-данные добавляют второй раз) — второй не создаём: метка у открытого дня одна
  const [openDay] = await sql`select 1 from hiring_days where label = 'hiringday' and closed_at is null`
  let hdAt = now + 3 * DAY
  while (!isWorkday(hdAt)) hdAt += DAY
  const hiringDay = mskParts(hdAt).day
  const hiringHours = [10, 11, 12, 14, 15]
  const hiringGuests = new Map(openDay ? [] : [...selfBooked].map((a, i) => [a, mskAt(hiringDay, hiringHours[i]).getTime()]))
  for (const a of hiringGuests.keys()) a.source = 'hiringday'

  // Заявка из чата на сайте: согласие дано в чате
  const fromChat = webApps.find((a) => !invitedByBot.includes(a) && !pair.includes(a))

  // Два дубля: тот же человек недавно отправил заявку ещё раз с сайта
  const originals = demo.filter((a) => ['contacted', 'no_answer'].includes(story.get(a)!) && a.channel !== 'hr').slice(0, 2)
  const dups = originals.map((orig) => ({
    ...orig,
    id: makeApplicationId(),
    channel: 'web' as const,
    channelUserId: undefined,
    phone: orig.phone.replace(/^\+7 9/, '89'),
    contact: '',
    source: null,
    refCode: undefined,
  }))
  for (const d of dups) story.set(d, 'fresh')

  // Подписка «Напомнить о наборе» (миграция 018, пакет w2-bot) — только если колонки уже есть
  const [remindColumn] = await sql`
    select 1 from information_schema.columns where table_schema = current_schema() and table_name = 'bot_users' and column_name = 'remind_at'`
  let reminders = 0
  // События «Играть» и «поделиться» (миграция 020, пакет w2-platform) — только если база их уже принимает
  const [gameEvents] = await sql`
    select 1 from pg_constraint where conname = 'funnel_events_type_check' and pg_get_constraintdef(oid) like '%game_start%'`

  await sql.begin(async (tx) => {
    for (const a of [...demo, ...dups]) {
      const scenario = story.get(a)!
      const t = timeline(scenario, now)
      a.createdAt = new Date(t.created).toISOString()
      const steps: Step[] = [{ status: 'new', at: t.created }, ...t.steps]
      const status = steps.at(-1)!.status
      const manualInfo = byHr.get(a)
      const hr = staff.length && (steps.length > 1 || manualInfo) ? pick(staff) : null
      const filled = Math.random() < 0.6
      // Анкета кандидата требует фамилию, дату рождения, учёбу и когда может выйти: «Анна К.» → имя «Анна», фамилия «Ковалёва».
      // Добавленный по звонку — только имя и телефон: остальное HR допишет в карточке. В отклике с hh.ru фамилия и дата рождения есть
      const byPhone = manualInfo?.source === 'phone'
      const full = byPhone ? null : fullName(a.name)
      const birthDate = byPhone ? '' : (a.birthDate ?? '')
      const startReady = manualInfo ? '' : (a.startReady ?? '')
      const noAnswer = status === 'no_answer' ? 1 + Math.floor(Math.random() * 3) : 0
      const callback =
        status === 'no_answer' || (status === 'contacted' && Math.random() < 0.5) ? new Date(now + (Math.random() < 0.5 ? -2 : 20) * HOUR) : null
      const channel = a.channel ?? 'web'
      const consentSource = manualInfo?.consent ?? (a === fromChat ? 'site_chat' : consentFor(channel))
      const ob = onboarding(t, status, Boolean(a.practiceSchool), scenario, now)
      const season = status === 'started' ? outcome.get(a) : undefined

      await tx`
        insert into applications (id, created_at, channel, channel_user_id, name, phone, contact, school, course, department,
                                  vacancy_id, format, months, comment, friend, game, source, status, status_updated_at,
                                  assignee_id, no_answer_count, callback_at, callback_note, decline_reason,
                                  last_name, adult, citizenship, med_book, shifts,
                                  consent_at, consent_version, consent_source, consent_by, ref_code,
                                  birth_date, start_ready, start_month, not_studying, practice_school, wants_to_stay,
                                  onboarding_at, first_shift_at, shift_kind, mentor_name, practice_docs,
                                  season_outcome, season_leave_reason, reserve)
        values (${a.id}, ${new Date(t.created)}, ${channel}, ${a.channelUserId ?? null}, ${full?.first ?? a.name}, ${a.phone}, ${a.contact},
                ${byPhone ? '' : a.school}, ${byPhone ? '' : a.course}, ${a.department}, ${a.vacancyId}, ${a.format}, ${tx.json(a.months)}, ${a.comment},
                ${a.friend ?? ''}, ${tx.json(a.game as unknown as postgres.JSONValue)}, ${a.source}, ${status},
                ${new Date(steps.at(-1)!.at)}, ${hr?.id ?? null}, ${noAnswer}, ${callback},
                ${callback ? (status === 'no_answer' ? 'Не дозвонились, набрать ещё раз' : 'Подумает до вечера и ответит') : ''},
                ${status === 'declined' ? (t.declineReason ?? 'other') : ''},
                ${full?.last ?? ''}, ${birthDate ? true : null},
                ${filled ? citizenshipOptions[0].id : ''}, ${filled ? pick(medBookOptions).id : ''}, ${filled ? pick(shiftOptions).id : ''},
                ${new Date(t.created)}, ${CONSENT_VERSION}, ${consentSource}, ${manualInfo ? (hr?.name ?? '') : ''},
                ${a.refCode ?? null},
                ${birthDate || null}, ${startReady}, ${startReady === 'month' ? (a.startMonth ?? null) : null},
                ${!byPhone && Boolean(a.notStudying)}, ${Boolean(a.practiceSchool)}, ${Boolean(a.wantsToStay)},
                ${ob.onboardingAt}, ${ob.firstShiftAt}, ${ob.shiftKind}, ${ob.mentor}, ${tx.array(ob.docs)}::text[],
                ${season?.outcome ?? ''}, ${season?.reason ?? ''}, ${season?.reserve ?? false})`

      let prev: ApplicationStatus | null = null
      for (const [i, s] of steps.entries()) {
        // Кандидат сам отправил заявку; добавленного HR первой строкой записывает сотрудник
        const by = i === 0 && !manualInfo ? null : hr
        const name = by?.name ?? (i === 0 && !manualInfo ? 'Кандидат' : 'Отдел персонала')
        await tx`
          insert into application_history (application_id, created_at, user_id, user_name, from_status, to_status, comment)
          values (${a.id}, ${new Date(s.at)}, ${by?.id ?? null}, ${name}, ${prev}, ${s.status}, ${i === 0 && manualInfo ? manualInfo.note : ''})`
        prev = s.status
      }

      // Итог сезона — отдельной строкой истории, как его записывает карточка
      if (season && t.seasonAt !== undefined) {
        const label = seasonOutcomes.find((o) => o.id === season.outcome)!.label
        const comment = [season.reason ? `${label}: ${seasonLeaveReasonLabel(season.reason).toLowerCase()}` : label, season.reserve ? 'Звать в штат или в резерв' : '']
          .filter(Boolean)
          .join('. ')
        await tx`
          insert into application_history (application_id, created_at, user_id, user_name, kind, from_status, to_status, comment)
          values (${a.id}, ${new Date(t.seasonAt)}, ${hr?.id ?? null}, ${hr?.name ?? 'Отдел персонала'}, 'season', 'started', 'started', ${comment})`
      }

      // Ответы новичков на уже наступившие вопросы: из бота — в боте, с сайта — на «Моей заявке» или со слов при звонке
      const anchor = status === 'hired' || status === 'started' ? (ob.firstShiftAt ?? (status === 'started' ? new Date(steps.at(-1)!.at) : null)) : null
      if (anchor) {
        const bot = channel === 'telegram' || channel === 'max'
        const due = checkinSteps.filter((s) => checkinTime(anchor.toISOString(), s.id).getTime() <= now)
        for (const [i, s] of due.entries()) {
          const askedAt = checkinTime(anchor.toISOString(), s.id)
          if (season?.outcome === 'left' && i > 1) break
          let answer: CheckinAnswer | '' = Math.random() < 0.78 ? 'ok' : Math.random() < 0.6 ? 'question' : ''
          let reason: CheckinReason | '' = ''
          if (season?.outcome === 'left' && i === 1) {
            answer = 'hard'
            reason = season.reason === 'study' || season.reason === 'commute' || season.reason === 'money' || season.reason === 'schedule' ? season.reason : 'other'
          }
          if (a === hardNow && i === due.length - 1) [answer, reason] = ['hard', 'work']
          const answeredAt = answer ? new Date(Math.min(askedAt.getTime() + between(20, 180) * 60e3, now - 60e3)) : null
          const answeredVia = !answer ? '' : bot ? channel : Math.random() < 0.5 ? 'site' : 'hr'
          await tx`
            insert into application_checkins (application_id, step, asked_at, asked_via, answer, reason, answered_at, answered_via)
            values (${a.id}, ${s.id}, ${askedAt}, ${bot ? 'bot' : 'call'}, ${answer}, ${reason}, ${answeredAt}, ${answeredVia})`
          if (bot)
            await tx`
              insert into application_history (application_id, created_at, user_name, kind, from_status, to_status, comment, notify, notify_detail)
              values (${a.id}, ${askedAt}, 'Система', 'checkin', ${status}, ${status}, ${`Вопрос в ${channel === 'max' ? 'MAX' : 'Telegram'}: «${s.question}»`},
                      'sent', ${`отправлено в ${channel === 'max' ? 'MAX' : 'Telegram'}`})`
          if (answer) {
            const where = answeredVia === 'hr' ? 'со слов кандидата' : answeredVia === 'site' ? 'в «Моя заявка»' : `в ${channel === 'max' ? 'MAX' : 'Telegram'}`
            const text = `${checkinStepLabel(s.id)}: ${checkinAnswerLabel(answer).toLowerCase()}${reason ? ` — ${checkinReasonLabel(reason).toLowerCase()}` : ''} (${where})`
            await tx`
              insert into application_history (application_id, created_at, user_id, user_name, kind, from_status, to_status, comment)
              values (${a.id}, ${answeredAt}, ${answeredVia === 'hr' ? (hr?.id ?? null) : null}, ${answeredVia === 'hr' ? (hr?.name ?? 'Отдел персонала') : 'Кандидат'},
                      'checkin', ${status}, ${status}, ${text})`
          }
          if (a === hardNow && answer === 'hard')
            await tx`update applications set callback_at = ${nextWorkTime(now)}, callback_note = ${checkinHardNote(s.id, reason)} where id = ${a.id}`
        }
      }

      if (t.interview && hiringGuests.has(a)) t.interview.startsAt = hiringGuests.get(a)!
      if (t.interview) {
        const marked = t.interview.attended ? new Date(t.interview.startsAt + 2 * HOUR) : null
        await tx`
          insert into interviews (application_id, starts_at, address, bring, created_at, created_by, attended, attended_at, attended_by, self_booked)
          values (${a.id}, ${new Date(t.interview.startsAt)}, ${interviewDefaults.address}, ${interviewDefaults.bring}, ${new Date(t.interview.createdAt)},
                  ${hr?.id ?? null}, ${t.interview.attended}, ${marked}, ${marked ? (hr?.id ?? null) : null}, ${selfBooked.has(a)})`
      }
    }

    // Аудитория ботов: подавшие заявку и те, кто только поиграл
    const botUser = async (channel: string, userId: string, firstName: string, source: string, at: Date, tasks: DemoTask[], ref?: string) => {
      const progress = Object.fromEntries(tasks.map((t) => [t, t === 'game' || t === 'myth' ? 3 : true]))
      await tx`
        insert into bot_users (channel, user_id, first_name, source, created_at, last_seen_at)
        values (${channel}, ${userId}, ${firstName}, ${source}, ${at}, ${at}) on conflict do nothing`
      const session = { flow: null, data: ref ? { ref } : {}, progress, source }
      await tx`
        insert into sessions (channel, user_id, data) values (${channel}, ${userId}, ${tx.json(session as unknown as postgres.JSONValue)})
        on conflict do nothing`
    }
    for (const a of botApps) {
      const ref = referrers.find((r) => r.app === a)?.code
      const firstSeen = new Date(new Date(a.createdAt).getTime() - between(10, 90) * 60e3)
      await botUser(a.channel!, a.channelUserId!, a.name.split(' ')[0], a.source ?? a.channel!, firstSeen, demoTaskList(a.game), ref)
      for (let k = 0; k < 2 + Math.floor(Math.random() * 4); k++) {
        const tasks = Math.random() < 0.5 ? [pick(['game', 'myth', 'money', 'quiz'] as const)] : []
        const userId = `demo-${rnd()}`
        const at = new Date(now - Math.random() * 14 * DAY)
        await botUser(a.channel!, userId, pick(['Саша', 'Женя', 'Лиза', 'Олег', 'Вика']), a.channel!, at, tasks)
        // Заявку не оставил, но попросил напомнить о наборе; один потом нажал «Не присылать»
        if (remindColumn && k === 0 && (reminders < 2 || Math.random() < 0.5)) {
          const remindAt = new Date(at.getTime() + between(3, 20) * 60e3)
          const off = reminders === 1 ? new Date(Math.min(remindAt.getTime() + between(1, 5) * DAY, now - HOUR)) : null
          await tx`
            update bot_users set remind_at = ${remindAt}, remind_source = ${a.channel!}, remind_dept = ${Math.random() < 0.3 ? 'any' : pick(departmentList).id},
                   remind_off_at = ${off && off > remindAt ? off : null}
            where channel = ${a.channel!} and user_id = ${userId}`
          reminders++
        }
      }
    }

    // Воронка сайта: у каждой заявки с сайта — посетитель с заданиями и заявкой, вокруг — те, кто заявку не оставил
    // task у события share — вид: game, money или invite
    const event = (at: number, visitor: string, type: string, source: string | null, task?: string) =>
      tx`insert into funnel_events (created_at, visitor, type, task, source) values (${new Date(at)}, ${visitor}, ${type}, ${task ?? null}, ${source}) on conflict do nothing`
    for (const a of [...webApps, ...dups]) {
      const created = new Date(a.createdAt).getTime()
      const visitor = `demo-${rnd()}`
      const tasks = demoTaskList(a.game)
      // Каждое задание — до пяти минут, заявку открывают после последнего
      let at = created - (tasks.length * 5 + between(8, 30)) * 60e3
      await event(at, visitor, 'visit', a.source)
      for (const task of tasks) {
        at += between(1, 5) * 60e3
        if (task === 'game' && gameEvents) await event(at - 50e3, visitor, 'game_start', a.source)
        await event(at, visitor, 'task_done', a.source, task)
      }
      await event(created - 3 * 60e3, visitor, 'apply_open', a.source)
      // Позвавший друга с сайта делился приглашением; часть игроков — результатом
      if (gameEvents && (a.refCode || (tasks.includes('game') && Math.random() < 0.25))) await event(created - 60e3, visitor, 'share', a.source, a.refCode ? 'invite' : 'game')
      await event(created, visitor, 'application', a.source)
    }
    for (const a of webApps) {
      for (let v = 0; v < 6 + Math.floor(Math.random() * 10); v++) {
        const visitor = `demo-${rnd()}`
        const at = now - Math.random() * 14 * DAY
        await event(at, visitor, 'visit', a.source)
        if (Math.random() < 0.45) {
          const tasks = ['game', 'money', 'quiz', 'myth'].sort(() => Math.random() - 0.5).slice(0, 1 + Math.floor(Math.random() * 3)) as DemoTask[]
          for (const [k, task] of tasks.entries()) {
            if (task === 'game' && gameEvents) await event(at + (k + 1) * 3 * 60e3 - 50e3, visitor, 'game_start', a.source)
            await event(at + (k + 1) * 3 * 60e3, visitor, 'task_done', a.source, task)
          }
          if (gameEvents && Math.random() < 0.15) await event(at + 12 * 60e3, visitor, 'share', a.source, tasks.includes('game') ? 'game' : 'money')
          if (Math.random() < 0.3) await event(at + 15 * 60e3, visitor, 'apply_open', a.source)
        }
      }
    }

    // День найма и записи по его ссылке: предложение выбрать час с выбранным собеседованием
    const author = staff[0] ?? null
    const [day] = openDay ? [] : await tx<{ id: string }[]>`
      insert into hiring_days (day, hours, capacity, address, label, note, created_by, created_by_name)
      values (${hiringDay}::date, ${tx.array(hiringHours)}::int[], 3, ${interviewDefaults.address}, 'hiringday',
              'Экскурсия по цехам в 10:00, встречаем на проходной', ${author?.id ?? null}, ${author?.name ?? 'Отдел персонала'})
      returning id`
    for (const [a, startsAt] of day ? hiringGuests : []) {
      await tx`
        insert into booking_offers (application_id, created_at, created_by_name, expires_at, status_before, used_at, interview_id, hiring_day_id)
        select ${a.id}, ${new Date(new Date(a.createdAt).getTime() + 60e3)}, 'Кандидат', ${new Date(startsAt)}, 'new', ${new Date(new Date(a.createdAt).getTime() + 3 * 60e3)}, i.id, ${day.id}
        from interviews i where i.application_id = ${a.id} and i.cancelled_at is null limit 1`
    }

    // Анкета фокус-группы: демо-ответы с меткой demo — панель подписывает их «Демо-ответы, не исследование»
    const [focusTable] = await tx`select 1 from information_schema.tables where table_schema = current_schema() and table_name = 'focus_responses'`
    if (focusTable)
      for (let i = 0; i < 24; i++) {
        const weighted = <T,>(list: [T, number][]) => {
          let r = Math.random() * list.reduce((n, [, w]) => n + w, 0)
          for (const [v, w] of list) if ((r -= w) <= 0) return v
          return list[0][0]
        }
        const slogan = () => weighted<string>([['teach', 5], ['natural', 3], ['people', 2], ['none', 1]])
        await tx`
          insert into focus_responses (tag, clear, interest, hook, intent, missing, study, created_at)
          values ('demo', ${slogan()}, ${slogan()}, ${weighted<string>([['pay', 5], ['mentor', 3], ['no_probation', 2], ['dorm', 2], ['kvass', 1], ['history', 1], ['nothing', 1]])},
                  ${weighted<string>([['yes', 3], ['maybe', 4], ['no', 1]])}, ${i % 4 === 0 ? pick(demoFocusMissing) : ''},
                  ${weighted<string>([['college', 2], ['uni_junior', 2], ['uni_senior', 4], ['graduated', 2]])}, ${new Date(daytime(1 + Math.floor(Math.random() * 10), now))})`
      }

    // Вопросы к Квасычу без ответа: тема — по тому же словарю, что у помощника
    for (const { q, channel } of demoQuestions) {
      await tx`
        insert into kb_gaps (created_at, channel, topic, question)
        values (${new Date(daytime(1 + Math.floor(Math.random() * 12), now))}, ${channel}, ${gapTopic(q) ?? TOPIC.other}, ${q})`
    }
  })
  await seedRegistry(sql, [...new Set([...demo, ...dups].map((a) => a.source).filter((v): v is string => Boolean(v)))])
  return demo.length + dups.length
}

/**
 * Реестр меток с расходом для «Воронки» — у пакета реестра меток (server/db/sources.ts, миграция 014):
 * если модуль есть и умеет seedDemoSources(sql, метки), даём ему метки демо-заявок. Без реестра ничего не делаем
 */
async function seedRegistry(sql: Sql, codes: string[]) {
  const mod = (await import('./sources' as string).catch(() => null)) as { seedDemoSources?: (sql: Sql, codes: string[]) => Promise<unknown> } | null
  if (typeof mod?.seedDemoSources === 'function') await mod.seedDemoSources(sql, codes)
}

/**
 * «Очистить базу» на демо-стенде: заявки с историей и собеседованиями, события воронки, очередь сообщений,
 * вопросы к Квасычу и вся аудитория ботов с диалогами — после проверок на стенде не остаётся чужих записей.
 * Сотрудники, тексты, план и настройки остаются
 */
export async function clearAll(sql: Sql): Promise<number> {
  return sql.begin(async (tx) => {
    const rows = await tx`delete from applications returning id`
    await tx`delete from funnel_events`
    await tx`delete from jobs where kind in ('notify', 'reminder') or payload ? 'applicationId'`
    await tx`delete from kb_gaps`
    await tx`delete from sessions`
    await tx`delete from bot_users`
    // Предложения выбрать время ушли вместе с заявками (on delete cascade); дни найма, демо-расходы,
    // ответы фокус-группы и журнал выгрузок — отдельно. Настоящие расходы по меткам не трогаем
    await tx`delete from hiring_days`
    await tx`delete from source_costs where demo`
    await tx`delete from focus_responses`
    await tx`delete from access_log`
    return rows.length
  })
}

const surnames: Record<string, string> = {
  А: 'Алексеев', Б: 'Белов', В: 'Волков', Г: 'Громов', Д: 'Данилов', Е: 'Егоров', Ж: 'Жуков', З: 'Зайцев', И: 'Ильин', К: 'Ковалёв',
  Л: 'Лебедев', М: 'Морозов', Н: 'Новиков', О: 'Орлов', П: 'Павлов', Р: 'Романов', С: 'Соколов', Т: 'Титов', Ф: 'Фёдоров', Х: 'Хохлов',
  Ц: 'Цветков', Ч: 'Чернов', Ш: 'Шаров', Ю: 'Юдин',
}

/** «Анна К.» → { first: 'Анна', last: 'Ковалёва' } для демо-анкет */
function fullName(name: string) {
  const [first, initial] = name.split(' ')
  const base = surnames[initial?.[0] ?? '']
  if (!first || !base) return null
  const female = /[ая]$/.test(first) && first !== 'Никита'
  return { first, last: female ? `${base}а` : base }
}
