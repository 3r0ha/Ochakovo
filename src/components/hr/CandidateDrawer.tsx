import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  citizenshipOptions,
  consentSourceLabel,
  erasedLabel,
  declineReasonLabel,
  declineReasons,
  medBookOptions,
  missingProfile,
  practiceDocOptions,
  seasonLeaveReasons,
  seasonOutcomes,
  shiftOptions,
  startMonthOptions,
  startReadyOptions,
  statusLabel,
  UNDO_WINDOW_MS,
  type ApplicationStatus,
  type DeclineReason,
  type HistoryEntry,
  type HrApplication,
  type PracticeDoc,
  type SeasonLeaveReason,
  type ShiftKind,
  type StartReady,
  type TemplateKey,
} from '@shared/applications'
import {
  checkinAnchor,
  checkinAnswerLabel,
  checkinAnswers,
  checkinReasonLabel,
  checkinReasons,
  checkinSteps,
  checkinTime,
  hardSignal,
  type CheckinAnswer,
  type CheckinReason,
  type CheckinStep,
} from '@shared/adaptation'
import { COMPANY_QUIZ_REWARD, companyQuizPassed } from '@shared/content/companyQuiz'
import { formatBirthDate, maskBirthDate } from '@shared/birthDate'
import { firstShiftOf } from '@shared/candidateStatus'
import { formatOf, inReserve, attendancePending, callbackDue, slaBreached, type CallOutcome } from '@shared/hrFilter'
import { needsPracticeContract } from '@shared/hrPlan'
import { renderTemplate } from '@shared/notifyText'
import { dayLabel, mskParts, nextWorkTime, workdayAfter } from '@shared/workdays'
import { ShiftBottle } from '../../home/kit'
import {
  eraseApplication,
  getErasePreview,
  type ErasePreview,
  getApplication,
  hrChannels,
  hrSms,
  HrUnauthorized,
  hrWork,
  mergeApplication,
  messageCandidate,
  unmergeApplication,
  undoActions,
  ApiValidationError,
  type ApplicationDetails,
  type HrUser,
  type NotifyPlan,
  type Staff,
} from '../../lib/api'
import { markAttendance } from '../../lib/hr/desk'
import { bookingInfo, withdrawBookingOffer, type BookingOfferInfo } from '../../lib/hr/booking'
import { BookingError, offerBooking, patchApplication, type PipelinePatch } from '../../lib/hr/pipeline'
import { ago, caseFacts, channelName, deptName, formatDate, formatPhone, isReferral, monthsRange, plural, shiftOf, sourceName, vacancyTitle, when } from './hrUtils'
import { planText } from './notifyText'
import { useFocusTrap } from './overlay'
import { draftSlot, initialSlot, rememberSlot, slotBody, SlotForm, slotLoad, SlotLoadNote, slotProblem, type SlotDraft } from './SlotForm'
import { templateText } from './templatesCache'
import { useToast, useToastClearance } from './toasts'
import { AttendanceButtons, chip, copyText, Dash, DisabledHint, HrLabel, HrSelect, HrTextArea, hrBtn, Notice, RuDate, StatusBadge, StatusPill, StatusSelect } from './ui'
import { seasonMonths } from '../../lib/season'

const ease = [0.16, 1, 0.3, 1] as const

export type CardIntent = 'interview' | 'declined' | null

/** Изменение заявки из карточки: true — сохранилось. onInvalid — ошибки полей показать у полей; noUndo — без «Отменить» */
type Patch = (body: PipelinePatch, text: string, opts?: { onInvalid?: (errors: Record<string, string>) => void; noUndo?: boolean }) => Promise<boolean>
/** Что открыто в карточке: приглашение, отказ или отметка неявки */
/** noshift — отказ с готовой причиной «Неявка на первую смену» */
type Mode = CardIntent | 'noshow' | 'noshift'

/** Обзвон: где мы в списке, итоги и переходы. Карточка показывает полосу обзвона и слушает клавиши Д, Н и → */
export type CallControl = {
  position: number
  total: number
  reached: number
  missed: number
  /** Сколько заявок пропущено: их изменили после начала обзвона */
  skipped: number
  /** Заявка, которая сейчас по очереди */
  current: string
  /** historyId — строка истории с итогом звонка: «Отменить» по ней убирает итог из счёта */
  onOutcome: (id: string, outcome: CallOutcome, historyId?: number | null) => void
  onNext: () => void
  onStop: () => void
  /** Вернуться к текущей заявке обзвона */
  onResume: () => void
  /** Итог звонка по заявке в этом обзвоне, если он уже есть */
  outcomeOf: (id: string) => CallOutcome | undefined
  /** Заявку изменили после начала обзвона (статус, недозвоны) — звонить уже не нужно */
  changed: (app: HrApplication) => boolean
  /** Пропустить текущую заявку и открыть следующую */
  onSkip: (id: string, name: string) => void
}

/** Клавиши обзвона по физическим клавишам — работают в любой раскладке: Д (L), Н (Y) и стрелка вправо */
const CALL_KEYS: Record<string, 'reached' | 'missed' | 'next'> = { KeyL: 'reached', KeyY: 'missed', ArrowRight: 'next' }

/** Клавишу не перехватываем, если человек печатает в поле */
const typing = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || Boolean(el.closest('[contenteditable="true"]')))

/** До какого статуса «Дозвонились» и «Не дозвонились» меняют статус. Дальше — только запись в истории */
const callStatuses: ApplicationStatus[] = ['new', 'contacted', 'no_answer']

const fmt = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' })

/** Чат кандидата с ботом: заявка из бота или заявка с сайта, которую кандидат привязал к боту */
const botChat = (a: HrApplication) =>
  a.channel && a.channel !== 'web' && a.channel !== 'hr' && a.channelUserId ? a.channel : a.botChannel && a.botUserId ? a.botChannel : null

/** Сообщение дойдёт через бота: у кандидата есть чат с ботом и этот бот сейчас подключён */
const isBot = (a: HrApplication) => {
  const chat = botChat(a)
  return Boolean(chat && hrChannels.includes(chat))
}

/** Канал, куда уйдёт сообщение: «Бот в Telegram» — и для заявки с сайта, привязанной к боту */
const botName = (a: HrApplication) => channelName(botChat(a) ?? a.channel)

type Props = {
  id: string | null
  intent: CardIntent
  me: HrUser
  staff: Staff[]
  onClose: () => void
  /** Заявка изменилась — обновить строку в списке */
  onChange: (app: HrApplication) => void
  /** Открыть другую заявку — дубль, пригласившего, друга */
  onOpen: (id: string) => void
  /** Все заявки — для загрузки часа собеседований */
  apps: HrApplication[]
  /** Идёт обзвон — полоса с итогами и клавишами */
  call?: CallControl | null
}

