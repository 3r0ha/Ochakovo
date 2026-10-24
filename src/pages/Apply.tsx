import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router'
import { Checkbox, Disclosure, Field, MonthCell, Segmented, Select, TextArea, TextInput } from '../components/candidate/FormControls'
import { Booking, BotLinks, Checkin, StatusBlock, StatusSteps, VisitInfo, Withdraw } from '../components/candidate/ApplicationStatus'
import { NextSteps } from '../components/candidate/NextSteps'
import { asksMedBook, asksPortfolio, asksShifts } from '../components/candidate/questionnaire'
import { applicationNumber, useSentApplication, type SentApplication } from '../components/candidate/sent'
import { fetchStatus, useCandidateStatus } from '../components/candidate/status'
import {
  birthDateForSend,
  caseFieldErrors,
  consentMessages,
  friendField,
  friendName,
  inviteOffer,
  promiseLine,
  rejectedText,
  serverBirthDateError,
  typeBirthDate,
  type CaseFieldKey,
} from '../components/candidate/applyText'
import {
  CONSENT_VERSION,
  NOT_STUDYING_LABEL,
  citizenshipOptions,
  isPortfolioUrl,
  medBookOptions,
  normalizePortfolio,
  shiftOptions,
  startMonthOptions,
  startReadyOptions,
  type Citizenship,
  type MedBook,
  type ShiftPreference,
  type StartReady,
} from '@shared/applications'
import { contacts } from '@shared/content/content'
import { departmentList, departments, type DepartmentId } from '@shared/content/departments'
import { isPractice, openVacancyById, payLabel, vacancies, vacancyById, vacancyFormats, type Vacancy, type VacancyFormat } from '@shared/content/vacancies'
import { btn, Dash, ShiftBottle } from '../home/kit'
import { ApiValidationError, ApplicationOffline, ApplyRejected, submitApplication, trackEvent, type Application } from '../lib/api'
import { scrollToTop } from '../lib/motion'
import { invitedBy, inviteUrl, myRefCode, refCodeFromSource } from '../lib/ref'
import { seasonMonths, seasonYear } from '../lib/season'
import { nb } from '../lib/typo'
import { companyQuizSnapshot, useCompanyQuiz } from '../game/companyQuizStore'
import { activityList, selectDoneCount, useActivities } from '../store/activities'
import { useProfile } from '../store/profile'

const ease = [0.16, 1, 0.3, 1] as const

// «Диплом уже есть» — это отметка «Уже не учусь», курс тогда не спрашиваем
const courses = ['Колледж: 1–2 курс', 'Колледж: 3–4 курс', 'Вуз: 1–2 курс', 'Вуз: 3–4 курс', 'Магистратура']

type Form = {
  name: string
  reach: string
  /** Вуз или колледж — обязательно, если не отмечено «Уже не учусь» */
  school: string
  notStudying: boolean
  course: string
  /** Отчество — если есть */
  middleName: string
  /** Дата рождения как набрана: ДД.ММ.ГГГГ. Берём с 18 лет — проверка по ней */
  birthDate: string
  /** Когда может выйти на работу; month — с месяца startMonth */
  startReady: StartReady | ''
  startMonth: number | null
  department: DepartmentId | ''
  vacancyId: string
  format: VacancyFormat | ''
  months: number[]
  comment: string
  withFriend: boolean
  /** Имя друга — необязательно. Контакт друга не спрашиваем: согласия на его данные нет */
  friend: string
  /** Фамилия — обязательна по кейсу: ФИО, дата рождения, контакт, вакансия, готовность выйти, учёба */
  lastName: string
  citizenship: Citizenship | ''
  medBook: MedBook | ''
  shifts: ShiftPreference | ''
  portfolio: string
  /** Нужна практика от вуза: договор и дневник */
  practiceSchool: boolean
  wantsToStay: boolean
  /** Согласие на обработку данных — отдельная обязательная отметка. Возраст — по дате рождения */
  consent: boolean
  /** Ловушка для ботов: человек это поле не видит */
  website: string
}

type ErrorKey = 'pick' | 'name' | 'reach' | 'portfolio' | 'consent' | CaseFieldKey
type Errors = Partial<Record<ErrorKey, string>>

// Порядок — как поля на экране: фокус уходит на первое поле с ошибкой
const fieldOrder: ErrorKey[] = ['pick', 'lastName', 'name', 'birthDate', 'reach', 'school', 'startReady', 'startMonth', 'portfolio', 'consent']
/** id поля на странице: на него уходит фокус */
const fieldId: Record<ErrorKey, string> = {
  pick: 'apply-pick',
  lastName: 'apply-last-name',
  name: 'apply-name',
  birthDate: 'apply-birth-date',
  reach: 'apply-reach',
  school: 'apply-school',
  startReady: 'apply-start-ready',
  startMonth: 'apply-start-month',
  portfolio: 'apply-portfolio',
  consent: 'apply-consent',
}

/** Ник из ссылки t.me/… или с @ — к виду @username */
const cleanHandle = (v: string) =>
  v
    .trim()
    .replace(/^(https?:\/\/)?(t\.me|telegram\.me)\//i, '')
    .replace(/^@?/, '@')

/** Телефон — от 10 цифр; Telegram — @ник или ник из латиницы от 5 символов */
const isTelegram = (v: string) => /^@?[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(cleanHandle(v))
const isPhone = (v: string) => v.replace(/\D/g, '').length >= 10 && !/[a-zA-Z]/.test(v)

/** Российский номер — к виду +7 999 123-45-67; остальные номера оставляем как есть */
function formatPhone(v: string) {
  let d = v.replace(/\D/g, '')
  if (d.length === 11 && (d.startsWith('8') || d.startsWith('7'))) d = d.slice(1)
  if (d.length !== 10) return v.trim()
  return `+7 ${d.slice(0, 3)} ${d.slice(3, 6)}-${d.slice(6, 8)}-${d.slice(8)}`
}

/** Ник без цифр телефона — значит, HR ответит в Telegram */
const viaTelegram = (reach: string) => !isPhone(reach) && isTelegram(reach)

/** Что вводят в поле связи: телефон — цифровая клавиатура, Telegram — обычная с «@» перед ником */
type ReachMode = 'phone' | 'telegram'
const reachModes: { id: ReachMode; label: string }[] = [
  { id: 'phone', label: 'Телефон' },
  { id: 'telegram', label: 'Telegram' },
]
/** Подходит ли набранное к режиму: при переключении подходящее оставляем, остальное стираем */
const fitsMode = (v: string, mode: ReachMode) => (mode === 'phone' ? isPhone(v) : isTelegram(v))

/** Учусь или уже нет — выбор стоит перед полем вуза: от него зависит, обязательно ли поле */
type Study = 'studying' | 'not'
const studyOptions: { id: Study; label: string }[] = [
  { id: 'studying', label: 'Учусь' },
  { id: 'not', label: NOT_STUDYING_LABEL },
]

/** Практика от вуза: бесплатная практика идёт по договорённости с вузом или колледжем — отметку ставим сами */
const wantsSchoolPractice = (v: Vacancy | undefined) => v?.format === 'Бесплатная практика'

// Текстовые поля — «Укажи…», выбор — «Выбери…»: один глагол на тип поля, как в текстах сервера (shared/applications.ts)
const messages = {
  name: 'Укажи имя',
  reach: { phone: 'Укажи телефон: от 10 цифр', telegram: 'Укажи ник в Telegram: от 5 символов, латиница и цифры' } satisfies Record<ReachMode, string>,
  portfolio: 'Укажи ссылку целиком, например behance.net/твоё-имя',
  pick: 'Выбери одну из двух или другую вакансию в блоке «Необязательно»',
  ...consentMessages,
}

/** Текст согласия и политика открываются в новой вкладке, чтобы не потерять заполненную форму */
const legalLink = 'text-white underline decoration-white/35 underline-offset-4 hover:decoration-white'

/** Откуда в заявке вакансия: из ссылки, из выбора между заданиями, из подбора работы или из «Собери лето» */
type PresetSource = 'url' | 'chosen' | 'quiz' | 'money'
const sourceName = { quiz: 'подбора работы', money: '«Собери лето»' } as const

/**
 * mustPick — задания предложили разные вакансии, и человек ещё не выбрал: без выбора заявку не отправляем.
 * Поля кейса проверяет та же функция, что сервер и бот (caseFieldErrors → checkApplication)
 */
function validate(f: Form, mustPick = false, mode: ReachMode = 'phone'): Errors {
  const e: Errors = { ...caseFieldErrors(f).errors }
  if (mustPick && !f.vacancyId) e.pick = messages.pick
  if (f.name.trim().length < 2) e.name = messages.name
  // Принимаем и номер, и ник при любом положении переключателя; текст ошибки — про то, что выбрано
  if (!isPhone(f.reach) && !isTelegram(f.reach)) e.reach = messages.reach[mode]
  if (asksPortfolio(f.department, f.vacancyId) && f.portfolio.trim() && !isPortfolioUrl(f.portfolio)) e.portfolio = messages.portfolio
  if (!f.consent) e.consent = messages.consent
  return e
}

/** Сфокусировать поле с ошибкой: у выбора «Когда сможешь выйти» — первую кнопку */
const focusField = (form: HTMLFormElement | null, key: ErrorKey) => form?.querySelector<HTMLElement>(`#${fieldId[key]}`)?.focus()

export function Apply() {
  const [params, setParams] = useSearchParams()
  const profile = useProfile()
  const done = useActivities((s) => s.done)
  const shift = useActivities(selectDoneCount)
  // Пришли по ссылке друга (?src=ref_<код>, метка friend-<код>). Своя ссылка не считается
  const invited = Boolean(invitedBy(profile.source))
  // Вакансия: из ссылки → выбор человека → подбор работы → «Собери лето».
  // Если подбор работы и «Собери лето» предложили разные — не выбираем молча, а спрашиваем.
  // Только открытые вакансии: закрытая в панели не подставляется в форму
  const fromUrl = openVacancyById(params.get('vacancy') ?? '')
  const chosenV = openVacancyById(profile.chosenVacancy ?? '')
  const quizV = openVacancyById(profile.quizVacancy ?? '')
  const moneyV = openVacancyById(profile.moneyVacancy ?? '')
  const conflict = !fromUrl && !chosenV && quizV && moneyV && quizV.id !== moneyV.id ? ([quizV, moneyV] as const) : null
  const preset = fromUrl ?? chosenV ?? (conflict ? undefined : (quizV ?? moneyV))
  // Выбор показываем весь визит, даже после нажатия: можно передумать
  const [pickFrom] = useState(conflict)
  const presetSource: PresetSource | null = fromUrl
    ? 'url'
    : chosenV
      ? 'chosen'
      : quizV && preset === quizV
        ? 'quiz'
        : moneyV && preset === moneyV
          ? 'money'
          : null

  const [form, setForm] = useState<Form>(() => ({
    name: profile.name,
    reach: '',
    school: '',
    notStudying: false,
    course: '',
    middleName: '',
    birthDate: '',
    startReady: '',
    startMonth: null,
    department: preset?.department ?? profile.quizResult ?? '',
    vacancyId: preset?.id ?? '',
    format: preset?.format ?? '',
    months: profile.months ?? [],
    comment: '',
    // ?friend=1 — пришли по кнопке «Откликнуться вдвоём» после приглашения друга
    withFriend: invited || params.get('friend') === '1',
    friend: '',
    lastName: '',
    citizenship: '',
    medBook: '',
    shifts: '',
    portfolio: '',
    // ?practice=1 — отклик на практику от вуза со страницы вакансий; бесплатная практика — всегда по договору с вузом
    practiceSchool: params.get('practice') === '1' || wantsSchoolPractice(preset),
    wantsToStay: false,
    consent: false,
    website: '',
  }))
  const [more, setMore] = useState(false)
  const [reachMode, setReachMode] = useState<ReachMode>('phone')
  const reachRef = useRef<HTMLInputElement>(null)
  const companyBest = useCompanyQuiz((s) => s.best)
  const still = useReducedMotion()
  const monthNames = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь']
  // «Подставлено из подбора работы: …; из «Собери лето»: …» — называем настоящий источник каждого поля
  const vacancySource =
    !pickFrom && form.vacancyId && form.vacancyId === preset?.id && presetSource !== 'url'
      ? presetSource === 'chosen'
        ? form.vacancyId === profile.quizVacancy
          ? 'quiz'
          : form.vacancyId === profile.moneyVacancy
            ? 'money'
            : null
        : presetSource
      : null
  const monthsText = profile.months?.length && form.months.length ? form.months.map((m) => monthNames.at(m - 1)).join(', ') : null
  const prefillParts: Record<'quiz' | 'money', string[]> = {
    quiz: [],
    money: [],
  }
  if (vacancySource === 'quiz' || vacancySource === 'money') prefillParts[vacancySource].push(vacancyById(form.vacancyId)!.title)
  if (monthsText) prefillParts.money.push(monthsText)
  // Что из заданий на главной уйдёт в заявку — строки карточки рядом с формой. Рекорд игры — переключателем в той же карточке
  const quizPick = vacancyById(profile.quizVacancy ?? '')?.title ?? (profile.quizResult ? departments[profile.quizResult].name : null)
  const sentGame = [
    quizPick ? `Подбор работы: ${quizPick}` : '',
    monthsText ? `Месяцы работы: ${monthsText}` : '',
    companyBest ? `Викторина: ${companyBest.score} из ${companyBest.total}` : '',
  ].filter(Boolean)
  const prefilled = (['quiz', 'money'] as const)
    .filter((k) => prefillParts[k].length)
    .map((k) => `из ${sourceName[k]}: ${prefillParts[k].join(', ')}`)
    .join('; ')
  const [errors, setErrors] = useState<Errors>({})
  // Сообщение над кнопкой; whatsapp — в тексте есть «напиши в WhatsApp», слово становится ссылкой
  const [formError, setFormError] = useState<{ text: string; whatsapp?: boolean } | null>(null)
  // Сервер заявок недоступен: данные остаются в форме, показываем повтор и запасные каналы
  const [offline, setOffline] = useState(false)
  const [sending, setSending] = useState(false)
  const lastSent = useSentApplication((s) => s.last)
  const rememberSent = useSentApplication((s) => s.remember)
  const forgetSent = useSentApplication((s) => s.forget)
  // Заявку удалили по просьбе кандидата — над формой одна строка об этом
  const [withdrawn, setWithdrawn] = useState<string | null>(null)
  // Ссылка на заявку с другого устройства не подошла: неверный номер или ключ
  const [linkFailed, setLinkFailed] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()

  // /apply#app=<номер>.<ключ> — «Моя заявка» с другого устройства. Фрагмент убираем сразу: ключ не остаётся в адресе
  // и истории. Подошёл — запоминаем заявку без имени и телефона; не подошёл — прежняя заявка в браузере не трогается
  useEffect(() => {
    if (!location.hash.startsWith('#app=')) return
    const m = /^#app=([A-Za-z0-9]{4,16})\.([\w-]{20,64})$/.exec(location.hash)
    navigate({ pathname: location.pathname, search: location.search, hash: '' }, { replace: true })
    if (!m) return setLinkFailed(true)
    const [, id, token] = m
    // Без отмены при смене адреса: фрагмент мы только что убрали сами, ответ статуса всё равно нужен
    void fetchStatus(id.toUpperCase(), token).then((status) => {
      if (!status) return setLinkFailed(true)
      setLinkFailed(false)
      const vacancyId = vacancies.find((v) => v.title === status.vacancyTitle)?.id ?? ''
      rememberSent({ id: status.id, name: '', phone: '', contact: '', vacancyId, token })
      setShowSent(true)
    })
    // при открытии страницы по такой ссылке
  }, [location.hash])
  // Заявка уже отправлена — показываем её номер и что дальше. Пришли по ссылке на конкретную вакансию — сразу форма
  const [showSent, setShowSent] = useState(() => Boolean(lastSent) && !params.get('vacancy'))
  // Экран «Заявка отправлена» сразу после отправки (а не при повторном заходе) — переводим на него фокус
  const [justSent, setJustSent] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)

  // Анонимное событие воронки: человек открыл форму заявки
  useEffect(() => {
    trackEvent('apply_open')
  }, [])

  // На компьютере сразу ставим курсор в первое пустое поле; на телефоне не открываем клавиатуру без спроса
  useEffect(() => {
    if (showSent || !window.matchMedia('(pointer: fine)').matches) return
    document.getElementById('apply-last-name')?.focus({ preventScroll: true })
    // при каждом показе формы
  }, [showSent])

  /** Проверка поля при уходе с него: пустое не ругаем, неверно заполненное — подсвечиваем */
  const checkOnBlur = (key: 'name' | 'reach' | 'lastName' | 'birthDate' | 'school') => {
    const value = form[key].trim()
    if (!value) return
    // Набрали номер в режиме Telegram или ник в режиме телефона — переключатель встаёт сам
    if (key === 'reach' && isPhone(value)) {
      set('reach', formatPhone(value))
      setReachMode('phone')
    }
    if (key === 'reach' && !isPhone(value) && isTelegram(value)) {
      set('reach', cleanHandle(value))
      setReachMode('telegram')
    }
    const found = validate({ ...form, consent: true }, false, reachMode)
    if (found[key]) setErrors((e) => ({ ...e, [key]: found[key] }))
  }
  // Моложе 18 по дате рождения: заявку не отправить — рядом с ошибкой ссылка на задания, их можно проходить без заявки
  const underage = errors.birthDate !== undefined && caseFieldErrors(form).underage

  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm((f) => ({ ...f, [key]: value }))
    if (key in errors) setErrors((e) => ({ ...e, [key]: undefined }))
  }

  const pickVacancy = (id: string) => {
    const v = vacancyById(id)
    setForm((f) => ({
      ...f,
      vacancyId: id,
      department: v ? v.department : f.department,
      format: v ? v.format : f.format,
      // Бесплатная практика — по договору с вузом или колледжем: отметка «Практика от вуза» ставится сама, снять её можно
      practiceSchool: wantsSchoolPractice(v) && !f.notStudying ? true : f.practiceSchool,
    }))
  }

  /** Телефон или Telegram: подходящее к новому режиму значение остаётся, фокус — обратно в поле, чтобы сменилась клавиатура */
  const switchReach = (mode: ReachMode) => {
    setReachMode(mode)
    setForm((f) => ({ ...f, reach: fitsMode(f.reach, mode) ? f.reach : '' }))
    setErrors((e) => ({ ...e, reach: undefined }))
    window.setTimeout(() => reachRef.current?.focus(), 0)
  }

  const toggleMonth = (m: number) => set('months', form.months.includes(m) ? form.months.filter((x) => x !== m) : [...form.months, m].sort((a, b) => a - b))

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    const found = validate(form, Boolean(pickFrom), reachMode)
    setErrors(found)
    const first = fieldOrder.find((k) => found[k])
    if (first) {
      if (first === 'portfolio' && !more) setMore(true)
      window.setTimeout(() => focusField(formRef.current, first), first === 'portfolio' ? 60 : 0)
      return
    }
    // Нет сети — честно говорим об этом, а не делаем вид, что заявка ушла
    if (!navigator.onLine) {
      setFormError({ text: 'Нет интернета, заявка не отправится. Подключись к сети и нажми ещё раз.' })
      return
    }
    setFormError(null)
    setSending(true)
    profile.setName(form.name.trim())
    const reach = form.reach.trim()
    // Вопросы, которых сейчас нет на экране (сменили направление), не отправляем
    const medBook = asksMedBook(form.department, form.vacancyId) ? form.medBook : ''
    const shifts = asksShifts(form.department, form.vacancyId) ? form.shifts : ''
    const portfolio = asksPortfolio(form.department, form.vacancyId) ? normalizePortfolio(form.portfolio) : ''
    // Своя ссылка-приглашение источником не считается: такую метку не отправляем
    const ownLink = refCodeFromSource(profile.source) !== null && !invitedBy(profile.source)
    let app: Application
    try {
      app = await submitApplication({
        name: form.name.trim(),
        lastName: form.lastName.trim().slice(0, 80),
        ...(form.middleName.trim() ? { middleName: form.middleName.trim().slice(0, 80) } : {}),
        // Дата рождения — ГГГГ-ММ-ДД; 18+ сервер выводит из неё сам
        birthDate: birthDateForSend(form.birthDate),
        startReady: form.startReady,
        ...(form.startReady === 'month' && form.startMonth ? { startMonth: form.startMonth } : {}),
        // Согласие — отдельная обязательная отметка; версия — текста на странице /consent
        consent: true,
        consentVersion: CONSENT_VERSION,
        ...(form.citizenship ? { citizenship: form.citizenship } : {}),
        ...(medBook ? { medBook } : {}),
        ...(shifts ? { shifts } : {}),
        ...(portfolio ? { portfolio } : {}),
        phone: isPhone(reach) ? reach : '',
        contact: isPhone(reach) ? '' : cleanHandle(reach),
        school: form.school.trim(),
        notStudying: form.notStudying,
        course: form.notStudying ? '' : form.course,
        department: form.department,
        vacancyId: form.vacancyId,
        format: form.format,
        months: form.months,
        comment: form.comment.trim(),
        friend: friendField(form.withFriend, form.friend),
        practiceSchool: !form.notStudying && form.practiceSchool,
        wantsToStay: form.wantsToStay,
        game: {
          quizResult: profile.quizResult,
          // Счёт игры — только если человек оставил «Показать результат игры»
          conveyorBest: profile.attachScore ? profile.conveyorBest : 0,
          activities: selectDoneCount(useActivities.getState()),
          ...(companyQuizSnapshot() ? { companyQuiz: companyQuizSnapshot()! } : {}),
        },
        source: ownLink ? null : profile.source,
        // Личный код приглашения закрепляется за заявкой: по нему HR свяжет заявки друзей, которых позовёт этот человек
        refCode: myRefCode(),
        website: form.website,
      })
    } catch (err) {
      setSending(false)
      if (err instanceof ApiValidationError) {
        setOffline(false)
        const next: Errors = {
          name: err.errors.name ? messages.name : undefined,
          reach: err.errors.phone ? messages.reach[reachMode] : undefined,
          portfolio: err.errors.portfolio ? messages.portfolio : undefined,
          // Поля кейса — тексты сервера (они же в shared/applications.ts); моложе 18 — «Берём с 18 лет»
          lastName: err.errors.lastName || undefined,
          birthDate: serverBirthDateError(err.errors.birthDate, err.codes.birthDate),
          school: err.errors.school || undefined,
          startReady: err.errors.startReady || undefined,
          startMonth: err.errors.startMonth || undefined,
          // Сервер не принял согласие: например, текст согласия обновился — показываем его объяснение и снимаем отметку
          consent: err.errors.consent || undefined,
        }
        if (next.consent) setForm((f) => ({ ...f, consent: false }))
        setErrors(next)
        setFormError({ text: err.codes.birthDate === 'underage' ? 'Заявку принимаем с 18 лет.' : 'Проверь поля, отмеченные красным.' })
        const first = fieldOrder.find((k) => next[k])
        if (first) window.setTimeout(() => focusField(formRef.current, first), 0)
      } else if (err instanceof ApplyRejected) {
        setOffline(false)
        setFormError(rejectedText(err.reason, err.retryAfter))
      } else if (err instanceof ApplicationOffline) {
        setOffline(true)
        setFormError({ text: 'Сервер заявок сейчас не отвечает, заявка не отправлена. Данные остались в форме, нажми «Отправить ещё раз».' })
      } else {
        setOffline(true)
        setFormError({ text: 'Не получилось отправить заявку. Данные остались в форме, попробуй ещё раз через минуту.' })
      }
      return
    }
    setSending(false)
    rememberSent(app)
    setJustSent(true)
    setShowSent(true)
    // Ссылка без ?vacancy — при обновлении страницы останется экран с номером заявки, а не пустая форма
    if (params.has('vacancy')) setParams({}, { replace: true })
    scrollToTop()
  }

  // Вакансии в списке — группами по формату, как на странице вакансий: оплачиваемая практика, бесплатная практика, работа
  const vacancyGroups = vacancyFormats.map((f) => ({ format: f, list: vacancies.filter((v) => v.format === f) })).filter((g) => g.list.length)
  const chosen = vacancyById(form.vacancyId)
  const closed = shift === activityList.length
  const telegram = viaTelegram(form.reach)
  const showMedBook = asksMedBook(form.department, form.vacancyId)
  const showShifts = asksShifts(form.department, form.vacancyId)
  const showPortfolio = asksPortfolio(form.department, form.vacancyId)

  return (
    <div className="min-h-svh bg-night pt-[calc(72px+var(--invite-h,0px))] text-white">
      {/* Ссылка с другого устройства не подошла — над любым экраном: и над формой, и над «Моей заявкой» */}
      {linkFailed && (
        <div className="container-x pt-8">
          <p role="alert" className="max-w-xl border-l-[3px] border-brand pl-4 text-[17px] leading-relaxed text-white">
            {nb(`Ссылка не подошла: заявки по ней нет или ключ неверный. Напиши в отдел персонала: ${contacts.email}, ${contacts.phone}, ${contacts.phoneNote}.`)}
          </p>
        </div>
      )}
      <AnimatePresence mode="wait" initial={false}>
        {showSent && lastSent ? (
          <Success
            key="done"
            app={lastSent}
            closed={closed}
            focus={justSent}
            onAnother={() => {
              setShowSent(false)
              scrollToTop()
            }}
            onWithdrawn={(result, number) => {
              forgetSent()
              setWithdrawn(
                result === 'withdrawn'
                  ? `Заявка ${number} удалена, согласие отозвано. Отдел персонала больше не свяжется по ней.`
                  : `Заявки ${number} уже нет у отдела персонала. Копия на этой странице стёрта.`,
              )
              setShowSent(false)
              scrollToTop()
            }}
          />
        ) : (
          <motion.div key="form" exit={{ opacity: 0, y: -20 }} transition={{ duration: 0.4, ease }}>
            <section className="container-x pt-10 md:pt-16">
              <p className="font-display text-[18px] font-extrabold tracking-[0.08em] text-white/55 uppercase md:text-[20px]">
                Сезон {seasonYear()} · 2 минуты · без резюме
              </p>
              <h1 className="mt-4 font-display text-[clamp(84px,12vw,200px)] leading-[0.8] font-black uppercase">Заявка</h1>
              {/* На телефоне колонка с пояснением стоит после формы — что обязательно, говорим сразу под заголовком */}
              <p className="mt-6 max-w-xl text-[17px] leading-relaxed text-white/75 lg:hidden">
                {nb('Обязательно: ФИО, дата рождения, телефон или Telegram, учёба и когда можно выйти. Остальное по желанию.')}
              </p>
              {withdrawn && !lastSent && (
                <p role="status" className="mt-6 max-w-xl border-l-[3px] border-brand pl-4 text-[17px] leading-relaxed text-white">
                  {nb(withdrawn)}
                </p>
              )}
              {lastSent && (
                <p className="mt-6 max-w-xl text-[15px] leading-relaxed text-white/70">
                  {nb(`Заявка ${applicationNumber(lastSent.id)} уже у HR. Эта будет ещё одной, например на другую вакансию.`)}
                </p>
              )}
            </section>

            <div className="container-x grid gap-14 pt-8 pb-20 md:pt-16 md:pb-28 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-20">
              <aside className="order-2 flex flex-col gap-10 lg:order-1 lg:sticky lg:top-24 lg:self-start">
                <p className="hidden max-w-md text-lg leading-relaxed text-white/80 lg:block">
                  {nb('Нужны ФИО, дата рождения, телефон или Telegram, учёба и когда можно выйти. Остальное по желанию.')}
                </p>

                {/* Что из заданий на главной уйдёт в заявку — только когда что-то пройдено. Ссылок прочь из формы здесь нет */}
                {(shift > 0 || sentGame.length > 0 || profile.conveyorBest > 0) && (
                  <div className="bg-coal p-6">
                    <p className="font-display text-[18px] font-extrabold tracking-[0.06em] text-white/60 uppercase">В заявку уйдёт</p>
                    <div className="mt-3 flex items-center gap-3">
                      <span className="flex gap-1" aria-hidden="true">
                        {activityList.map((a) => (
                          <ShiftBottle key={a.id} full={!!done[a.id]} className="h-7 w-auto" />
                        ))}
                      </span>
                      <span className="font-display text-[24px] leading-none font-black uppercase">
                        {closed ? 'Смена закрыта' : `Заданий ${shift} из ${activityList.length}`}
                      </span>
                    </div>
                    <ul className="mt-4 flex flex-col gap-2 text-[15px] leading-snug text-white/80">
                      {sentGame.map((line) => (
                        <li key={line} className="grid grid-cols-[1.25rem_1fr]">
                          <span aria-hidden="true" className="mt-[0.7em] block h-[2px] w-2.5 bg-white/40" />
                          {nb(line)}
                        </li>
                      ))}
                    </ul>
                    {/* Счёт «Поймай брак» уходит в заявку, только пока переключатель включён */}
                    {profile.conveyorBest > 0 && (
                      <div className="mt-5 border-t border-white/15 pt-4">
                        <Checkbox id="apply-attach-score" checked={profile.attachScore} onChange={(v) => profile.setAttachScore(v)}>
                          <span className="text-white">Показать результат игры</span>
                          <span className="block text-[14px] text-white/60">{nb(`«Поймай брак»: рекорд ${profile.conveyorBest}, HR увидит его в заявке`)}</span>
                        </Checkbox>
                      </div>
                    )}
                  </div>
                )}

                <NextSteps telegram={telegram} />

                <div className="flex flex-col gap-2 text-[17px]">
                  <a
                    href={`https://wa.me/${contacts.whatsapp}`}
                    target="_blank"
                    rel="noreferrer"
                    className="w-fit underline decoration-white/30 underline-offset-4 hover:decoration-white"
                  >
                    Написать в WhatsApp
                  </a>
                  <a href={`mailto:${contacts.email}`} className="w-fit text-white/70 hover:text-white">
                    {contacts.email}
                  </a>
                  <a href={`tel:${contacts.phone.replace(/[^+\d]/g, '')}`} className="w-fit text-white/70 hover:text-white">
                    {contacts.phone} <span className="text-white/60">{contacts.phoneNote}</span>
                  </a>
                </div>
              </aside>

              <form ref={formRef} onSubmit={onSubmit} noValidate className="order-1 flex flex-col gap-10 lg:order-2">
                {pickFrom && (
                  <fieldset aria-describedby={errors.pick ? 'apply-pick-error' : 'apply-pick-hint'} className="border-t-[3px] border-white pt-5">
                    <legend className="sr-only">Какую вакансию взять в заявку</legend>
                    <p className="font-display text-[clamp(26px,2.4vw,34px)] leading-none font-extrabold uppercase" aria-hidden="true">
                      Какую вакансию взять в заявку
                    </p>
                    <p id="apply-pick-hint" className="mt-2 text-[15px] leading-snug text-white/70">
                      {nb('Подбор работы и «Собери лето» предложили разные вакансии. Выбери одну, с неё HR начнёт разговор.')}
                    </p>
                    <div className="mt-4 grid gap-2 sm:grid-cols-2">
                      {pickFrom.map((v, i) => {
                        const on = form.vacancyId === v.id
                        return (
                          <label
                            key={v.id}
                            className={`flex cursor-pointer flex-col gap-1.5 px-4 py-4 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-white ${
                              on ? 'bg-white text-ink' : `ring-1 ring-inset hover:ring-white ${errors.pick ? 'ring-brand-bright' : 'ring-white/30'}`
                            }`}
                          >
                            <input
                              id={i === 0 ? 'apply-pick' : undefined}
                              type="radio"
                              name="apply-pick"
                              value={v.id}
                              checked={on}
                              aria-required="true"
                              onChange={() => {
                                pickVacancy(v.id)
                                profile.setChosenVacancy(v.id)
                                setErrors((e) => ({ ...e, pick: undefined }))
                              }}
                              className="sr-only"
                            />
                            <span className={`text-[13px] ${on ? 'text-mute' : 'text-white/60'}`}>{i === 0 ? 'Подбор работы' : '«Собери лето»'}</span>
                            <span className="font-display text-[24px] leading-[0.95] font-extrabold uppercase">{v.title}</span>
                            <span className={`font-display text-[22px] leading-none font-black ${on ? 'text-brand' : 'text-brand-bright'}`}>
                              {payLabel(v)}
                              {v.pay?.estimate && (
                                <span className={`ml-2 align-middle font-sans text-[13px] font-normal ${on ? 'text-mute' : 'text-white/60'}`}>ориентир</span>
                              )}
                            </span>
                          </label>
                        )
                      })}
                    </div>
                    {errors.pick && (
                      <p id="apply-pick-error" className="mt-2 text-[15px] font-medium text-brand-bright">
                        {errors.pick}
                      </p>
                    )}
                  </fieldset>
                )}

                {chosen && !pickFrom && (
                  <div className="border-t-[3px] border-b border-white border-b-white/25 py-5">
                    <p className="font-display text-[18px] font-extrabold tracking-[0.06em] text-white/55 uppercase">
                      Отклик · {chosen.format.toLowerCase()}
                    </p>
                    <p className="mt-2 font-display text-[clamp(30px,3vw,44px)] leading-[0.95] font-extrabold uppercase">{chosen.title}</p>
                    <p className="mt-2 font-display text-[28px] leading-none font-black text-brand-bright">
                      {payLabel(chosen)}
                      {chosen.pay && <span className="ml-3 align-middle font-sans text-[13px] font-normal text-white/60">в месяц до вычета налога</span>}
                    </p>
                  </div>
                )}

                {/* ФИО и дата рождения: так их называют в отделе кадров — фамилия первой */}
                <fieldset className="grid gap-9 md:grid-cols-2 md:gap-x-10">
                  <legend className="sr-only">О тебе</legend>
                  <Field id="apply-last-name" label="Фамилия" required error={errors.lastName}>
                    <TextInput
                      id="apply-last-name"
                      aria-required="true"
                      autoComplete="family-name"
                      enterKeyHint="next"
                      maxLength={80}
                      value={form.lastName}
                      onChange={(e) => set('lastName', e.target.value)}
                      onBlur={() => checkOnBlur('lastName')}
                      error={errors.lastName}
                    />
                  </Field>
                  <Field id="apply-name" label="Имя" required error={errors.name}>
                    <TextInput
                      id="apply-name"
                      aria-required="true"
                      autoComplete="given-name"
                      enterKeyHint="next"
                      maxLength={120}
                      value={form.name}
                      onChange={(e) => set('name', e.target.value)}
                      onBlur={() => checkOnBlur('name')}
                      error={errors.name}
                    />
                  </Field>
                  <Field id="apply-middle-name" label="Отчество">
                    <TextInput
                      id="apply-middle-name"
                      autoComplete="additional-name"
                      enterKeyHint="next"
                      maxLength={80}
                      value={form.middleName}
                      onChange={(e) => set('middleName', e.target.value)}
                      placeholder="Если есть"
                    />
                  </Field>
                  <div>
                    <Field id="apply-birth-date" label="Дата рождения" required error={errors.birthDate} hint="Берём с 18 лет">
                      <TextInput
                        id="apply-birth-date"
                        aria-required="true"
                        // Цифровая клавиатура: точки маска ставит сама
                        inputMode="numeric"
                        autoComplete="bday"
                        enterKeyHint="next"
                        maxLength={10}
                        aria-describedby="apply-birth-date-hint"
                        value={form.birthDate}
                        onChange={(e) => set('birthDate', typeBirthDate(e.target.value))}
                        onBlur={() => checkOnBlur('birthDate')}
                        error={errors.birthDate}
                        placeholder="ДД.ММ.ГГГГ"
                        className="tabular-nums"
                      />
                    </Field>
                    {underage && (
                      <Link to="/#game" className="mt-2 inline-flex min-h-11 items-center text-[15px] text-white underline decoration-white/35 underline-offset-4 hover:decoration-white">
                        Задания на главной можно пройти без заявки
                      </Link>
                    )}
                  </div>
                  {/* Телефон или Telegram: переключатель меняет клавиатуру — цифры для номера, буквы для ника. Поле и контракт API те же */}
                  <Field id="apply-reach" label="Телефон или Telegram" required error={errors.reach} className="md:col-span-2">
                    <div className="mt-3 w-fit">
                      <Segmented
                        id="apply-reach-mode"
                        label="Как с тобой связаться"
                        hideLabel
                        compact
                        required
                        options={reachModes}
                        value={reachMode}
                        onChange={(m) => m && switchReach(m)}
                      />
                    </div>
                    <div className="relative">
                      {reachMode === 'telegram' && (
                        <span aria-hidden="true" className="pointer-events-none absolute top-1/2 left-0 -translate-y-1/2 text-[19px] text-white/60">
                          @
                        </span>
                      )}
                      <TextInput
                        id="apply-reach"
                        aria-required="true"
                        ref={reachRef}
                        {...(reachMode === 'phone'
                          ? { type: 'tel', inputMode: 'tel' as const, autoComplete: 'tel', placeholder: '+7 900 000-00-00' }
                          : { type: 'text', inputMode: 'text' as const, autoComplete: 'off', placeholder: 'username', className: 'pl-5' })}
                        autoCapitalize="off"
                        spellCheck={false}
                        enterKeyHint="next"
                        // В режиме Telegram «@» стоит перед полем — в самом поле ник без него
                        value={reachMode === 'telegram' ? form.reach.replace(/^@/, '') : form.reach}
                        onChange={(e) => set('reach', e.target.value)}
                        onBlur={() => checkOnBlur('reach')}
                        error={errors.reach}
                      />
                    </div>
                  </Field>
                </fieldset>

                {/* Учёба: сначала «Учусь / Уже не учусь» — от выбора зависит, обязателен ли вуз. Курс и практика от вуза — по желанию */}
                <fieldset className="grid gap-x-10 gap-y-6 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                  <legend className="sr-only">Учёба</legend>
                  <div className="md:col-span-2">
                    <Segmented
                      id="apply-study"
                      label="Учёба"
                      required
                      options={studyOptions}
                      optionIds={{ studying: 'apply-studying', not: 'apply-not-studying' }}
                      value={form.notStudying ? 'not' : 'studying'}
                      onChange={(v) => {
                        const not = v === 'not'
                        setForm((f) => ({ ...f, notStudying: not, practiceSchool: not ? false : f.practiceSchool }))
                        setErrors((e) => ({ ...e, school: undefined }))
                      }}
                      gridClassName="grid-cols-2 md:max-w-[50%]"
                    />
                  </div>
                  <Field id="apply-school" label="Вуз или колледж" required={!form.notStudying} error={errors.school} hint={form.notStudying ? 'Можно оставить пустым или написать, что окончено' : undefined}>
                    <TextInput
                      id="apply-school"
                      aria-required={!form.notStudying}
                      autoComplete="organization"
                      enterKeyHint="next"
                      maxLength={200}
                      aria-describedby={form.notStudying ? 'apply-school-hint' : undefined}
                      value={form.school}
                      onChange={(e) => set('school', e.target.value)}
                      onBlur={() => checkOnBlur('school')}
                      error={errors.school}
                      placeholder={form.notStudying ? 'Необязательно' : 'Например, МГУПП или колледж № 32'}
                    />
                  </Field>
                  {!form.notStudying && (
                    <Field id="apply-course" label="Курс">
                      <Select id="apply-course" value={form.course} onChange={(e) => set('course', e.target.value)}>
                        <option value="">Не указан</option>
                        {courses.map((c) => (
                          <option key={c}>{c}</option>
                        ))}
                      </Select>
                    </Field>
                  )}
                  {!form.notStudying && (
                    <div className="md:col-span-2">
                      <Checkbox id="apply-practice" checked={form.practiceSchool} onChange={(v) => set('practiceSchool', v)}>
                        {nb('Практика от вуза или колледжа: нужны договор, дневник и характеристика. HR скажет, получится ли')}
                      </Checkbox>
                    </div>
                  )}
                </fieldset>

                {/* Когда может выйти: четыре варианта; «С определённого месяца» открывает выбор месяца */}
                <div className="flex flex-col gap-6">
                  <Segmented
                    id="apply-start-ready"
                    label="Когда сможешь выйти на работу"
                    required
                    error={errors.startReady}
                    options={startReadyOptions}
                    value={form.startReady}
                    onChange={(v) => {
                      setForm((f) => ({ ...f, startReady: v, startMonth: v === 'month' ? f.startMonth : null }))
                      setErrors((e) => ({ ...e, startReady: undefined, startMonth: undefined }))
                    }}
                    gridClassName="grid-cols-2 md:grid-cols-4"
                  />
                  {form.startReady === 'month' && (
                    <Field id="apply-start-month" label="С какого месяца" required error={errors.startMonth} className="md:max-w-[50%]">
                      <Select
                        id="apply-start-month"
                        aria-required="true"
                        error={errors.startMonth}
                        value={form.startMonth ?? ''}
                        onChange={(e) => set('startMonth', e.target.value ? Number(e.target.value) : null)}
                      >
                        <option value="">Выбери месяц</option>
                        {startMonthOptions.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  )}
                </div>

                {/* Вакансия — по желанию: без неё HR подберёт сам. Группы — как на странице вакансий */}
                {!pickFrom && (
                  <Field id="apply-vacancy" label="Вакансия" hint={form.vacancyId ? undefined : 'Можно не выбирать, HR предложит подходящую'}>
                    <Select id="apply-vacancy" aria-describedby={form.vacancyId ? undefined : 'apply-vacancy-hint'} value={form.vacancyId} onChange={(e) => pickVacancy(e.target.value)}>
                      <option value="">Любая подходящая</option>
                      {vacancyGroups.map((g) => (
                        <optgroup key={g.format} label={g.format}>
                          {g.list.map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.title}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </Select>
                  </Field>
                )}

                {prefilled && (
                  <p className="-mt-4 -mb-4 text-[15px] leading-relaxed text-white/65">
                    {nb(`Подставлено ${prefilled}.`)}{' '}
                    {!more && (
                      <button
                        type="button"
                        onClick={() => setMore(true)}
                        className="text-white underline decoration-white/35 underline-offset-4 hover:decoration-white"
                      >
                        Проверить
                      </button>
                    )}
                  </p>
                )}
                {/* Необязательное — одним свёрнутым блоком, чтобы форма оставалась короткой: вопросы для оформления и подробности */}
                <div className="border-y border-white/15">
                  <Disclosure
                    id="apply-more"
                    open={more}
                    onToggle={() => setMore((m) => !m)}
                    title="Необязательно"
                    note="Что ответишь здесь, HR не переспросит по телефону"
                  >
                    <div className="grid gap-9 pt-2 pb-8 md:grid-cols-2 md:gap-x-10">
                      {showPortfolio && (
                        <Field
                          className="md:col-span-2"
                          id="apply-portfolio"
                          label="Ссылка на портфолио"
                          error={errors.portfolio}
                          hint="GitHub, Behance, учебный проект или папка на диске"
                        >
                          <TextInput
                            id="apply-portfolio"
                            type="url"
                            inputMode="url"
                            autoComplete="url"
                            autoCapitalize="off"
                            spellCheck={false}
                            maxLength={300}
                            aria-describedby="apply-portfolio-hint"
                            value={form.portfolio}
                            onChange={(e) => set('portfolio', e.target.value)}
                            onBlur={() => {
                              const v = form.portfolio.trim()
                              if (v && !isPortfolioUrl(v))
                                setErrors((er) => ({
                                  ...er,
                                  portfolio: messages.portfolio,
                                }))
                            }}
                            error={errors.portfolio}
                            placeholder="behance.net/…"
                          />
                        </Field>
                      )}
                      <div className="flex flex-col gap-7 md:col-span-2">
                        <Segmented
                          id="apply-citizenship"
                          label="Гражданство"
                          hint="ЕАЭС: Армения, Беларусь, Казахстан, Киргизия"
                          options={citizenshipOptions}
                          value={form.citizenship}
                          onChange={(v) => set('citizenship', v)}
                        />
                        {showMedBook && (
                          <Segmented
                            id="apply-med-book"
                            label="Медкнижка"
                            hint="Личная медицинская книжка обязательна на пищевом производстве"
                            options={medBookOptions}
                            value={form.medBook}
                            onChange={(v) => set('medBook', v)}
                          />
                        )}
                        {showShifts && (
                          <Segmented
                            id="apply-shifts"
                            label="Какие смены подходят"
                            options={shiftOptions}
                            value={form.shifts}
                            onChange={(v) => set('shifts', v)}
                          />
                        )}
                      </div>
                      <div className="md:col-span-2">
                        <Checkbox id="apply-stay" checked={form.wantsToStay} onChange={(v) => set('wantsToStay', v)}>
                          Хочу остаться после сезона на постоянной работе
                        </Checkbox>
                      </div>
                      {/* Направление и формат нужны, только пока вакансия не выбрана: по ним HR подберёт её сам */}
                      {!form.vacancyId && (
                        <>
                          <Field
                            id="apply-department"
                            label="Направление"
                            hint={profile.quizResult && form.department === profile.quizResult ? 'Подставлено из подбора работы' : undefined}
                          >
                            <Select id="apply-department" value={form.department} onChange={(e) => set('department', e.target.value as DepartmentId | '')}>
                              <option value="">Пока не знаю</option>
                              {departmentList.map((d) => (
                                <option key={d.id} value={d.id}>
                                  {d.name}
                                </option>
                              ))}
                            </Select>
                          </Field>
                          <Field id="apply-format" label="Формат">
                            <Select id="apply-format" value={form.format} onChange={(e) => set('format', e.target.value as VacancyFormat | '')}>
                              <option value="">Любой</option>
                              {vacancyFormats.map((f) => (
                                <option key={f}>{f}</option>
                              ))}
                            </Select>
                          </Field>
                        </>
                      )}
                      <div className="md:col-span-2">
                        <p className="font-display text-[18px] font-extrabold tracking-[0.06em] text-white/55 uppercase">Месяцы работы</p>
                        <div className="mt-4 grid grid-cols-4 gap-2 sm:grid-cols-7">
                          {seasonMonths.map((m) => (
                            <MonthCell key={m.value} pressed={form.months.includes(m.value)} onClick={() => toggleMonth(m.value)}>
                              {m.label}
                            </MonthCell>
                          ))}
                        </div>
                      </div>
                      <Field id="apply-comment" label="Комментарий" className="md:col-span-2">
                        <TextArea
                          id="apply-comment"
                          rows={3}
                          value={form.comment}
                          onChange={(e) => set('comment', e.target.value)}
                          placeholder="График учёбы, опыт, вопросы к HR"
                        />
                      </Field>
                    </div>
                  </Disclosure>
                </div>

                {/* «Устройтесь вдвоём»: друзья хотят работать вместе — HR видит это в заявке. По ссылке друга отмечено сразу */}
                <div>
                  <Checkbox id="apply-friend-toggle" checked={form.withFriend} onChange={(v) => set('withFriend', v)}>
                    Иду с другом или подругой
                    {invited && <span className="ml-2 text-[14px] whitespace-nowrap text-brand-bright">по приглашению</span>}
                  </Checkbox>
                  <AnimatePresence initial={false}>
                    {form.withFriend && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: still ? 0 : 0.35, ease }}
                        className="overflow-hidden"
                      >
                        <Field
                          id="apply-friend"
                          label="Имя друга"
                          hint={nb('Необязательно. HR увидит, что вы хотите работать вместе. Одну смену на двоих дают по возможности, это обсудят на собеседовании.')}
                          className="pt-5 pl-10"
                        >
                          <TextInput
                            id="apply-friend"
                            aria-describedby="apply-friend-hint"
                            maxLength={80}
                            value={form.friend}
                            onChange={(e) => set('friend', e.target.value)}
                            placeholder="Например, Аня"
                            autoComplete="off"
                          />
                        </Field>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {/* Ловушка для ботов: человек поле не видит и не попадает в него с клавиатуры. Заполненное — заявка с пометкой «похоже на спам» */}
                <div aria-hidden="true" className="pointer-events-none absolute -left-[9999px] h-px w-px overflow-hidden opacity-0">
                  <label htmlFor="apply-website">Сайт</label>
                  <input
                    id="apply-website"
                    name="website"
                    type="text"
                    tabIndex={-1}
                    autoComplete="off"
                    value={form.website}
                    onChange={(e) => set('website', e.target.value)}
                  />
                </div>

                {/* Согласие — отдельная обязательная отметка: без неё заявка не уходит. Возраст проверяется по дате рождения */}
                <div className="flex flex-col gap-5 border-t border-white/15 pt-8">
                  <Checkbox id="apply-consent" required checked={form.consent} onChange={(v) => set('consent', v)} error={errors.consent}>
                    {nb('Даю согласие на обработку персональных данных для рассмотрения заявки и связи по телефону, в мессенджере или по SMS')} (
                    <a href="/consent" target="_blank" rel="noreferrer" className={legalLink}>
                      текст согласия
                    </a>
                    )
                  </Checkbox>
                  {/* Политика — отдельной строкой, вне отметки: согласие даётся отдельно от других документов */}
                  <p className="-mt-1 pl-10 text-[14px] leading-snug text-white/60">
                    {nb('Кто видит заявку и сколько она хранится, написано в ')}
                    <a href="/privacy" target="_blank" rel="noreferrer" className={legalLink}>
                      политике обработки данных
                    </a>
                    .
                  </p>
                </div>

                {formError && (
                  <div role="alert" className="-mb-4 border-l-[5px] border-brand pl-4 text-[17px] text-white">
                    <p>{formError.whatsapp ? withWhatsApp(formError.text) : formError.text}</p>
                    {offline && (
                      <p className="mt-2 text-white/70">
                        Если не выходит, напиши в{' '}
                        <a
                          className="underline underline-offset-4 hover:text-white"
                          href={`https://wa.me/${contacts.whatsapp}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          WhatsApp
                        </a>{' '}
                        или на{' '}
                        <a className="underline underline-offset-4 hover:text-white" href={`mailto:${contacts.email}`}>
                          {contacts.email}
                        </a>
                        .
                      </p>
                    )}
                  </div>
                )}

                <button type="submit" disabled={sending} className={`${btn.red} w-full disabled:opacity-60 sm:w-fit`}>
                  {sending ? 'Отправляем' : offline ? 'Отправить ещё раз' : 'Отправить заявку'}
                  <Dash />
                </button>

                {/* Срок ответа — один раз, у кнопки */}
                <p className="-mt-4 text-[15px] text-white/60">{nb(promiseLine(telegram))}</p>
              </form>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

type SuccessProps = {
  app: SentApplication
  closed: boolean
  onAnother: () => void
  /** Заявку удалили по просьбе кандидата (или её уже нет): копию в браузере стираем, показываем форму */
  onWithdrawn: (result: 'withdrawn' | 'gone', number: string) => void
  focus: boolean
}

function Success({ app, closed, onAnother, onWithdrawn, focus }: SuccessProps) {
  const number = applicationNumber(app.id)
  const heading = useRef<HTMLHeadingElement>(null)
  // Только что отправили — фокус на заголовок «Заявка отправлена»: скринридер прочитает его, Tab пойдёт дальше по экрану
  useEffect(() => {
    if (focus) heading.current?.focus({ preventScroll: true })
    // только при появлении экрана
  }, [])
  const telegram = !app.phone && !!app.contact
  // Друг из заявки: имя или «имя не указано» (отметка «Иду с другом» без имени)
  const withFriend = Boolean(app.friend.trim())
  const friend = friendName(app.friend)
  const [shared, setShared] = useState<string | null>(null)
  // Живой статус от отдела персонала. Нет ключа или сети — остаётся обещание и контакты
  const { status, reload } = useCandidateStatus(app)
  const vacancyTitle = status?.vacancyTitle ?? vacancyById(app.vacancyId)?.title
  const closedApp = status?.stage === 'closed'
  // Документы по практике нужны и без отметки «Практика от вуза»: заявка на оплачиваемую или бесплатную практику — тоже практика
  const appVacancy = vacancyById(app.vacancyId) ?? vacancies.find((v) => v.title === vacancyTitle)
  const practice = Boolean(app.practice) || Boolean(appVacancy && isPractice(appVacancy))

  // Ссылка с личным кодом этого браузера (?src=ref_<код>): заявку друга HR свяжет с этой
  const invite = async () => {
    const url = inviteUrl('/')
    const offer = inviteOffer()
    const text = withFriend ? `Моя заявка уже у HR, и в ней есть ты. Оставь свою, тогда нас смогут позвать вместе. ${offer}` : offer
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Практика в «Очаково»', text, url })
        return
      }
      await navigator.clipboard.writeText(`${text} ${url}`)
      setShared(withFriend ? 'Ссылка скопирована, отправь её другу из заявки.' : 'Ссылка скопирована, отправь её другу.')
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setShared(`Скопируй ссылку: ${url}`)
    }
  }

  return (
    <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, ease }}>
      <section className="container-x pt-10 md:pt-16">
        <p className="font-display text-[18px] font-extrabold tracking-[0.08em] text-white/60 uppercase md:text-[20px]">
          Номер заявки · <span className="text-white">{number}</span>
          {/* Вакансия — своей строкой: длинное название не рвётся посередине после номера */}
          {vacancyTitle && <span className="block">{vacancyTitle}</span>}
        </p>
        {/* Сразу после отправки — «Заявка отправлена»; при следующих заходах это страница «Моя заявка» со статусом */}
        <h1 ref={heading} tabIndex={-1} className="mt-4 font-display text-[clamp(72px,12vw,200px)] leading-[0.8] font-black uppercase outline-none">
          {focus || !status ? 'Заявка' : 'Моя'}
          <span className="block text-brand">{focus || !status ? 'отправлена' : 'заявка'}</span>
        </h1>
      </section>

      {/*
        Порядок на телефоне: статус → путь до первой смены → действия. На компьютере шаги справа во всю высоту,
        действия — под статусом: первая строка сетки по статусу, остальное место — действиям
      */}
      <div className="container-x grid gap-14 pt-12 pb-16 md:pt-16 md:pb-20 lg:grid-cols-[minmax(0,6fr)_minmax(0,6fr)] lg:grid-rows-[auto_1fr] lg:gap-x-20 lg:gap-y-12">
        <div className="lg:col-start-1 lg:row-start-1">
          {status ? (
            <StatusBlock status={status} number={number} />
          ) : (
            <p className="max-w-lg text-lg leading-relaxed text-white/80">
              {nb(`${app.name ? `${app.name}, ` : ''}${promiseLine(telegram)} Номер заявки пригодится, если придётся писать в отдел персонала.`)}
            </p>
          )}
          {/* HR предложил выбрать время — часы кнопками; без предложения блока нет */}
          {status && !closedApp && <Booking app={app} onChange={reload} />}
          {/* Новичку — «Как дела на смене»: вопрос после первой смены, через неделю и через месяц */}
          {status && (status.stage === 'offer' || status.stage === 'started') && <Checkin app={app} />}
          {/* Ответы HR в мессенджере — сразу под первым абзацем: на телефоне видно без прокрутки */}
          {!closedApp && <BotLinks app={app} />}
          {/* Это сообщение, не кнопка: без заливки, бутылки и линейка слева */}
          {closed && (
            <p className="mt-6 flex w-fit items-center gap-4 border-l-[3px] border-white/40 pl-4 font-display text-[22px] leading-none font-extrabold tracking-[0.04em] uppercase">
              <span className="flex gap-[3px]" aria-hidden="true">
                {activityList.map((a) => (
                  <ShiftBottle key={a.id} full className="h-6 w-auto" />
                ))}
              </span>
              Смена закрыта · отметка в заявке
            </p>
          )}
        </div>

        <div className="lg:col-start-2 lg:row-span-2 lg:row-start-1">{status ? <StatusSteps status={status} /> : <NextSteps telegram={telegram} />}</div>

        <div className="lg:col-start-1 lg:row-start-2">
          {/* Заявка закрыта — звать друга в этот момент странно */}
          {!closedApp && (
            <div className="border-t-[3px] border-white pt-6">
              <p className="font-display text-[28px] leading-none font-extrabold uppercase">Позвать друга</p>
              <p className="mt-2 max-w-md text-[15px] leading-relaxed text-white/70">
                {withFriend
                  ? nb(`${friend ? `${friend}: ` : ''}HR увидит, что вы хотите работать вместе. Заявка нужна от каждого. Отправь ссылку, заполнить заявку можно за 2 минуты.`)
                  : nb('Отправь ссылку тому, с кем хочешь работать вместе. HR увидит, что заявка пришла по приглашению.')}
              </p>
              <div className="mt-6 flex flex-col gap-3 sm:flex-row">
                <button type="button" onClick={invite} className={btn.red}>
                  Позвать друга
                  <Dash />
                </button>
                <Link to="/vacancies" className={btn.ghost}>
                  Вакансии
                  <Dash />
                </Link>
              </div>
              {shared && (
                <p role="status" className="mt-4 text-[15px] break-all text-white/75">
                  {shared}
                </p>
              )}
            </div>
          )}
          <div className={`flex flex-col items-start gap-2 ${closedApp ? '' : 'mt-8'}`}>
            <button
              type="button"
              onClick={onAnother}
              className="inline-flex min-h-11 items-center text-[15px] text-white/70 underline decoration-white/35 underline-offset-4 hover:text-white hover:decoration-white"
            >
              Отправить ещё одну заявку
            </button>
            <SaveLink app={app} number={number} />
          </div>
        </div>
      </div>
      {/* Куда ехать и что взять: дорога по станциям, документы по практике, общежитие. Закрытой заявке не нужно */}
      {!closedApp && (
        <div className="container-x pb-14 md:pb-20">
          <VisitInfo practice={practice} />
        </div>
      )}
      {/* Отзыв согласия — редкое и необратимое действие: внизу страницы, мелким текстом, с подтверждением */}
      {app.token && (
        <div className="container-x pb-20 md:pb-28">
          <div className="border-t border-white/15 pt-3">
            <Withdraw app={app} number={number} onDone={(result) => onWithdrawn(result, number)} />
          </div>
        </div>
      )}
    </motion.div>
  )
}

/**
 * «Сохранить ссылку на заявку»: /apply#app=<номер>.<ключ> открывает статус на другом устройстве.
 * На телефоне — меню «Поделиться», иначе — копирование. Ключ — тот же, что у этого браузера
 */
function SaveLink({ app, number }: { app: SentApplication; number: string }) {
  const [note, setNote] = useState<string | null>(null)
  if (!app.token) return null
  const url = `${window.location.origin}/apply#app=${app.id}.${app.token}`
  const save = async () => {
    try {
      if (navigator.share) {
        await navigator.share({ title: `Заявка ${number}`, url })
        return
      }
      await navigator.clipboard.writeText(url)
      setNote('Ссылка скопирована.')
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setNote(`Скопируй ссылку: ${url}`)
    }
  }
  return (
    <div>
      <button
        type="button"
        onClick={() => void save()}
        className="inline-flex min-h-11 items-center text-[15px] text-white/70 underline decoration-white/35 underline-offset-4 hover:text-white hover:decoration-white"
      >
        Сохранить ссылку на заявку
      </button>
      <p className="text-[13px] leading-snug text-white/50">{nb('По ссылке открывается статус заявки, не публикуй её.')}</p>
      {note && (
        <p role="status" className="mt-1 text-[14px] break-all text-white/75">
          {note}
        </p>
      )}
    </div>
  )
}

/** «…или напиши в WhatsApp» — слово WhatsApp становится ссылкой на отдел персонала */
function withWhatsApp(text: string) {
  const [before, after] = text.split('WhatsApp')
  if (after === undefined) return text
  return (
    <>
      {before}
      <a className="underline underline-offset-4 hover:text-white" href={`https://wa.me/${contacts.whatsapp}`} target="_blank" rel="noreferrer">
        WhatsApp
      </a>
      {after}
    </>
  )
}