/** Карточка кандидата: следующий шаг, собеседование, задачи, анкета, дубли, сообщения и история */
export function CandidateDrawer({ id, intent, me, staff, onClose, onChange, onOpen, apps, call: run = null }: Props) {
  const toast = useToast()
  const [data, setData] = useState<ApplicationDetails | null>(null)
  const [error, setError] = useState('')
  const [mode, setMode] = useState<Mode>(null)
  const [call, setCall] = useState<Extract<NotifyPlan, { notify: 'call' }> | null>(null)
  // HR подтвердил в карточке: «нет 18 по дате рождения» или «согласия нет» — и всё равно продолжает
  const [allowUnderage, setAllowUnderage] = useState(false)
  const [allowNoConsent, setAllowNoConsent] = useState(false)
  // Пока идёт запрос, клавиши обзвона молчат: второе нажатие не уйдёт вдогонку первому
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const panel = useRef<HTMLDivElement>(null)
  const app = data?.application ?? null
  /** Эта карточка — текущая в обзвоне */
  const calling = run && app && app.id === run.current && id === run.current ? run : null
  /** Что сервер ответил на последнее изменение: при «позвони кандидату» карточку в обзвоне не уводим */
  const lastPlan = useRef<NotifyPlan | null>(null)
  /** Строка истории последнего изменения — по ней «Отменить» убирает итог звонка из счёта обзвона */
  const lastHistory = useRef<number | null>(null)

  const load = useCallback(async (target: string) => {
    try {
      const d = await getApplication(target)
      setData(d)
      return d
    } catch (e) {
      setError(e instanceof HrUnauthorized ? 'Сессия закончилась, войди снова.' : 'Не удалось открыть заявку. Обнови страницу.')
      return null
    }
  }, [])

  useEffect(() => {
    if (!id) return
    setData(null)
    setError('')
    setCall(null)
    setMode(intent)
    setAllowUnderage(false)
    setAllowNoConsent(false)
    lastPlan.current = null
    // Новая заявка — клавиши обзвона снова слушаются (их глушили на время пропуска изменённой заявки)
    busyRef.current = false
    void load(id)
  }, [id, intent, load])

  // Фокус — внутрь карточки и по кругу в ней (и к «Отменить» во всплывающих сообщениях). Esc закрывает,
  // фокус возвращается к кнопке, которая открыла карточку
  const open = Boolean(id)
  useFocusTrap(panel, open, onClose, true)
  useEffect(() => {
    if (open) panel.current?.focus()
  }, [open])

  // Телефон: карточку пролистали — шапка сжимается в одну строку (имя, статус, телефон), чтобы не занимать полэкрана
  const body = useRef<HTMLDivElement>(null)
  const [compact, setCompact] = useState(false)
  const onBodyScroll = () => {
    const el = body.current
    if (!el) return
    const phone = window.matchMedia('(max-width: 767px)').matches
    setCompact(phone && el.scrollTop > 48)
  }
  useEffect(() => setCompact(false), [id])
  /** Перейти к разделу карточки: «Итог сезона», «Как дела на смене» */
  const jump = (section: string) => {
    const el = document.getElementById(section)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    const heading = el.querySelector<HTMLElement>('h3')
    if (heading) {
      heading.tabIndex = -1
      heading.focus({ preventScroll: true })
    }
  }

  /** Обёртка запроса: пока он идёт, клавиши обзвона и повторные нажатия не срабатывают */
  const guarded = async <T,>(fn: () => Promise<T>): Promise<T> => {
    busyRef.current = true
    setBusy(true)
    try {
      return await fn()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  /**
   * Любое изменение: сохранить, обновить карточку и список, показать результат с «Отменить».
   * onInvalid — ошибку проверки поля (422 с errors) показать у поля, а не всплывающим сообщением
   */
  const patch: Patch = (body, text, opts = {}) =>
    guarded(async () => {
      if (!app) return false
      // Подтверждения «нет 18» и «согласия нет», отмеченные в карточке, уходят с каждым шагом к выходу на работу
      const confirmed = { ...(allowUnderage ? { allowUnderage: true } : {}), ...(allowNoConsent ? { allowNoConsent: true } : {}) }
      try {
        const r = await patchApplication(app.id, { ...confirmed, ...body })
        lastPlan.current = r.notify
        lastHistory.current = r.historyId
        setData(r)
        onChange(r.application)
        if (r.notify?.notify === 'call') setCall(r.notify)
        toast({ text, detail: planText(r.notify), undo: opts.noUndo ? undefined : r.historyId ? [r.historyId] : undefined })
        return true
      } catch (e) {
        if (e instanceof ApiValidationError && opts.onInvalid && Object.keys(e.errors).length) {
          opts.onInvalid(e.errors)
          return false
        }
        toast({ text: 'Не сохранилось', detail: (e as Error).message || 'Проверь соединение и попробуй ещё раз', tone: 'error' })
        return false
      }
    })

  /**
   * В обзвоне: после звонка без ответа, приглашения, отказа или задачи «перезвонить» — следующая заявка.
   * Если бот не напишет и нужно позвонить кандидату с готовым текстом, карточка остаётся: дальше — «Дальше →»
   */
  const advance = () => {
    if (!calling) return
    if (lastPlan.current?.notify === 'call') return
    calling.onNext()
  }

  // Обзвон дошёл до заявки, которую уже изменили (свежие данные карточки): пропускаем её. Проверка — один раз
  // при открытии, иначе своё же изменение в карточке выглядело бы как чужое
  const checked = useRef<string | null>(null)
  useEffect(() => {
    if (!calling || !app || checked.current === app.id) return
    checked.current = app.id
    if (!calling.changed(app)) return
    // Пока открывается следующая, клавиши Д и Н по этой заявке не срабатывают
    busyRef.current = true
    calling.onSkip(app.id, [app.lastName, app.name].filter(Boolean).join(' '))
  }, [calling, app])

  const setStatus = (status: ApplicationStatus) => {
    if (!app || status === app.status) return
    if (status === 'interview' || status === 'declined') return setMode(status)
    setMode(null)
    void patch({ status }, `Статус: ${statusLabel(status)}`)
  }

  /** Дозвонились: новая и «не отвечает» — в «Связались»; у остальных статус прежний, в истории — запись о звонке */
  const reached = async () => {
    if (!app) return
    const ok = callStatuses.includes(app.status) && app.status !== 'contacted'
      ? await patch({ status: 'contacted' }, 'Дозвонились: статус «Связались»')
      : await patch({ comment: 'Дозвонились' }, 'Дозвонились')
    if (ok && calling) calling.onOutcome(app.id, 'reached', lastHistory.current)
  }

  /** Не дозвонились: до собеседования — недозвон со статусом «Не отвечает», дальше — запись в истории */
  const missed = async () => {
    if (!app) return
    const ok = callStatuses.includes(app.status)
      ? await patch({ missedCall: true }, app.noAnswerCount ? `Недозвон № ${app.noAnswerCount + 1}` : 'Не дозвонились')
      : await patch({ comment: 'Не дозвонились' }, 'Не дозвонились')
    if (ok && calling) {
      calling.onOutcome(app.id, 'missed', lastHistory.current)
      advance()
    }
  }

  // Клавиши обзвона: не в полях, без модификаторов, не поверх другого окна, не во время запроса и не в открытой форме
  /** «Дальше →» и стрелка вправо — следующая заявка всегда, даже если на этой осталось «Позвони кандидату» */
  const next = () => calling?.onNext()
  const keys = useRef({ reached, missed, next })
  keys.current = { reached, missed, next }
  useEffect(() => {
    if (!calling || mode || app?.anonymizedAt) return
    const onKey = (e: KeyboardEvent) => {
      const action = CALL_KEYS[e.code]
      if (!action || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.defaultPrevented) return
      if (typing(e.target) || busyRef.current) return
      if (document.querySelector('[role="dialog"][aria-modal="true"]:not(#hr-card)')) return
      e.preventDefault()
      if (action === 'reached') void keys.current.reached()
      else if (action === 'missed') void keys.current.missed()
      else keys.current.next()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [calling, mode, app?.anonymizedAt])

  const undo = async (h: HistoryEntry) => {
    const { results } = await undoActions([h.id])
    const r = results[0]
    if (!r?.ok) return toast({ text: 'Не получилось отменить', detail: r?.error, tone: 'error' })
    if (r.application) onChange(r.application)
    void load(app!.id)
    toast({ text: 'Отменено' })
  }

  return (
    <AnimatePresence>
      {id && (
        <>
          <motion.div key="shade" className="fixed inset-0 z-50 bg-night/80" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} aria-hidden="true" />
          <motion.div
            key="panel"
            id="hr-card"
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-label={app ? `Заявка: ${app.name}` : 'Заявка'}
            tabIndex={-1}
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ duration: 0.4, ease }}
            className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[720px] flex-col border-l border-white/10 bg-coal text-white outline-none"
          >
            <header className="border-b border-white/10 px-5 pt-4 pb-4 md:px-7">
              {compact && app ? (
                // Телефон, карточку пролистали: шапка в одну строку — имя, статус, телефон
                <div className="-mt-1 -mb-1 flex items-center gap-2.5">
                  <p className="min-w-0 flex-1 truncate font-display text-[20px] leading-none font-black uppercase" title={[app.lastName, app.name].filter(Boolean).join(' ')}>
                    {erasedLabel(app) ?? (app.lastName || app.name)}
                  </p>
                  <StatusBadge status={app.status} className="shrink-0 gap-1.5 text-[12px] text-white/80" />
                  {app.phone && (
                    <a href={`tel:${app.phone.replace(/[^+\d]/g, '')}`} className="shrink-0 text-[13px] tabular-nums underline decoration-white/30 underline-offset-4" aria-label={`Позвонить: ${formatPhone(app.phone)}`}>
                      {formatPhone(app.phone)}
                    </a>
                  )}
                  <CloseButton onClose={onClose} />
                </div>
              ) : (
                <>
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="flex flex-wrap gap-x-2 text-[12px] tracking-[0.12em] text-white/60 uppercase">
                        <span>Заявка {app?.id ?? ''}</span>
                        {app && <span>· {formatDate(app.createdAt)}</span>}
                        {app?.status === 'new' && (
                          <span className={slaBreached(app) ? 'font-semibold text-brand-bright' : ''}>· ждёт {ago(app.createdAt)}</span>
                        )}
                      </p>
                      <h2 className="mt-1.5 font-display break-words text-[clamp(32px,4vw,44px)] leading-[0.9] font-black uppercase">
                        {app ? (erasedLabel(app) ?? [app.lastName, app.name, app.middleName].filter(Boolean).join(' ')) : ''}
                      </h2>
                      {app && !app.anonymizedAt && <CaseLine app={app} />}
                    </div>
                    <CloseButton onClose={onClose} />
                  </div>
                  {app && !app.anonymizedAt && <ContactLine app={app} />}
                  {app && (
                    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                      <StatusSelect value={app.status} onChange={setStatus} label="Статус заявки" disabled={Boolean(app.anonymizedAt)} />
                      <label className="inline-flex items-center gap-2 text-[14px] text-white/60">
                        Ведёт
                        <select
                          disabled={Boolean(app.anonymizedAt)}
                          value={app.assigneeId ?? ''}
                          onChange={(e) => void patch({ assigneeId: e.target.value ? Number(e.target.value) : null }, e.target.value ? 'Ответственный назначен' : 'Ответственный снят')}
                          className="h-8 max-w-[220px] cursor-pointer border-b border-white/25 bg-coal pr-5 text-white focus:border-white"
                        >
                          <option value="">никто</option>
                          {staff.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.id === me.id ? `${s.name} (я)` : s.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      {app.duplicateOf && (
                        <button onClick={() => onOpen(app.duplicateOf!)} className="text-[14px] text-periwinkle underline decoration-periwinkle/40 underline-offset-4 hover:decoration-periwinkle">
                          Дубль заявки {app.duplicateOf}
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}
              {run && app && !app.anonymizedAt && (
                <CallBar run={run} calling={Boolean(calling)} busy={busy} paused={Boolean(mode)} app={app} onReached={() => void reached()} onMissed={() => void missed()} variant="header" />
              )}
            </header>

            <div ref={body} onScroll={onBodyScroll} className="flex-1 overflow-y-auto overscroll-contain px-5 py-5 md:px-7">
              {!app ? (
                error ? <Notice tone="error">{error}</Notice> : <p className="text-white/50">Загружаем заявку</p>
              ) : (
                <div className="flex flex-col gap-8">
                  {app.anonymizedAt ? (
                    <>
                      <Notice>
                        Личные данные {app.anonymizedReason === 'request' ? 'удалены по запросу кандидата' : 'удалены: истёк срок хранения'}. Остались вакансия, месяцы, источник,
                        статусы и даты, по ним считается воронка. Менять заявку нельзя.
                      </Notice>
                      <Info data={data!} onOpen={onOpen} />
                      <History history={data!.history} me={me} onUndo={undo} />
                    </>
                  ) : (
                  <>
                  {call && <CallBox plan={call} app={app} onClose={() => setCall(null)} />}
                  <Guards app={app} allowUnderage={allowUnderage} onAllowUnderage={setAllowUnderage} patch={patch} />
                  <NextActions
                    app={app}
                    mode={mode}
                    setMode={setMode}
                    setStatus={setStatus}
                    calling={Boolean(calling)}
                    onReached={() => void reached()}
                    onMissed={() => void missed()}
                    onJump={jump}
                    onOffer={() =>
                      void guarded(async () => {
                        try {
                          const r = await offerBooking([app.id])
                          const failed = r.failed?.find((f) => f.id === app.id)
                          if (failed) toast({ text: 'Предложение не ушло', detail: failed.error, tone: 'error' })
                          else toast({ text: 'Предложили выбрать время', detail: offerHint(app) })
                          const d = await load(app.id)
                          if (d) onChange(d.application)
                        } catch (e) {
                          toast({ text: 'Предложение не ушло', detail: e instanceof BookingError ? e.message : 'Проверь соединение и попробуй ещё раз', tone: 'error' })
                        }
                      })
                    }
                  />
                  {mode === 'interview' && (
                    <InterviewPanel
                      app={app}
                      apps={apps}
                      allowNoConsent={allowNoConsent}
                      onAllowNoConsent={setAllowNoConsent}
                      onCancel={() => setMode(null)}
                      onSubmit={async (body, text) => {
                        if (!(await patch(body, text))) return
                        setMode(null)
                        // Пригласили в обзвоне — значит, дозвонились, даже если «Дозвонились» не нажимали
                        if (calling && body.status === 'interview' && !calling.outcomeOf(app.id)) calling.onOutcome(app.id, 'reached', lastHistory.current)
                        advance()
                      }}
                    />
                  )}
                  {(mode === 'declined' || mode === 'noshift') && (
                    <DeclinePanel
                      app={app}
                      initialReason={mode === 'noshift' ? 'no_show_shift' : ''}
                      onCancel={() => setMode(null)}
                      onSubmit={async (body) => {
                        if (!(await patch(body, 'Статус: Отказ'))) return
                        setMode(null)
                        advance()
                      }}
                    />
                  )}
                  {mode === 'noshow' && (
                    <NoShowPanel
                      app={app}
                      busy={busy}
                      onCancel={() => setMode(null)}
                      onSubmit={(notify) =>
                        guarded(async () => {
                          try {
                            const r = await markAttendance(app.id, 'no', { notify })
                            setData(r)
                            onChange(r.application)
                            if (r.notify?.notify === 'call') setCall(r.notify)
                            toast({ text: 'Неявка: статус «Отказ»', detail: planText(r.notify) ?? 'Кандидату ничего не отправлено', undo: r.historyId ? [r.historyId] : undefined })
                            setMode(null)
                          } catch (e) {
                            toast({ text: 'Не отметилось', detail: (e as Error).message || 'Проверь соединение и попробуй ещё раз', tone: 'error' })
                          }
                        })
                      }
                    />
                  )}
                  {attendancePending(app) && !mode && (
                    <Attendance
                      busy={busy}
                      onAttended={() =>
                        void guarded(async () => {
                          try {
                            const r = await markAttendance(app.id, 'yes')
                            setData(r)
                            onChange(r.application)
                            toast({ text: 'Явка отмечена', undo: r.historyId ? [r.historyId] : undefined })
                          } catch (e) {
                            toast({ text: 'Не отметилось', detail: (e as Error).message || 'Проверь соединение и попробуй ещё раз', tone: 'error' })
                          }
                        })
                      }
                      onNoShow={() => setMode('noshow')}
                    />
                  )}

                  <Notes app={app} onSave={(notes) => patch({ notes }, 'Заметка сохранена')} />
                  <Callback
                    app={app}
                    patch={async (body, text) => {
                      const ok = await patch(body, text)
                      // Задача «перезвонить» поставлена — в обзвоне это итог звонка: дальше
                      if (ok && body.callbackAt) advance()
                      return ok
                    }}
                  />
                  {(['hired', 'started'].includes(app.status) || app.firstShiftAt || app.mentorName || app.practiceDocs.length > 0) && (
                    <Onboarding app={app} patch={patch} />
                  )}
                  {app.status === 'started' && <Season app={app} patch={patch} />}
                  {checkinAnchor(app) && <Checkins app={app} patch={patch} />}
                  <History history={data!.history} me={me} onUndo={undo} />
                  <Profile app={app} patch={patch} />
                  <Info data={data!} onOpen={onOpen} />
                  <Message
                    app={app}
                    onSend={async (text) => {
                      try {
                        const r = await messageCandidate(app.id, text)
                        if (r.notify.notify === 'call') setCall(r.notify)
                        toast({ text: 'Сообщение', detail: planText(r.notify), undo: r.notify.notify === 'queued' ? [r.historyId] : undefined })
                        void load(app.id)
                        return true
                      } catch {
                        toast({ text: 'Не отправилось', tone: 'error' })
                        return false
                      }
                    }}
                  />
                  <Duplicates
                    data={data!}
                    onOpen={onOpen}
                    onMerge={async (dupId, into) => {
                      try {
                        await mergeApplication(dupId, into)
                        toast({ text: 'Заявки склеены', detail: 'Дубль скрыт из списка и остался в карточке' })
                        const d = await load(into === app.id ? app.id : into)
                        if (d) onChange(d.application)
                        if (into !== app.id) onOpen(into)
                      } catch (e) {
                        toast({ text: 'Не получилось склеить', detail: (e as Error).message, tone: 'error' })
                      }
                    }}
                    onUnmerge={async (dupId) => {
                      await unmergeApplication(dupId).catch(() => {})
                      const d = await load(app.id)
                      if (d) onChange(d.application)
                      toast({ text: 'Заявка снова отдельная' })
                    }}
                  />
                  <Erase
                    app={app}
                    onErased={async () => {
                      const d = await load(app.id)
                      if (d) onChange(d.application)
                    }}
                  />
                  </>
                  )}
                </div>
              )}
            </div>
            {run && app && !app.anonymizedAt && (
              <CallBar run={run} calling={Boolean(calling)} busy={busy} paused={Boolean(mode)} app={app} onReached={() => void reached()} onMissed={() => void missed()} variant="footer" />
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}

/** Поля кейса под именем: возраст и дата рождения, когда может выйти, учёба. Нет 18 — возраст красным */
function CaseLine({ app }: { app: HrApplication }) {
  const f = caseFacts(app)
  const age = f.age ? `${f.age}, ${f.birth}` : 'дата рождения не указана'
  return (
    <p className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[14px] text-white/70">
      <span className={app.adult === false ? 'font-semibold text-brand-bright' : ''}>{app.adult === false ? `${age}, нет 18` : age}</span>
      <span>{f.start || 'выход: не указан'}</span>
      <span className="break-words">{f.study || 'учёба не указана'}</span>
    </p>
  )
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button onClick={onClose} className="-mr-2 grid size-10 shrink-0 place-items-center text-white/60 hover:text-white" aria-label="Закрыть карточку">
      <svg viewBox="0 0 14 14" className="size-4" aria-hidden="true">
        <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.8" />
      </svg>
    </button>
  )
}

/**
 * Под именем — то, с чем звонят: телефон (на телефоне нажать — позвонить) с кнопкой «Скопировать»,
 * вакансия и месяцы, откуда пришёл
 */
function ContactLine({ app }: { app: HrApplication }) {
  const toast = useToast()
  return (
    <div className="mt-3 flex flex-col gap-1.5 text-[14px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {app.phone ? (
          <>
            <a href={`tel:${app.phone.replace(/[^+\d]/g, '')}`} className="text-[18px] font-medium tabular-nums underline decoration-white/30 underline-offset-4 hover:decoration-white">
              {formatPhone(app.phone)}
            </a>
            <button
              type="button"
              onClick={async () => toast((await copyText(formatPhone(app.phone))) ? { text: 'Телефон скопирован', detail: formatPhone(app.phone) } : { text: 'Не скопировалось', detail: 'Выдели номер и скопируй вручную', tone: 'error' })}
              className={hrBtn.text}
              aria-label={`Скопировать телефон ${formatPhone(app.phone)}`}
            >
              Скопировать
            </button>
          </>
        ) : (
          <span className="text-white/70">Телефона нет{app.contact ? '' : ', контакта тоже'}</span>
        )}
        {app.contact && <span className="break-all text-white/75">{app.contact}</span>}
      </div>
      <p className="text-white/75">
        {vacancyTitle(app.vacancyId)} · {monthsRange(app.months)}
      </p>
      <p className="text-white/60">
        Источник: {sourceName(app.source)} · {channelName(app.channel)}
      </p>
    </div>
  )
}

/**
 * Предупреждения перед шагами к выходу на работу: нет 18 по дате рождения и нет согласия на обработку данных
 * (кандидата добавили по рекомендации). Пригласить можно — после подтверждения
 */
function Guards({ app, allowUnderage, onAllowUnderage, patch }: { app: HrApplication; allowUnderage: boolean; onAllowUnderage: (v: boolean) => void; patch: Patch }) {
  const underage = app.adult === false && !['started', 'declined'].includes(app.status)
  const noConsent = app.consentSource === 'none'
  if (!underage && !noConsent) return null
  return (
    <div className="flex flex-col gap-3">
      {underage && (
        <div className="border-l-4 border-brand bg-brand/[0.1] p-4" role="note">
          <p className="text-[15px]">
            {caseFacts(app).age ? `Кандидату ${caseFacts(app).age} по дате рождения` : 'По анкете кандидату нет 18 лет'}, а&nbsp;на&nbsp;работу, стажировку и&nbsp;практику берут с&nbsp;18. Если в&nbsp;дате ошибка, поправь её в&nbsp;анкете ниже.
          </p>
          <label className="mt-2 inline-flex cursor-pointer items-center gap-2.5 text-[15px] text-white/85">
            <input type="checkbox" checked={allowUnderage} onChange={(e) => onAllowUnderage(e.target.checked)} className="size-4 accent-[var(--color-brand)]" />
            Всё равно пригласить и оформить
          </label>
        </div>
      )}
      {noConsent && (
        <div className="border-l-4 border-periwinkle bg-periwinkle/[0.08] p-4" role="note">
          <p className="text-[15px]">
            Согласия на обработку данных нет: номер дали знакомые или сотрудник. При первом звонке скажи, откуда номер, и&nbsp;получи согласие.
          </p>
          <button onClick={() => void patch({ consent: 'hr_verbal' }, 'Согласие получено устно', { noUndo: true })} className={`${hrBtn.smallGhost} mt-3`}>
            Согласие получено устно
          </button>
        </div>
      )}
    </div>
  )
}

/** Как кандидат узнает о предложении выбрать время */
const offerHint = (app: HrApplication) =>
  isBot(app) ? `Кнопки с часами уйдут в ${botName(app).replace('Бот в ', '')}` : canSms(app) ? 'Ссылка уйдёт SMS' : 'Бота и SMS нет: кандидат увидит предложение на странице «Моя заявка» или узнает при звонке'

/** Часы начала смен по «Описанию практики»: дневная с 8:00 до 20:00, ночная с 20:00 до 8:00 */
const shiftStart: Record<ShiftKind, string> = { day: '08:00', night: '20:00' }

/** ISO → «ГГГГ-ММ-ДД» и «ЧЧ:ММ» по Москве для полей ввода */
const mskInput = (iso: string | null) => {
  if (!iso) return { date: '', time: '' }
  const p = mskParts(new Date(iso))
  return { date: p.day, time: `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}` }
}

/**
 * Оформление: первая смена (дата, день или ночь, время) с напоминанием накануне, дата оформления или медкомиссии,
 * заметка, наставник и документы по практике (справочник студента: договор с вузом, приказ, дневник, характеристика)
 */
function Onboarding({ app, patch }: { app: HrApplication; patch: Patch }) {
  const saved = mskInput(app.firstShiftAt)
  const [date, setDate] = useState(saved.date)
  const [kind, setKind] = useState<ShiftKind>(app.shiftKind || 'day')
  const [time, setTime] = useState(saved.time || shiftStart[app.shiftKind || 'day'])
  const savedOnboarding = mskInput(app.onboardingAt)
  const [onboarding, setOnboarding] = useState(savedOnboarding.date ? `${savedOnboarding.date}T${savedOnboarding.time}` : '')
  const [note, setNote] = useState(app.onboardingNote)
  const [mentor, setMentor] = useState(app.mentorName)
  const [showDocs, setShowDocs] = useState(false)
  // Отметки документов — сразу на экране, сервер догоняет; не сохранилось — вернётся как было
  const [docs, setDocs] = useState<PracticeDoc[]>(app.practiceDocs)
  useEffect(() => setDocs(app.practiceDocs), [app.practiceDocs])
  useEffect(() => {
    const s = mskInput(app.firstShiftAt)
    setDate(s.date)
    setKind(app.shiftKind || 'day')
    setTime(s.time || shiftStart[app.shiftKind || 'day'])
  }, [app.firstShiftAt, app.shiftKind])
  useEffect(() => setNote(app.onboardingNote), [app.onboardingNote])
  useEffect(() => setMentor(app.mentorName), [app.mentorName])
  useEffect(() => {
    const s = mskInput(app.onboardingAt)
    setOnboarding(s.date ? `${s.date}T${s.time}` : '')
  }, [app.onboardingAt])

  const firstShift = firstShiftOf(app)
  const nextIso = date && time ? new Date(`${date}T${time}:00+03:00`).toISOString() : null
  const changed = (nextIso ?? null) !== (app.firstShiftAt ? new Date(app.firstShiftAt).toISOString() : null) || (date !== '' && kind !== app.shiftKind)
  const reminder = isBot(app)
    ? `Накануне в 12:00 кандидату придёт напоминание в ${botName(app).replace('Бот в ', '')}`
    : canSms(app)
      ? 'Накануне в 12:00 кандидату придёт напоминание SMS'
      : 'Бот не напишет, поэтому в предыдущий рабочий день тебе придёт задача «Напомнить о первой смене»'
  // Документы — у практики от вуза; у тех, кто уже не учится, — только по кнопке
  const docsVisible = Boolean(app.practiceSchool) || (needsPracticeContract(app) && !app.notStudying) || docs.length > 0 || showDocs
  const toggleDoc = (id: PracticeDoc, on: boolean) => {
    const next = practiceDocOptions.map((o) => o.id).filter((d) => (d === id ? on : docs.includes(d)))
    setDocs(next)
    void patch({ profile: { practiceDocs: next } }, on ? 'Документ отмечен' : 'Отметка снята', { noUndo: true }).then((ok) => !ok && setDocs(app.practiceDocs))
  }
  const field = 'h-9 w-full border-b border-white/25 bg-transparent text-[15px] text-white [color-scheme:dark] focus:border-white'
  return (
    <Section title="Оформление" aside={app.status === 'hired' && firstShift?.at ? <span className="text-[14px] text-sage">первая смена назначена</span> : null}>
      <fieldset className="flex flex-col gap-3">
        <legend className="text-[14px] text-white/80">
          Первая смена
          {firstShift && (
            <span className="text-white/60"> · {firstShift.at ? firstShift.text : app.status === 'started' ? 'дата не отмечена' : `пока ${firstShift.text}`}</span>
          )}
        </legend>
        <div className="grid gap-x-5 gap-y-3 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,0.8fr)]">
          <label className="text-[13px] text-white/60">
            День
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={field} />
            <RuDate value={date} className="mt-1 block" />
          </label>
          <div className="flex items-end gap-2" role="radiogroup" aria-label="Смена">
            {(['day', 'night'] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={kind === k}
                onClick={() => {
                  setKind(k)
                  setTime(shiftStart[k])
                }}
                className={chip(kind === k)}
              >
                {k === 'day' ? 'Дневная' : 'Ночная'}
              </button>
            ))}
          </div>
          <label className="text-[13px] text-white/60">
            Начало
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={field} />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <button
            onClick={() => void patch({ onboarding: { firstShiftAt: nextIso, shiftKind: date ? kind : '' } }, date ? 'Первая смена назначена' : 'Дата первой смены снята', { noUndo: true })}
            disabled={!changed || (Boolean(date) && !time)}
            className={hrBtn.smallGhost}
          >
            {app.firstShiftAt ? 'Сохранить дату' : 'Назначить первую смену'}
          </button>
          {Boolean(date) && !time && <DisabledHint>Укажи время начала смены</DisabledHint>}
          {!date && !app.firstShiftAt && <DisabledHint>Выбери день первой смены</DisabledHint>}
          {app.firstShiftAt && (
            <button onClick={() => void patch({ onboarding: { firstShiftAt: null, shiftKind: '' } }, 'Дата первой смены снята', { noUndo: true })} className="text-[14px] text-white/60 underline-offset-4 hover:text-white hover:underline">
              Снять дату
            </button>
          )}
        </div>
        {app.status === 'hired' && <p className="text-[14px] text-white/60">{reminder}. Если статус или дата поменяются, старое напоминание не уйдёт.</p>}
      </fieldset>

      <div className="grid gap-x-5 gap-y-3 sm:grid-cols-2">
        <label className="text-[13px] text-white/60">
          Оформление или медкомиссия
          <input
            type="datetime-local"
            value={onboarding}
            onChange={(e) => setOnboarding(e.target.value)}
            onBlur={() => {
              const next = onboarding ? new Date(`${onboarding}:00+03:00`).toISOString() : null
              if (next !== (app.onboardingAt ? new Date(app.onboardingAt).toISOString() : null))
                void patch({ onboarding: { onboardingAt: next } }, next ? 'Дата оформления сохранена' : 'Дата оформления снята', { noUndo: true })
            }}
            className={field}
          />
          <RuDate value={onboarding} className="mt-1 block" />
        </label>
        <label className="text-[13px] text-white/60">
          Наставник
          <input
            value={mentor}
            onChange={(e) => setMentor(e.target.value)}
            onBlur={() => mentor.trim() !== app.mentorName && void patch({ profile: { mentorName: mentor.trim() } }, mentor.trim() ? `Наставник: ${mentor.trim()}` : 'Наставник снят', { noUndo: true })}
            placeholder="Имя и фамилия сотрудника"
            autoComplete="off"
            className={`${field} placeholder:text-white/55`}
          />
        </label>
        <label className="text-[13px] text-white/60 sm:col-span-2">
          Заметка об оформлении
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => note.trim() !== app.onboardingNote && void patch({ onboarding: { onboardingNote: note.trim() } }, 'Заметка сохранена', { noUndo: true })}
            placeholder="Например: медкомиссия в 9:00, кабинет 110"
            className={`${field} placeholder:text-white/55`}
          />
        </label>
      </div>
      <p className="text-[13px] text-white/55">Наставник есть у каждого новичка: это опытный сотрудник, который прошёл обучение в Учебном центре.</p>

      {docsVisible ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-[14px] text-white/80">
            Документы по практике: {docs.length} из {practiceDocOptions.length}
          </legend>
          {practiceDocOptions.map((o) => (
            <label key={o.id} className="flex cursor-pointer items-start gap-2.5 text-[15px]">
              <input type="checkbox" checked={docs.includes(o.id)} onChange={(e) => toggleDoc(o.id, e.target.checked)} className="mt-1 size-4 shrink-0 accent-[var(--color-brand)]" />
              <span>
                {o.label}
                <span className="block text-[13px] text-white/55">{o.hint}</span>
              </span>
            </label>
          ))}
          <p className="text-[13px] text-white/55">С документами студент приходит в Учебный центр, кабинет 525.</p>
        </fieldset>
      ) : (
        <button onClick={() => setShowDocs(true)} className="w-fit text-[14px] text-white/70 underline underline-offset-4 hover:text-white">
          Отметить документы по практике от вуза
        </button>
      )}
    </Section>
  )
}

/** Итог сезона — только у «На смене». Отметка резерва внутренняя: кандидат её не видит */
function Season({ app, patch }: { app: HrApplication; patch: Patch }) {
  const [reason, setReason] = useState<SeasonLeaveReason | ''>(app.seasonLeaveReason)
  useEffect(() => setReason(app.seasonLeaveReason), [app.seasonLeaveReason])
  const [leaving, setLeaving] = useState(false)
  const showReason = app.seasonOutcome === 'left' || leaving
  return (
    <Section id="card-season" title="Итог сезона" aside={inReserve(app) ? <span className="text-[14px] text-sage">в резерве</span> : null}>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Итог сезона">
        {seasonOutcomes.map((o) => {
          const on = app.seasonOutcome === o.id || (o.id === 'left' && leaving && !app.seasonOutcome)
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => {
                if (o.id === 'left' && !app.seasonLeaveReason) return setLeaving(true)
                setLeaving(false)
                void patch({ season: { seasonOutcome: o.id } }, o.label, { noUndo: true })
              }}
              className={chip(on)}
            >
              {o.label}
            </button>
          )
        })}
        {(app.seasonOutcome || leaving) && (
          <button
            type="button"
            onClick={() => {
              setLeaving(false)
              if (app.seasonOutcome) void patch({ season: { seasonOutcome: '' } }, 'Итог сезона снят', { noUndo: true })
            }}
            className="h-9 px-1 text-[14px] text-white/60 underline-offset-4 hover:text-white hover:underline"
          >
            Снять
          </button>
        )}
      </div>
      {showReason && (
        <label className="text-[13px] text-white/60">
          Причина ухода до конца сезона
          <select
            value={reason}
            onChange={(e) => {
              const v = e.target.value as SeasonLeaveReason
              setReason(v)
              if (v) {
                setLeaving(false)
                void patch({ season: { seasonOutcome: 'left', seasonLeaveReason: v } }, 'Уход до конца сезона', { noUndo: true })
              }
            }}
            className="h-9 w-full cursor-pointer border-b border-white/25 bg-coal pr-5 text-[15px] text-white focus:border-white sm:w-72"
          >
            <option value="">Выбери причину</option>
            {seasonLeaveReasons.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="inline-flex cursor-pointer items-start gap-2.5 text-[15px]">
        <input
          type="checkbox"
          checked={app.reserve}
          onChange={(e) => void patch({ season: { reserve: e.target.checked } }, e.target.checked ? 'Звать в штат или в резерв' : 'Отметка снята', { noUndo: true })}
          className="mt-1 size-4 shrink-0 accent-[var(--color-brand)]"
        />
        <span>
          Звать в штат или в резерв
          <span className="block text-[13px] text-white/55">
            Видят только сотрудники. Заявка попадёт в вид «Резерв».{app.wantsToStay ? ' В заявке тоже стоит отметка «Хочу остаться после сезона».' : ''}
          </span>
        </span>
      </label>
    </Section>
  )
}

const dayMonth = (at: Date) => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' }).format(at)

/**
 * «Как дела на смене»: вопросы новичку после первой смены, через неделю и через месяц (shared/adaptation.ts).
 * С ботом вопрос уходит сам; без бота HR получает задачу спросить при звонке и отмечает ответ здесь
 */
function Checkins({ app, patch }: { app: HrApplication; patch: Patch }) {
  const [hardFor, setHardFor] = useState<CheckinStep | null>(null)
  const anchor = checkinAnchor(app)!
  const signal = hardSignal(app)
  const now = Date.now()
  const mark = (step: CheckinStep, answer: CheckinAnswer, reason: CheckinReason | '' = '') =>
    void patch({ checkin: { step, answer, reason } }, `Ответ: ${checkinAnswerLabel(answer).toLowerCase()}`, { noUndo: true }).then((ok) => ok && setHardFor(null))
  return (
    <Section
      id="card-checkins"
      title="Как дела на смене"
      aside={signal ? <span className="text-[14px] font-semibold text-brand-bright">тяжело{signal.reason ? `: ${checkinReasonLabel(signal.reason).toLowerCase()}` : ''}</span> : null}
    >
      <p className="text-[13px] leading-snug text-white/60">
        {isBot(app)
          ? `Вопросы уходят в ${botName(app).replace('Бот в ', '')} в 18:00 по Москве. Ответ «Тяжело» ставит задачу перезвонить.`
          : 'Бота у кандидата нет: в эти дни придёт задача спросить при звонке. Ответ отметь здесь. Ещё кандидат может ответить на странице «Моя заявка».'}
      </p>
      <ul className="flex flex-col gap-3">
        {checkinSteps.map((s) => {
          const c = app.checkins.find((x) => x.step === s.id)
          const at = checkinTime(anchor, s.id)
          const state = c?.answer
            ? `${checkinAnswerLabel(c.answer)}${c.reason ? `: ${checkinReasonLabel(c.reason).toLowerCase()}` : ''}${c.answeredVia === 'hr' ? ' (со слов кандидата)' : ''}`
            : c?.askedAt
              ? c.askedVia === 'bot'
                ? 'спросили в боте, ответа нет'
                : 'спросить при звонке'
              : at.getTime() > now
                ? `спросим ${dayMonth(at)}`
                : 'не спрашивали'
          // Отметить со слов кандидата можно, когда время вопроса пришло и сам кандидат ещё не ответил
          const canMark = at.getTime() <= now && (!c?.answer || c.answeredVia === 'hr')
          return (
            <li key={s.id} className="border-t border-white/10 pt-3 first:border-t-0 first:pt-0">
              <p className="flex flex-wrap items-baseline justify-between gap-x-4 text-[15px]">
                <span className="text-white/80">{s.label}</span>
                <span className={c?.answer === 'hard' ? 'font-semibold text-brand-bright' : c?.answer ? 'text-white' : 'text-white/55'}>{state}</span>
              </p>
              {canMark && (
                <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label={`Ответ: ${s.label.toLowerCase()}`}>
                  {checkinAnswers.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      aria-pressed={c?.answer === a.id}
                      onClick={() => (a.id === 'hard' ? setHardFor(s.id) : mark(s.id, a.id))}
                      className={chip(c?.answer === a.id || (a.id === 'hard' && hardFor === s.id))}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              )}
              {hardFor === s.id && (
                <label className="mt-2 block text-[13px] text-white/60">
                  Что тяжелее всего
                  <HrSelect defaultValue="" onChange={(e) => e.target.value && mark(s.id, 'hard', e.target.value as CheckinReason)} className="w-full sm:w-72">
                    <option value="">Выбери причину</option>
                    {checkinReasons.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.label}
                      </option>
                    ))}
                  </HrSelect>
                </label>
              )}
            </li>
          )
        })}
      </ul>
    </Section>
  )
}

function Section({ title, children, aside, id }: { title: string; children: ReactNode; aside?: ReactNode; id?: string }) {
  return (
    <section id={id} className="flex scroll-mt-4 flex-col gap-3">
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="font-display text-[22px] leading-none font-black uppercase">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  )
}

const ghostSmall = hrBtn.smallGhost

/**
 * Следующий шаг по статусу — самые частые действия одной кнопкой; красная — одна, главная.
 * В обзвоне «Дозвонились» и «Не дозвонились» — в полосе обзвона. «На смене» — итог сезона и «Как дела на смене»;
 * «Вернуть в работу» — только у отказа, второстепенной кнопкой
 */
function NextActions({
  app,
  mode,
  setMode,
  setStatus,
  calling,
  onReached,
  onMissed,
  onOffer,
  onJump,
}: {
  app: HrApplication
  mode: Mode
  setMode: (m: Mode) => void
  setStatus: (s: ApplicationStatus) => void
  calling: boolean
  onReached: () => void
  onMissed: () => void
  /** «Предложить выбрать время»: кандидат сам выбирает час собеседования */
  onOffer: () => void
  /** Перейти к разделу карточки по id */
  onJump: (section: string) => void
}) {
  const buttons: ReactNode[] = []
  const add = (key: string, label: string, onClick: () => void, primary = false) =>
    buttons.push(
      <button key={key} onClick={onClick} className={primary ? hrBtn.smallRed : ghostSmall}>
        {label}
      </button>,
    )
  let note: ReactNode = null

  if (['new', 'contacted', 'no_answer'].includes(app.status)) {
    if (!calling) {
      if (app.status !== 'contacted') add('contacted', 'Дозвонились', onReached)
      add('missed', app.noAnswerCount ? `Не дозвонились · ${app.noAnswerCount}` : 'Не дозвонились', onMissed)
    }
    add('interview', 'Пригласить на собеседование', () => setMode('interview'), true)
    add('offer', 'Предложить выбрать время', onOffer)
    add('declined', 'Отказ', () => setMode('declined'))
  } else if (app.status === 'interview') {
    add('hired', 'Берём', () => setStatus('hired'), true)
    add('move', app.interview ? 'Перенести' : 'Назначить время', () => setMode('interview'))
    if (!app.interview) add('offer', 'Предложить выбрать время', onOffer)
    add('declined', 'Отказ', () => setMode('declined'))
  } else if (app.status === 'hired') {
    add('started', 'Первая смена отработана', () => setStatus('started'), true)
    if (app.firstShiftAt && new Date(app.firstShiftAt).getTime() < Date.now()) add('noshift', 'Неявка на смену', () => setMode('noshift'))
    add('declined', 'Отказ', () => setMode('declined'))
  } else if (app.status === 'started') {
    const hard = hardSignal(app)
    const outcome = seasonOutcomes.find((o) => o.id === app.seasonOutcome)
    note = hard ? (
      <p className="text-[15px] font-semibold text-brand-bright">
        В последний раз на «Как дела на смене» ответили «Тяжело»{hard.reason ? ` (${checkinReasonLabel(hard.reason).toLowerCase()})` : ''}. Позвони и поговори, пока человек не ушёл.
      </p>
    ) : (
      <p className="text-[15px] text-white/70">{outcome ? `Итог сезона: ${outcome.label.toLowerCase()}.` : 'Человек на смене. Отвечает на «Как дела на смене», в конце сезона отметь итог.'}</p>
    )
    if (checkinAnchor(app)) add('checkins', 'Как дела на смене', () => onJump('card-checkins'))
    add('season', outcome ? 'Изменить итог сезона' : 'Отметить итог сезона', () => onJump('card-season'))
  } else {
    note = inReserve(app) ? <p className="text-[15px] text-white/70">В резерве: позови снова, когда откроется набор.</p> : null
    add('back', 'Вернуть в работу', () => setStatus('contacted'))
  }

  const info = (app.status === 'interview' && app.interview) || (app.status === 'declined' && app.declineReason)
  if (mode && !info) return null
  return (
    <Section title="Следующий шаг">
      {app.status === 'interview' && app.interview && (
        <p className="text-[15px]">
          <span className="text-periwinkle">Собеседование {when(app.interview.startsAt)}</span>
          <span className="text-white/60"> · {app.interview.address}{app.interview.bring ? ` · взять: ${app.interview.bring}` : ''}</span>
          {app.interview.selfBooked && <span className="text-white/60"> · самозапись: время выбрал кандидат</span>}
          {app.interview.attended === 'yes' && <span className="text-sage"> · явка отмечена</span>}
        </p>
      )}
      {app.status === 'declined' && app.declineReason && <p className="text-[15px] text-white/65">Причина отказа: {declineReasonLabel(app.declineReason)}</p>}
      {note}
      {['new', 'contacted', 'no_answer', 'interview'].includes(app.status) && <OfferLine app={app} />}
      {!mode && <div className="flex flex-wrap gap-2">{buttons}</div>}
    </Section>
  )
}

/** Предложение выбрать время: до какого числа, кто предложил, «ни одно не подходит», «мест нет» — и «Отозвать предложение» */
function OfferLine({ app }: { app: HrApplication }) {
  const toast = useToast()
  const [info, setInfo] = useState<BookingOfferInfo | null>(null)
  const load = () => bookingInfo(app.id).then(setInfo, () => setInfo(null))
  useEffect(() => {
    void load()
    // заново после любой правки заявки: предложение могли сделать или отозвать
  }, [app])
  if (!info || (info.state !== 'open' && info.state !== 'expired')) return null
  const until = info.expiresAt ? formatDate(info.expiresAt) : ''
  const withdraw = async () => {
    try {
      await withdrawBookingOffer(app.id)
      toast({ text: 'Предложение отозвано', detail: 'Кандидат больше не видит выбор времени' })
      await load()
    } catch {
      toast({ text: 'Не получилось отозвать', detail: 'Проверь соединение и попробуй ещё раз', tone: 'error' })
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[15px]">
      <span className={info.state === 'expired' ? 'text-white/60' : 'text-periwinkle'}>
        {info.state === 'expired'
          ? 'Срок выбора времени вышел'
          : `${info.hiringDay ? 'День найма: кандидат выбирает час' : 'Предложено выбрать время'}${until ? ` до ${until}` : ''}${info.createdBy ? ` · ${info.createdBy}` : ''}`}
      </span>
      {info.noneAt && <span className="text-white/80">· кандидату не подошло ни одно время, нужно перезвонить</span>}
      {info.full && info.state === 'open' && <span className="text-white/60">· свободных часов нет</span>}
      {info.state === 'open' && (
        <button type="button" onClick={() => void withdraw()} className="underline decoration-white/35 underline-offset-4 hover:decoration-white">
          Отозвать предложение
        </button>
      )}
    </div>
  )
}

/** Собеседование прошло, итог не отмечен: явка оставляет статус, неявка — отказ с причиной «Неявка на собеседование» */
function Attendance({ busy, onAttended, onNoShow }: { busy: boolean; onAttended: () => void; onNoShow: () => void }) {
  return (
    <Section title="Итог собеседования">
      <p className="text-[15px] text-white/65">Собеседование прошло. Явка оставит статус как есть, неявка поставит отказ с&nbsp;причиной «Неявка на&nbsp;собеседование».</p>
      <AttendanceButtons busy={busy} onYes={onAttended} onNo={onNoShow} label="Итог собеседования" />
    </Section>
  )
}

/** Неявка: отказ с причиной «Неявка на собеседование». Сообщение кандидату — только если HR отметил */
function NoShowPanel({ app, busy, onCancel, onSubmit }: { app: HrApplication; busy: boolean; onCancel: () => void; onSubmit: (notify: boolean) => void }) {
  const [notify, setNotify] = useState(false)
  return (
    <Section title="Неявка">
      <p className="text-[15px] text-white/70">Статус станет «Отказ» с причиной «Неявка на собеседование». Если кандидат позвонит, заявку можно вернуть в работу.</p>
      <label className="inline-flex cursor-pointer items-center gap-2.5 text-[15px] text-white/80">
        <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} className="size-4 accent-[var(--color-brand)]" />
        Написать кандидату об отказе
      </label>
      {notify && <Preview app={app} templateKey="declined" />}
      <div className="flex flex-wrap gap-3">
        <button onClick={() => onSubmit(notify)} disabled={busy} className={hrBtn.red}>
          Отметить неявку
        </button>
        <button onClick={onCancel} className={hrBtn.ghost}>
          Отмена
        </button>
      </div>
    </Section>
  )
}

/**
 * Полоса обзвона в карточке: где мы в списке, итоги, телефон и действия с клавишами.
 * На ноутбуке — в шапке карточки, на телефоне — внизу экрана, чтобы не съедать место
 */
function CallBar({
  run,
  calling,
  busy,
  paused,
  app,
  onReached,
  onMissed,
  variant,
}: {
  run: CallControl
  calling: boolean
  busy: boolean
  paused: boolean
  app: HrApplication
  onReached: () => void
  onMissed: () => void
  variant: 'header' | 'footer'
}) {
  const footer = variant === 'footer'
  // Полоса внизу экрана на телефоне: сообщения с «Отменить» поднимаются над ней и не закрывают телефон
  const root = useRef<HTMLDivElement>(null)
  useToastClearance(root, footer)
  const key = (k: string) => (
    <kbd className="ml-1.5 hidden rounded-sm px-1 font-sans text-[12px] font-semibold tracking-normal normal-case ring-1 ring-current/40 lg:inline-block" aria-hidden="true">
      {k}
    </kbd>
  )
  const phone = app.phone ? (
    <a href={`tel:${app.phone.replace(/[^+\d]/g, '')}`} className="text-[17px] font-medium whitespace-nowrap tabular-nums underline-offset-4 hover:underline">
      {formatPhone(app.phone)}
    </a>
  ) : (
    <span className="text-[15px] text-white/60">Телефона нет{app.contact ? ` · ${app.contact}` : ''}</span>
  )
  return (
    <div
      ref={root}
      className={footer ? 'border-t border-white/15 bg-night px-5 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] lg:hidden' : 'mt-4 hidden border-t border-white/10 pt-3 lg:block'}
      role="region"
      aria-label="Обзвон"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className={`font-display leading-none font-black uppercase ${footer ? 'text-[17px]' : 'text-[20px]'}`}>
          Обзвон · {run.position} из {run.total}
        </p>
        <p className="text-[13px] text-white/60" role="status">
          дозвонились {run.reached}, недозвон {run.missed}
        </p>
      </div>
      {calling ? (
        <>
          <div className="mt-2">{phone}</div>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <button onClick={onReached} disabled={busy || paused} aria-keyshortcuts="Д" className={`${hrBtn.small} text-white ring-2 ring-white ring-inset hover:bg-white/[0.08]`}>
              Дозвонились{key('Д')}
            </button>
            <button onClick={onMissed} disabled={busy || paused} aria-keyshortcuts="Н" className={ghostSmall}>
              Не дозвонились{key('Н')}
            </button>
            <button onClick={run.onNext} disabled={busy} aria-keyshortcuts="ArrowRight" className={ghostSmall}>
              {run.position < run.total ? 'Дальше →' : 'Закончить →'}
            </button>
            <button onClick={run.onStop} className="ml-auto text-[14px] text-white/70 underline-offset-4 hover:text-white hover:underline">
              Закончить обзвон
            </button>
          </div>
        </>
      ) : (
        <button onClick={run.onResume} className="mt-2 text-[14px] text-periwinkle underline underline-offset-4">
          Вернуться к обзвону
        </button>
      )}
    </div>
  )
}

/** Предпросмотр сообщения кандидату */
/** Кандидату без бота приглашение может уйти SMS — если провайдер подключён и номер мобильный */
const canSms = (a: HrApplication) => Boolean(hrSms) && /^(\+?7|8)?9\d{9}$/.test(a.phone.replace(/[^\d+]/g, '').replace(/^\+/, ''))

/** Почему бот не напишет — понятным предложением, с тем, что делать вместо */
export const noBotLabel = (app: HrApplication) => {
  const how = canSms(app) ? 'Позвони или отправь SMS' : 'Позвони кандидату'
  const chat = botChat(app)
  if (chat) return `Бот ${chat === 'max' ? 'MAX' : 'Telegram'} сейчас не подключён. ${how}`
  if (app.channel === 'hr') return `Кандидат добавлен вручную, бота у него нет. ${how}`
  return `Заявка пришла с сайта, бота у кандидата нет. ${how}`
}

function Preview({ app, templateKey, slot }: { app: HrApplication; templateKey: TemplateKey; slot?: ReturnType<typeof draftSlot> }) {
  const [text, setText] = useState<string | null>(null)
  const [smsText, setSmsText] = useState<string | null>(null)
  const [enabled, setEnabled] = useState(true)
  const viaSms = !isBot(app) && templateKey === 'interview' && canSms(app) && Boolean(smsText)
  useEffect(() => {
    let alive = true
    void templateText(templateKey).then((t) => {
      if (!alive || !t) return
      setEnabled(t.enabled)
      setText(t.text)
    })
    if (templateKey === 'interview') void templateText('sms_interview').then((t) => alive && setSmsText(t?.enabled ? t.text : null))
    return () => {
      alive = false
    }
  }, [templateKey])
  if (!text) return null
  return (
    <div className="bg-white/[0.04] p-4 text-[15px] leading-snug text-white/75">
      <p className="mb-2 text-[12px] tracking-[0.1em] text-white/55 uppercase">
        {!enabled
          ? 'Уведомление выключено администратором'
          : isBot(app)
            ? `Так увидит кандидат · ${botName(app)}`
            : viaSms
              ? `Уйдёт SMS через ${hrSms} · ${smsText ? 'короткий текст' : ''}`
              : `${noBotLabel(app)}: текст скопируешь после сохранения`}
      </p>
      {viaSms && smsText ? renderTemplate(smsText, app, slot ?? app.interview) : renderTemplate(text, app, slot ?? app.interview)}
    </div>
  )
}

function InterviewPanel({
  app,
  apps,
  allowNoConsent,
  onAllowNoConsent,
  onCancel,
  onSubmit,
}: {
  app: HrApplication
  apps: HrApplication[]
  allowNoConsent: boolean
  onAllowNoConsent: (v: boolean) => void
  onCancel: () => void
  onSubmit: (b: PipelinePatch, text: string) => void
}) {
  const [draft, setDraft] = useState<SlotDraft>(() => initialSlot(app.interview))
  const [comment, setComment] = useState('')
  // Охрана ищет кандидата в списке на проходную по фамилии: без неё не пропустят. Приглашение не блокируем
  const [lastName, setLastName] = useState('')
  const noLastName = !app.lastName
  const moving = app.status === 'interview'
  const slot = draftSlot(draft)
  const problem = slotProblem(draft)
  // Согласия нет — пригласить можно только с подтверждением: приглашение уйдёт кандидату, который его не давал
  const consentBlock = !moving && app.consentSource === 'none' && !allowNoConsent

  const submit = () => {
    const body = slotBody(draft)
    if (body) rememberSlot(draft)
    const profile = noLastName && lastName.trim() ? { profile: { lastName: lastName.trim() } } : {}
    onSubmit(
      moving
        ? { slot: body ?? undefined, comment, allowOffHours: draft.confirmOff, ...profile }
        : { status: 'interview', ...(body ? { slot: body, allowOffHours: draft.confirmOff } : { withoutSlot: true }), comment, ...profile },
      moving ? 'Собеседование перенесено' : 'Приглашение на собеседование',
    )
  }

  return (
    <Section title={moving ? 'Перенести собеседование' : 'Пригласить на собеседование'}>
      {noLastName && (
        <div className="border-l-4 border-periwinkle bg-periwinkle/[0.08] p-3" role="note">
          <p className="text-[14px]">Нет фамилии у&nbsp;кандидата, без неё охрана не&nbsp;найдёт человека в&nbsp;списке на&nbsp;проходную. Спроси при звонке и&nbsp;впиши. Пригласить можно и&nbsp;без фамилии.</p>
          <label className="mt-2 block text-[13px] text-white/60">
            Фамилия
            <input
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              autoComplete="off"
              className="h-9 w-full border-b border-white/30 bg-transparent text-[15px] text-white focus:border-white"
            />
          </label>
        </div>
      )}
      {!moving && app.consentSource === 'none' && (
        <label className="inline-flex cursor-pointer items-start gap-2.5 border-l-4 border-periwinkle bg-periwinkle/[0.08] p-3 text-[14px]">
          <input type="checkbox" checked={allowNoConsent} onChange={(e) => onAllowNoConsent(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-[var(--color-brand)]" />
          <span>Согласия нет. Пригласить всё равно. При звонке скажу, откуда номер, и получу согласие</span>
        </label>
      )}
      <SlotForm id="card-slot" value={draft} onChange={setDraft} allowWithout={!moving} />
      <SlotLoadNote load={slotLoad(draft, apps, 1, [app.id])} />
      {problem && (
        <p className="text-[14px] text-brand-bright" role="alert">
          {problem}
        </p>
      )}
      <Preview app={app} templateKey={draft.withoutSlot ? 'interview_call' : 'interview'} slot={slot} />
      <div>
        <HrLabel htmlFor="interview-comment">Комментарий для коллег</HrLabel>
        <HrTextArea id="interview-comment" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} className="mt-2" placeholder="Например: договорились по телефону" />
      </div>
      <p className="text-[14px] text-white/60">
        {isBot(app)
          ? 'Накануне кандидату придёт напоминание в бот.'
          : canSms(app)
            ? 'Накануне кандидату придёт напоминание SMS.'
            : 'Бот не напишет, поэтому в предыдущий рабочий день тебе придёт задача «перезвонить», чтобы напомнить о собеседовании.'}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={submit} disabled={Boolean(problem) || consentBlock} className={hrBtn.red}>
          {moving ? 'Перенести' : 'Пригласить'}
        </button>
        <button onClick={onCancel} className={hrBtn.ghost}>
          Отмена
        </button>
        {consentBlock && !problem && <DisabledHint>Сначала отметь выше: пригласить без согласия</DisabledHint>}
      </div>
    </Section>
  )
}

function DeclinePanel({
  app,
  initialReason = '',
  onCancel,
  onSubmit,
}: {
  app: HrApplication
  initialReason?: DeclineReason | ''
  onCancel: () => void
  onSubmit: (b: PipelinePatch) => void
}) {
  const [reason, setReason] = useState<DeclineReason | ''>(initialReason)
  const [comment, setComment] = useState('')
  return (
    <Section title="Отказ">
      <div>
        <HrLabel htmlFor="decline-reason">Причина (видят только сотрудники)</HrLabel>
        <HrSelect id="decline-reason" value={reason} onChange={(e) => setReason(e.target.value as DeclineReason)}>
          <option value="">Выбери причину</option>
          {declineReasons.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </HrSelect>
      </div>
      <Preview app={app} templateKey="declined" />
      <div>
        <HrLabel htmlFor="decline-comment">Комментарий</HrLabel>
        <HrTextArea id="decline-comment" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} className="mt-2" />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={() => reason && onSubmit({ status: 'declined', declineReason: reason, comment })} disabled={!reason} className={hrBtn.red}>
          Отказать
        </button>
        <button onClick={onCancel} className={hrBtn.ghost}>
          Отмена
        </button>
        {!reason && <DisabledHint>Выбери причину отказа</DisabledHint>}
      </div>
    </Section>
  )
}

/** Кандидату с сайта бот не напишет — готовый текст для звонка */
function CallBox({ plan, app, onClose }: { plan: Extract<NotifyPlan, { notify: 'call' }>; app: HrApplication; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="border-l-4 border-periwinkle bg-periwinkle/[0.08] p-4" role="status">
      <p className="font-display text-[22px] leading-none font-black uppercase">Позвони кандидату</p>
      <p className="mt-2 text-[15px] text-white/75">
        Бот не напишет: {plan.detail}.{' '}
        {app.phone ? (
          <>
            Телефон:{' '}
            <a href={`tel:${app.phone.replace(/[^+\d]/g, '')}`} className="whitespace-nowrap text-white underline underline-offset-4">
              {formatPhone(app.phone)}
            </a>
          </>
        ) : (
          `Телефона нет, напиши: ${app.contact || 'контакт не указан'}`
        )}
      </p>
      <p className="mt-3 bg-night/40 p-3 text-[15px] leading-snug">{plan.text}</p>
      <div className="mt-3 flex gap-3">
        <button onClick={async () => setCopied(await copyText(plan.text))} className={hrBtn.smallGhost}>
          {copied ? 'Скопировано' : 'Скопировать текст'}
        </button>
        <button onClick={onClose} className={hrBtn.text}>
          Готово
        </button>
      </div>
    </div>
  )
}

function Callback({ app, patch }: { app: HrApplication; patch: Patch }) {
  const [custom, setCustom] = useState('')
  const [note, setNote] = useState('')
  // Задачи — только в рабочее время: «через 2 часа» в пятницу вечером уедет на утро понедельника
  const soon = nextWorkTime(Date.now() + 2 * 3600e3, hrWork)
  const next = workdayAfter(1, Math.max(10, hrWork.start), Date.now(), hrWork)
  const after = workdayAfter(2, Math.max(10, hrWork.start), Date.now(), hrWork)
  const hm = (d: Date) => d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' })
  const set = (iso: string) => void patch({ callbackAt: iso, callbackNote: note.trim() }, `Перезвонить ${when(iso)}`)
  return (
    <Section title="Перезвонить" aside={app.noAnswerCount ? <span className="text-[14px] text-white/50">недозвонов: {app.noAnswerCount}</span> : null}>
      {app.callbackAt ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className={`text-[15px] ${callbackDue(app) ? 'text-white' : 'text-white/70'}`}>
            {when(app.callbackAt)}
            {app.callbackNote ? ` · ${app.callbackNote}` : ''}
          </p>
          <button onClick={() => void patch({ callbackAt: null }, 'Задача закрыта')} className={ghostSmall}>
            Готово
          </button>
        </div>
      ) : (
        <p className="text-[15px] text-white/55">Задачи нет.</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => set(soon.toISOString())} className={ghostSmall}>
          {soon.getTime() - Date.now() < 3 * 3600e3 ? 'Через 2 часа' : `${dayLabel(soon)}, ${hm(soon)}`}
        </button>
        <button onClick={() => set(next.toISOString())} className={ghostSmall}>
          {`${dayLabel(next)}, ${hm(next)}`}
        </button>
        <button onClick={() => set(after.toISOString())} className={ghostSmall}>
          {`${dayLabel(after)}, ${hm(after)}`}
        </button>
        <input
          type="datetime-local"
          aria-label="Своё время"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          className="h-9 border-b border-white/25 bg-transparent text-[14px] text-white [color-scheme:dark] focus:border-white"
        />
        {custom && <RuDate value={custom} />}
        {custom && (
          <button onClick={() => set(new Date(`${custom}:00+03:00`).toISOString())} className={ghostSmall}>
            Поставить
          </button>
        )}
      </div>
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Зачем звонить (по желанию)"
        aria-label="Зачем звонить"
        className="h-9 border-b border-white/20 bg-transparent text-[14px] text-white placeholder:text-white/55 focus:border-white"
      />
    </Section>
  )
}

/**
 * Анкета: поля кейса (дата рождения, когда может выйти, учёба) и анкета под производство. Кандидат мог не заполнить —
 * HR дополняет со слов. Дата рождения с опечаткой не сохраняется: ошибка — у поля
 */
function Profile({ app, patch }: { app: HrApplication; patch: Patch }) {
  const [lastName, setLastName] = useState(app.lastName ?? '')
  const [middleName, setMiddleName] = useState(app.middleName ?? '')
  const [birth, setBirth] = useState(formatBirthDate(app.birthDate))
  const [birthError, setBirthError] = useState('')
  const [school, setSchool] = useState(app.school ?? '')
  useEffect(() => setLastName(app.lastName ?? ''), [app.lastName])
  useEffect(() => setMiddleName(app.middleName ?? ''), [app.middleName])
  useEffect(() => {
    setBirth(formatBirthDate(app.birthDate))
    setBirthError('')
  }, [app.birthDate])
  useEffect(() => setSchool(app.school ?? ''), [app.school])
  const missing = missingProfile(app)
  const save = (profile: PipelinePatch['profile']) => void patch({ profile }, 'Анкета обновлена')
  const saveBirth = () => {
    const typed = birth.trim()
    if (typed === formatBirthDate(app.birthDate)) return setBirthError('')
    void patch({ profile: { birthDate: typed } }, typed ? 'Дата рождения сохранена' : 'Дата рождения стёрта', { onInvalid: (errors) => setBirthError(errors.birthDate ?? Object.values(errors)[0]) })
  }
  const age = caseFacts(app).age
  const sel = 'h-9 w-full cursor-pointer border-b border-white/25 bg-coal pr-5 text-[15px] text-white focus:border-white'
  const input = 'h-9 w-full border-b border-white/25 bg-transparent text-[15px] text-white focus:border-white'
  return (
    // Анкета свёрнута: в заголовке — чего не хватает. Раскрыть — чтобы дописать со слов кандидата
    <details className="group flex flex-col gap-3 [&[open]>summary]:mb-3">
      <summary className="flex cursor-pointer list-none flex-wrap items-baseline justify-between gap-x-4 gap-y-1 [&::-webkit-details-marker]:hidden">
        <h3 className="inline-flex items-center gap-2 font-display text-[22px] leading-none font-black uppercase">
          Анкета
          <svg viewBox="0 0 10 6" className="h-1.5 w-2.5 transition-transform group-open:rotate-180" aria-hidden="true">
            <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </h3>
        {missing.length ? <span className="text-[14px] text-periwinkle">не хватает: {missing.join(', ')}</span> : <span className="text-[14px] text-sage">заполнена</span>}
      </summary>
      <div className="grid gap-x-5 gap-y-3 sm:grid-cols-2">
        <label className="text-[13px] text-white/60">
          Фамилия
          <input value={lastName} onChange={(e) => setLastName(e.target.value)} onBlur={() => lastName.trim() !== (app.lastName ?? '') && save({ lastName: lastName.trim() })} className={input} />
        </label>
        <label className="text-[13px] text-white/60">
          Отчество, если есть
          <input value={middleName} onChange={(e) => setMiddleName(e.target.value)} onBlur={() => middleName.trim() !== (app.middleName ?? '') && save({ middleName: middleName.trim() })} className={input} />
        </label>
        <div className="text-[13px] text-white/60">
          <label htmlFor="card-birth">Дата рождения</label>
          <div className="flex items-baseline gap-3">
            <input
              id="card-birth"
              value={birth}
              inputMode="numeric"
              autoComplete="off"
              placeholder="ДД.ММ.ГГГГ"
              maxLength={10}
              onChange={(e) => {
                setBirth(maskBirthDate(e.target.value))
                setBirthError('')
              }}
              onBlur={saveBirth}
              onKeyDown={(e) => e.key === 'Enter' && saveBirth()}
              aria-invalid={Boolean(birthError)}
              aria-describedby={birthError ? 'card-birth-error' : undefined}
              className={`${input} tabular-nums placeholder:text-white/55`}
            />
            {age && <span className={`shrink-0 text-[15px] ${app.adult === false ? 'font-semibold text-brand-bright' : 'text-white/80'}`}>{age}</span>}
          </div>
          {birthError && (
            <p id="card-birth-error" className="mt-1 text-[14px] text-brand-bright" role="alert">
              {birthError}
            </p>
          )}
        </div>
        {app.birthDate ? (
          <p className="self-end pb-2 text-[13px] text-white/55">Возраст считается по дате рождения на сегодня, по Москве</p>
        ) : (
          <label className="text-[13px] text-white/60">
            Есть 18 лет (если даты рождения нет)
            <select className={sel} value={app.adult == null ? '' : app.adult ? 'yes' : 'no'} onChange={(e) => save({ adult: e.target.value === '' ? null : e.target.value === 'yes' })}>
              <option value="">не указано</option>
              <option value="yes">да</option>
              <option value="no">нет</option>
            </select>
          </label>
        )}
        <label className="text-[13px] text-white/60">
          Когда может выйти
          <select
            className={sel}
            value={app.startReady ?? ''}
            onChange={(e) => {
              const v = e.target.value as StartReady | ''
              // «С определённого месяца» — сразу с ближайшим месяцем сезона: без месяца сервер его не примет
              save(v === 'month' ? { startReady: v, startMonth: app.startMonth ?? Math.min(...(app.months.length ? app.months : [6])) } : { startReady: v })
            }}
          >
            <option value="">не указано</option>
            {startReadyOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {app.startReady === 'month' ? (
          <label className="text-[13px] text-white/60">
            С какого месяца
            <select className={sel} value={app.startMonth ?? ''} onChange={(e) => save({ startReady: 'month', startMonth: Number(e.target.value) })}>
              {startMonthOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="hidden sm:block" aria-hidden="true" />
        )}
        <label className="text-[13px] text-white/60">
          Вуз или колледж
          <input
            value={school}
            disabled={app.notStudying && !school}
            placeholder={app.notStudying ? 'Уже не учится' : ''}
            onChange={(e) => setSchool(e.target.value)}
            onBlur={() => school.trim() !== (app.school ?? '') && save({ school: school.trim(), ...(school.trim() ? { notStudying: false } : {}) })}
            className={`${input} placeholder:text-white/60 disabled:opacity-60`}
          />
          {app.course && <span className="mt-1 block text-white/50">{app.course}</span>}
        </label>
        <label className="inline-flex cursor-pointer items-center gap-2.5 self-end pb-2 text-[15px] text-white/80">
          <input type="checkbox" checked={Boolean(app.notStudying)} onChange={(e) => save(e.target.checked ? { notStudying: true, school: '' } : { notStudying: false })} className="size-4 accent-[var(--color-brand)]" />
          Уже не учится
        </label>
        <label className="text-[13px] text-white/60">
          Гражданство
          <select className={sel} value={app.citizenship ?? ''} onChange={(e) => save({ citizenship: e.target.value as HrApplication['citizenship'] })}>
            <option value="">не указано</option>
            {citizenshipOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[13px] text-white/60">
          Медкнижка
          <select className={sel} value={app.medBook ?? ''} onChange={(e) => save({ medBook: e.target.value as HrApplication['medBook'] })}>
            <option value="">не указано</option>
            {medBookOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="text-[13px] text-white/60 sm:col-span-2">
          <legend>Месяцы работы (по ним кандидат попадает в план найма)</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {seasonMonths.map((m) => {
              const on = app.months.includes(m.value)
              return (
                <button
                  key={m.value}
                  type="button"
                  aria-pressed={on}
                  onClick={() => save({ months: on ? app.months.filter((x) => x !== m.value) : [...app.months, m.value].sort((a, b) => a - b) })}
                  className={chip(on)}
                >
                  {m.label}
                </button>
              )
            })}
          </div>
        </fieldset>
        <label className="text-[13px] text-white/60 sm:col-span-2">
          Смены
          <select className={sel} value={app.shifts ?? ''} onChange={(e) => save({ shifts: e.target.value as HrApplication['shifts'] })}>
            <option value="">не указано</option>
            {shiftOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </details>
  )
}

/** «Форма на сайте · версия 1 · 12 мая, 14:03»; отмеченное сотрудником — с его именем */
function consentLine(app: HrApplication) {
  if (app.consentSource === 'none' || !app.consentSource) return null
  const parts = [consentSourceLabel(app.consentSource)]
  if (app.consentVersion && app.consentVersion !== '0') parts.push(`версия ${app.consentVersion}`)
  if (app.consentVersion === '0') parts.push('до отдельного согласия: вместе с отметкой «есть 18»')
  if (app.consentBy) parts.push(app.consentBy)
  if (app.consentAt) parts.push(fmt(app.consentAt))
  return parts.join(' · ')
}

function Info({ data, onOpen }: { data: ApplicationDetails; onOpen: (id: string) => void }) {
  const app = data.application
  const shift = shiftOf(app)
  const format = formatOf(app)
  const marks = [app.practiceSchool ? 'Нужна практика от вуза: договор и дневник' : '', app.wantsToStay ? 'Хочет остаться после сезона' : ''].filter(Boolean)
  const consent = consentLine(app)
  return (
    <Section title="Заявка">
      <dl className="grid grid-cols-[minmax(0,130px)_1fr] gap-x-5 gap-y-2.5 text-[15px]">
        <Row label="Телефон">
          {app.phone ? (
            <a className="tabular-nums underline-offset-4 hover:underline" href={`tel:${app.phone.replace(/[^+\d]/g, '')}`}>
              {formatPhone(app.phone)}
            </a>
          ) : (
            <Dash />
          )}
        </Row>
        <Row label="Связь">{app.contact || <Dash />}</Row>
        {app.botChannel && app.botUserId && <Row label="Бот">{`${channelName(app.botChannel)}, привязан с сайта: сообщения о заявке уходят туда`}</Row>}
        <Row label="Вакансия">{vacancyTitle(app.vacancyId)}</Row>
        {format && <Row label="Формат">{format}</Row>}
        <Row label="Направление">{deptName(app.department || null)}</Row>
        <Row label="Месяцы">{monthsRange(app.months)}</Row>
        {marks.length > 0 && (
          <Row label="Отметки">
            <ul>
              {marks.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </Row>
        )}
        <Row label="С другом">{app.friend ? app.friend : <Dash />}</Row>
        {app.portfolio && (
          <Row label="Портфолио">
            <a href={app.portfolio} target="_blank" rel="noopener noreferrer nofollow" className="break-all underline underline-offset-4 hover:text-brand">
              {app.portfolio.replace(/^https?:\/\//, '')}
            </a>
          </Row>
        )}
        <Row label="Источник">
          {sourceName(app.source)} · {channelName(app.channel)}
        </Row>
        <Row label="Согласие">{consent ?? <span className="text-periwinkle">нет, кандидата добавили без согласия</span>}</Row>
        {isReferral(app.source) && data.invitedBy && (
          <Row label="По приглашению">
            {data.invitedBy.applicationId ? (
              <button onClick={() => onOpen(data.invitedBy!.applicationId!)} className="text-left underline underline-offset-4 hover:text-brand">
                {data.invitedBy.name ?? 'Кандидат'}, заявка №&nbsp;{data.invitedBy.applicationId}
              </button>
            ) : data.invitedBy.channel ? (
              `${data.invitedBy.name ?? 'Пользователь'}${data.invitedBy.username ? ` (@${data.invitedBy.username})` : ''} · ${channelName(data.invitedBy.channel)}, без своей заявки`
            ) : (
              `код ${data.invitedBy.code}, пригласившего уже нет в базе`
            )}
          </Row>
        )}
        {data.invited.length > 0 && (
          <Row label="Приглашённые">
            <ul className="flex flex-col gap-1">
              {data.invited.map((f) => (
                <li key={f.id}>
                  <button onClick={() => onOpen(f.id)} className="inline-flex flex-wrap items-center gap-x-2 text-left underline-offset-4 hover:underline">
                    {f.name} <StatusPill status={f.status} />
                  </button>
                </li>
              ))}
            </ul>
          </Row>
        )}
        <Row label="Задания">
          <span className="flex items-center gap-3">
            <span className="flex gap-0.5">
              {[0, 1, 2, 3].map((n) => (
                <ShiftBottle key={n} full={n < shift} className="h-5 w-auto" />
              ))}
            </span>
            {shift} из 4{app.game.quizResult ? ` · подбор: ${deptName(app.game.quizResult)}` : ''}
          </span>
        </Row>
        {app.game.companyQuiz && (
          <Row label="Знание компании">
            Контрольные вопросы: {app.game.companyQuiz.score} из {app.game.companyQuiz.total}
            {companyQuizPassed(app.game.companyQuiz.score, app.game.companyQuiz.total) ? ` · заработан ${COMPANY_QUIZ_REWARD}, выдать в первый день` : ''}
          </Row>
        )}
        {app.comment && <Row label="Комментарий">{app.comment}</Row>}
        <Row label="Пришла">{fmt(app.createdAt)}</Row>
      </dl>
    </Section>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-white/55">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  )
}

function Duplicates({
  data,
  onOpen,
  onMerge,
  onUnmerge,
}: {
  data: ApplicationDetails
  onOpen: (id: string) => void
  onMerge: (dupId: string, into: string) => void
  onUnmerge: (dupId: string) => void
}) {
  const app = data.application
  if (!data.samePhone.length && !data.merged.length) return null
  return (
    <Section title="Тот же телефон">
      {data.samePhone.length > 0 && (
        <>
          <p className="text-[14px] text-white/55">Похоже, этот человек оставил несколько заявок. Склей их: пустые поля заполнятся, заметки сохранятся, дубль уйдёт из списка.</p>
          <ul className="border-t border-white/10">
            {data.samePhone.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 py-2.5">
                <button onClick={() => onOpen(d.id)} className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-left text-[15px] underline-offset-4 hover:underline">
                  {d.name} · {formatDate(d.createdAt).split(',')[0]} · {channelName(d.channel)} <StatusPill status={d.status} />
                </button>
                <button onClick={() => onMerge(d.id, app.id)} className={ghostSmall}>
                  Склеить в эту
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {data.merged.length > 0 && (
        <ul className="border-t border-white/10">
          {data.merged.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 py-2.5 text-[15px] text-white/60">
              <span>
                Склеена: {d.name} · {d.id} · {channelName(d.channel)}
              </span>
              <button onClick={() => onUnmerge(d.id)} className="text-[14px] underline-offset-4 hover:text-white hover:underline">
                Отделить
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

function Message({ app, onSend }: { app: HrApplication; onSend: (text: string) => Promise<boolean> }) {
  const [text, setText] = useState('')
  return (
    <Section title="Написать кандидату">
      {!isBot(app) && (
        <p className="text-[14px] text-white/55">
          {noBotLabel(app)}. После «Сохранить» покажем готовый текст, его можно прочитать по телефону или переслать в мессенджер.
        </p>
      )}
      <HrTextArea rows={3} value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} aria-label="Текст сообщения" placeholder="Например: подтверди, пожалуйста, что придёшь в четверг" />
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={async () => (await onSend(text.trim())) && setText('')} disabled={text.trim().length < 5} className={`${hrBtn.smallGhost} w-fit`}>
          {isBot(app) ? `Отправить в ${botName(app).replace('Бот в ', '')}` : 'Сохранить и показать текст'}
        </button>
        {text.trim().length < 5 && <DisabledHint>Напиши хотя бы 5 знаков</DisabledHint>}
      </div>
    </Section>
  )
}

function Notes({ app, onSave }: { app: HrApplication; onSave: (notes: string) => Promise<boolean> }) {
  const [notes, setNotes] = useState(app.notes ?? '')
  useEffect(() => setNotes(app.notes ?? ''), [app.id, app.notes])
  return (
    <Section title="Заметки">
      <HrTextArea
        rows={3}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        onBlur={() => notes !== (app.notes ?? '') && void onSave(notes)}
        aria-label="Заметки о кандидате"
        placeholder="Видят только сотрудники HR. Сохраняются, когда уходишь из поля"
      />
    </Section>
  )
}

const notifyLabel: Record<string, string> = {
  queued: 'Сообщение в очереди',
  sent: 'Сообщение доставлено',
  skipped: 'Сообщение не отправлялось',
  failed: 'Сообщение не доставлено',
  cancelled: 'Сообщение отменено',
  call: 'Нужно позвонить',
}

/** Записи истории, у которых сам комментарий и есть описание: «Ведёт: Анна», «Первая смена: …», «Согласие получено устно» */
const selfDescribed: HistoryEntry['kind'][] = ['assign', 'callback', 'merge', 'profile', 'onboarding', 'season', 'consent', 'checkin']

/** Сколько последних записей истории видно сразу; остальные — по «Показать всю историю» */
const HISTORY_SHOWN = 5

function History({ history, me, onUndo }: { history: HistoryEntry[]; me: HrUser; onUndo: (h: HistoryEntry) => void }) {
  const [all, setAll] = useState(false)
  // Отменить можно только последнее изменение — и только своё, если ты не администратор
  const undoable = [...history].reverse().find((h) => ['status', 'missed', 'assign', 'interview'].includes(h.kind) && !h.undoneAt && h.fromStatus !== null)
  const canUndo = (h: HistoryEntry) =>
    h === undoable && Date.now() - new Date(h.createdAt).getTime() < UNDO_WINDOW_MS && (me.role === 'admin' || h.userId === me.id)

  const describe = (h: HistoryEntry): ReactNode => {
    if (h.kind === 'status' && h.fromStatus && h.fromStatus !== h.toStatus)
      return (
        <>
          <StatusBadge status={h.fromStatus} className="text-white/50" /> → <StatusBadge status={h.toStatus} />
        </>
      )
    if (h.kind === 'status' && !h.fromStatus) return 'Заявка пришла'
    if (h.kind === 'missed') return 'Не дозвонились'
    if (h.kind === 'interview') return 'Собеседование перенесено'
    if (h.kind === 'message') return 'Сообщение кандидату'
    if (selfDescribed.includes(h.kind)) return h.comment
    return 'Комментарий'
  }

  return (
    <Section title="История" aside={history.length > HISTORY_SHOWN ? <span className="text-[14px] text-white/60">записей: {history.length}</span> : null}>
      <ol className="border-l border-white/15">
        {[...history]
          .reverse()
          .slice(0, all ? undefined : HISTORY_SHOWN)
          .map((h) => (
          <li key={h.id} className={`relative pb-4 pl-5 last:pb-0 ${h.undoneAt ? 'opacity-45' : ''}`}>
            <span className="absolute top-1.5 -left-[5px] size-2.5 rounded-full bg-white/40" aria-hidden="true" />
            <p className="text-[12px] text-white/55">
              {fmt(h.createdAt)} · {h.userName || 'Система'}
              {h.undoneAt ? ' · отменено' : ''}
            </p>
            <p className={`mt-0.5 text-[15px] ${h.undoneAt ? 'line-through' : ''}`}>{describe(h)}</p>
            {h.comment && !selfDescribed.includes(h.kind) && <p className="mt-0.5 text-[15px] text-white/75">{h.comment}</p>}
            {h.notify && (
              <p className="mt-0.5 text-[13px] text-white/50">
                {notifyLabel[h.notify]}
                {h.notifyDetail ? `: ${h.notifyDetail}` : ''}
              </p>
            )}
            {canUndo(h) && (
              <button onClick={() => onUndo(h)} className="mt-1 text-[13px] text-brand-bright underline-offset-4 hover:underline">
                Отменить
              </button>
            )}
          </li>
        ))}
      </ol>
      {history.length > HISTORY_SHOWN && (
        <button type="button" onClick={() => setAll((v) => !v)} aria-expanded={all} className={`${hrBtn.text} w-fit`}>
          {all ? 'Только последние' : `Показать всю историю · ${history.length}`}
        </button>
      )}
    </Section>
  )
}

/**
 * «Удалить по запросу кандидата»: сначала список — эта заявка, склеенные дубли, другие заявки того же человека
 * (телефон, почта, резюме hh.ru, бот) и данные бота. HR снимает лишнее, пишет причину — и только тогда стираем
 */
function Erase({ app, onErased }: { app: HrApplication; onErased: () => void }) {
  const toast = useToast()
  const [preview, setPreview] = useState<ErasePreview | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const load = async () => {
    setBusy(true)
    setError('')
    try {
      const p = await getErasePreview(app.id)
      setPreview(p)
      setPicked(new Set(p.applications.map((a) => a.id)))
    } catch (e) {
      setError((e as Error).message || 'Не удалось собрать список')
    } finally {
      setBusy(false)
    }
  }
  const submit = async () => {
    setBusy(true)
    try {
      const r = await eraseApplication(app.id, reason.trim(), [...picked])
      toast({
        text: `Личные данные удалены: ${plural(r.applications, 'заявка', 'заявки', 'заявок')}${r.botUsers || r.sessions ? ', данные бота тоже' : ''}`,
        detail: 'Запись появилась в журнале «Настройки → Данные»',
      })
      onErased()
    } catch (e) {
      toast({ text: 'Не удалось удалить', detail: (e as Error).message, tone: 'error' })
    } finally {
      setBusy(false)
    }
  }
  const close = () => {
    setPreview(null)
    setReason('')
  }
  return (
    <Section title="Удалить по запросу">
      {!preview ? (
        <>
          <button onClick={() => void load()} disabled={busy} className={`${hrBtn.small} w-fit text-brand-bright ring-1 ring-brand/60 ring-inset hover:ring-brand`}>
            {busy ? 'Собираем список' : 'Удалить данные кандидата'}
          </button>
          {error && <Notice tone="error">{error}</Notice>}
        </>
      ) : (
        <>
          <p className="text-[14px] text-white/70">
            Если кандидат попросил удалить данные или отозвал согласие. Стираются имя, телефон, контакты, учёба, комментарии, заметки и тексты сообщений, а в боте имя, ник
            и диалог. Статусы и даты останутся для воронки. Проверь список: сними заявки другого человека, если телефон или почта совпали случайно.
          </p>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-[14px] text-white/80">Заявки: {picked.size} из {preview.applications.length}</legend>
            {preview.applications.map((a) => (
              <label key={a.id} className="flex cursor-pointer items-start gap-2.5 text-[15px]">
                <input
                  type="checkbox"
                  checked={picked.has(a.id)}
                  disabled={a.id === app.id}
                  onChange={(e) =>
                    setPicked((p) => {
                      const n = new Set(p)
                      if (e.target.checked) n.add(a.id)
                      else n.delete(a.id)
                      return n
                    })
                  }
                  className="mt-1 size-4 shrink-0 accent-[var(--color-brand)]"
                />
                <span className="min-w-0 break-words">
                  {a.name || 'без имени'} · {a.id} · {formatDate(a.createdAt)} <span className="text-white/60">· {a.why}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {preview.botUsers.length > 0 && (
            <div className="text-[14px] text-white/75">
              <p className="text-white/80">Данные бота у отмеченных заявок:</p>
              <ul className="mt-1 flex flex-col gap-0.5">
                {preview.botUsers.map((u) => (
                  <li key={`${u.channel}:${u.userId}`}>{u.label}</li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <HrLabel htmlFor="erase-reason">Причина (попадёт в журнал)</HrLabel>
            <HrTextArea id="erase-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} className="mt-2" placeholder="Например: письмо кандидата на rabota@ochakovo.ru" />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button onClick={() => void submit()} disabled={busy || reason.trim().length < 5} className={hrBtn.red}>
              {busy ? 'Удаляем' : `Стереть навсегда: ${plural(picked.size, 'заявка', 'заявки', 'заявок')}`}
            </button>
            <button onClick={close} className={hrBtn.ghost}>
              Отмена
            </button>
            {reason.trim().length < 5 && <DisabledHint>Напиши причину, хотя бы 5 знаков</DisabledHint>}
          </div>
        </>
      )}
    </Section>
  )
}
