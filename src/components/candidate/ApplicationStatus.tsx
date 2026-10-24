import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { CHECKIN_NOTE, checkinAnswers, checkinReasons, type CheckinAnswer, type CheckinReason } from '@shared/adaptation'
import { contacts } from '@shared/content/content'
import { btn, Dash } from '../../home/kit'
import {
  answerCheckin,
  ApiError,
  askHrCall,
  bookHour,
  bookingOffer,
  cancelBooking,
  checkinView,
  noHourFits,
  requestBotLink,
  SlotTaken,
  withdrawApplication,
  type BookingOffer,
  type CheckinView,
} from '../../lib/api'
import { useSiteConfig } from '../../lib/config'
import { nb } from '../../lib/typo'
import { openKvasychChat } from '../chat/bus'
import { type SentApplication, useSentApplication } from './sent'
import { downloadInterviewIcs, interviewWhen, mapLink, type CandidateStatus } from './status'
import { visitBlocks, visitTitle } from './visit'

const label = 'font-display text-[18px] font-extrabold tracking-[0.06em] text-white/60 uppercase'
const action =
  'inline-flex min-h-12 items-center justify-center px-4 font-display text-[18px] font-extrabold tracking-[0.04em] uppercase ring-1 ring-white/35 ring-inset transition-colors hover:bg-white hover:text-ink disabled:opacity-50'
const textLink = 'underline decoration-white/35 underline-offset-4 hover:decoration-white'

/** Что с заявкой сейчас и что делать: заголовок, пояснение, собеседование, первая смена, подготовка, «не позвонили», закрытая заявка */
export function StatusBlock({ status, number }: { status: CandidateStatus; number: string }) {
  const callUs = status.overdue || status.stage === 'missed'
  // Дата первой смены от HR — отдельным блоком, как собеседование; «не раньше июля» — только в шагах справа
  const shiftAt = status.firstShift?.at && (status.stage === 'offer' || status.stage === 'started') ? status.firstShift : null
  return (
    <div>
      <p className={label}>Статус</p>
      <p className="mt-2 font-display text-[clamp(36px,4vw,56px)] leading-[0.9] font-black uppercase">{status.title}</p>
      <p className="mt-4 max-w-lg text-lg leading-relaxed text-white/80">{nb(status.text)}</p>

      {status.interview && (
        <div className="mt-8 border-t-[3px] border-white pt-5">
          <p className={label}>Собеседование</p>
          <p className="mt-2 font-display text-[clamp(28px,2.6vw,36px)] leading-[0.95] font-extrabold uppercase">{interviewWhen(status.interview.startsAt)}</p>
          <dl className="mt-4 grid gap-3 text-[17px] leading-snug">
            <div>
              <dt className="text-[14px] text-white/60">Адрес</dt>
              <dd>
                {status.interview.address}{' '}
                <a href={mapLink(status.interview.address)} target="_blank" rel="noreferrer" className={`whitespace-nowrap text-white ${textLink}`}>
                  на карте
                </a>
              </dd>
            </div>
            <div>
              <dt className="text-[14px] text-white/60">Взять с собой</dt>
              <dd>{status.interview.bring}</dd>
            </div>
          </dl>
          <button
            type="button"
            onClick={() => downloadInterviewIcs({ id: status.id, number }, status.interview!, contacts.phone)}
            className={`${action} mt-5`}
          >
            Добавить в календарь
          </button>
        </div>
      )}

      {shiftAt && (
        <div className="mt-8 border-t-[3px] border-white pt-5">
          <p className={label}>Первая смена</p>
          <p className="mt-2 font-display text-[clamp(28px,2.6vw,36px)] leading-[0.95] font-extrabold uppercase">{nb(shiftAt.text)}</p>
          <p className="mt-3 text-[15px] leading-snug text-white/70">{nb(`${contacts.address}. С тобой будет наставник.`)}</p>
        </div>
      )}

      {/* «Как подготовиться» — только когда его дал сервер: при «Собеседовании» и «К оформлению». Пустой список не показываем */}
      {status.prepare && status.prepare.items.length > 0 && (
        <div className="mt-8 border-t border-white/25 pt-5">
          <p className={label}>{status.prepare.title}</p>
          <ul className="mt-3 flex max-w-lg flex-col gap-2.5 text-[16px] leading-snug text-white/85">
            {status.prepare.items.map((item) => (
              <li key={item} className="grid grid-cols-[1.25rem_1fr]">
                <span aria-hidden="true" className="mt-[0.7em] block h-[2px] w-2.5 bg-brand-bright" />
                {nb(item)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {callUs && (
        <div className="mt-8 border-l-[3px] border-brand pl-5">
          <p className="font-display text-[clamp(26px,2.4vw,32px)] leading-none font-extrabold uppercase">
            {status.stage === 'missed' ? 'Перезвони или напиши' : 'Если не позвонили, позвони или напиши'}
          </p>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <a href={`tel:${contacts.phone.replace(/[^+\d]/g, '')}`} className={action}>
              Позвонить
            </a>
            <a href={`https://wa.me/${contacts.whatsapp}`} target="_blank" rel="noreferrer" className={action}>
              WhatsApp
            </a>
            <a href={`mailto:${contacts.email}?subject=${encodeURIComponent(`Заявка ${number}`)}`} className={action}>
              Почта
            </a>
          </div>
        </div>
      )}

      {status.stage === 'closed' && (
        <Link to="/vacancies" className={`${btn.red} mt-8`}>
          Другие вакансии
          <Dash />
        </Link>
      )}
    </div>
  )
}

/**
 * Пять шагов от заявки до первой смены: пройденные — приглушены, текущий — красным с меткой «сейчас», будущие — серым.
 * У «Первой смены» — дата или «не раньше июля»
 */
export function StatusSteps({ status }: { status: CandidateStatus }) {
  const closed = status.stage === 'closed'
  // Шаг, который сейчас идёт, ещё не пройден: собеседование назначено, но не состоялось; HR звонил, но не дозвонился
  const inProgress = status.stage === 'interview' ? 'interview' : status.stage === 'missed' ? 'contacted' : null
  const steps = status.steps.map((s) => (s.id === inProgress ? { ...s, done: false } : s))
  const current = closed ? -1 : steps.findIndex((s) => !s.done)
  return (
    <div>
      <p className={`${label} mb-4`}>Путь до первой смены</p>
      <ol className="border-t-[3px] border-white">
        {steps.map((step, i) => {
          const now = i === current
          const note = step.id === 'started' && !step.done && status.firstShift ? status.firstShift.text : null
          return (
            <li key={step.id} aria-current={now ? 'step' : undefined} className="grid grid-cols-[3rem_1fr] items-center border-b border-white/15 py-4">
              <span
                aria-hidden="true"
                className={`font-display text-[40px] leading-[0.8] font-black ${now ? 'text-brand-bright' : step.done ? 'text-white/35' : 'text-white/30'}`}
              >
                {i + 1}
              </span>
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className={`font-display text-[26px] leading-none font-extrabold uppercase ${now ? 'text-white' : step.done ? 'text-white/55' : 'text-white/60'}`}>{step.label}</span>
                {step.done && <span className="font-display text-[14px] leading-none font-extrabold tracking-[0.06em] text-white/55 uppercase">пройдено</span>}
                {now && <span className="bg-brand px-1.5 py-1 font-display text-[14px] leading-none font-extrabold tracking-[0.06em] text-white uppercase">сейчас</span>}
                {note && <span className="basis-full text-[15px] text-white/65">{nb(note)}</span>}
              </span>
            </li>
          )
        })}
      </ol>
      {closed && <p className="mt-4 text-[15px] text-white/60">{nb('Заявка закрыта, следующих шагов не будет.')}</p>}
    </div>
  )
}

/**
 * «Куда ехать и что взять» — по справочнику студента: дорога по станциям с корпоративным автобусом, документы по практике,
 * общежитие. Без документов взять с собой нечего — тогда заголовок «Дорога и общежитие»
 */
export function VisitInfo({ practice }: { practice: boolean }) {
  const blocks = visitBlocks(practice)
  return (
    <section aria-labelledby="visit-title" className="border-t-[3px] border-white pt-6">
      <h2 id="visit-title" className="font-display text-[clamp(36px,4vw,56px)] leading-[0.9] font-black uppercase">
        {visitTitle(blocks)}
      </h2>
      <div className={`mt-8 grid gap-x-10 gap-y-8 ${blocks.length === 3 ? 'lg:grid-cols-3' : 'md:grid-cols-2'}`}>
        {blocks.map((b) => (
          <div key={b.id} className="border-t border-white/25 pt-4">
            <h3 className="font-display text-[26px] leading-none font-extrabold uppercase">{b.title}</h3>
            <div className="mt-3 flex flex-col gap-2.5 text-[16px] leading-snug text-white/80">
              {b.lines.map((line, i) => (
                <p key={line} className={i === 0 ? 'text-white' : undefined}>
                  {nb(line)}
                </p>
              ))}
            </div>
            {b.list && (
              <dl className="mt-4 border-t border-white/15 text-[16px] leading-snug">
                {b.list.map((r) => (
                  <div key={r.term} className="border-b border-white/15 py-2.5">
                    <dt className="text-white">{nb(r.term)}</dt>
                    <dd className="mt-0.5 text-white/70">{nb(r.text)}</dd>
                  </div>
                ))}
              </dl>
            )}
            {b.id === 'route' && (
              <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-[16px]">
                <a href={mapLink(contacts.address)} target="_blank" rel="noreferrer" className={`inline-flex min-h-11 items-center ${textLink}`}>
                  Завод на карте
                </a>
                {b.call && (
                  <a href={`tel:${b.call.tel}`} className={`inline-flex min-h-11 items-center ${textLink}`}>
                    {b.call.label}
                  </a>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

const botName = { telegram: 'Telegram', max: 'MAX' } as const
type Bot = keyof typeof botName

/**
 * «Получать ответ HR в Telegram/MAX»: только при подключённом боте (GET /api/config). Ссылка с одноразовым кодом
 * открывает бота — после «Старта» сообщения о заявке приходят туда. Выбранный мессенджер запоминаем в этом браузере
 */
export function BotLinks({ app }: { app: SentApplication }) {
  const config = useSiteConfig()
  const remember = useSentApplication((s) => s.setBot)
  const [busy, setBusy] = useState<Bot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const bots = (['telegram', 'max'] as const).filter((b) => config?.bots[b])
  if (!app.token || !bots.length) return null

  const open = async (bot: Bot) => {
    setError(null)
    setBusy(bot)
    // Окно открываем сразу, по нажатию: после ожидания ответа браузер счёл бы его всплывающим и заблокировал
    const tab = window.open('', '_blank')
    try {
      const links = await requestBotLink(app.id, app.token!)
      const url = links[bot]
      if (!url) throw new Error('no_link')
      if (tab) tab.location.href = url
      else window.location.assign(url)
      remember(bot)
    } catch {
      tab?.close()
      setError(`Не получилось открыть ${botName[bot]}. Попробуй ещё раз через минуту. Статус заявки всё равно виден здесь.`)
    } finally {
      setBusy(null)
    }
  }

  const chosen = app.bot && bots.includes(app.bot) ? app.bot : null
  return (
    <div className="mt-6 max-w-lg">
      {chosen ? (
        <p className="text-[17px] leading-snug">
          {nb(`Ответ придёт в ${botName[chosen]}, когда бот запущен.`)}{' '}
          <button type="button" onClick={() => void open(chosen)} disabled={busy !== null} className={`text-white/75 ${textLink}`}>
            Открыть бота ещё раз
          </button>
        </p>
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {bots.map((bot) => (
            <button key={bot} type="button" onClick={() => void open(bot)} disabled={busy !== null} className={`${action} !justify-start sm:!justify-center`}>
              {busy === bot ? 'Открываем' : `Получать ответ HR в ${botName[bot]}`}
            </button>
          ))}
        </div>
      )}
      <p className="mt-2 text-[14px] leading-snug text-white/60">{nb('Сообщения о заявке придут в этот чат. Чтобы отвязать его, отправь\u00A0/stop.')}</p>
      {error && (
        <p role="alert" className="mt-2 text-[15px] text-brand-bright">
          {error}
        </p>
      )}
    </div>
  )
}

/**
 * «Отозвать согласие и удалить заявку» с подтверждением: заявку обезличивают, статус по ключу больше не открывается,
 * копия в браузере стирается — шапка снова «Откликнуться»
 */
export function Withdraw({ app, number, onDone }: { app: SentApplication; number: string; onDone: (result: 'withdrawn' | 'gone') => void }) {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!app.token) return null
  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      onDone(await withdrawApplication(app.id, app.token!))
    } catch {
      setError(`Не получилось. Попробуй позже или напиши на ${contacts.email} с темой «Отзыв согласия».`)
    } finally {
      setBusy(false)
    }
  }
  if (!asking)
    return (
      <button type="button" onClick={() => setAsking(true)} className={`inline-flex min-h-11 items-center text-[14px] text-white/60 ${textLink} hover:text-white`}>
        Отозвать согласие и удалить заявку
      </button>
    )
  return (
    <div role="group" aria-labelledby="withdraw-title" className="max-w-lg border-l-[3px] border-brand pl-5">
      <p id="withdraw-title" className="font-display text-[26px] leading-none font-extrabold uppercase">
        Удалить заявку {number}
      </p>
      <p className="mt-3 text-[16px] leading-snug text-white/80">
        {nb('Согласие будет отозвано, данные заявки удалят, и отдел персонала больше не свяжется по ней. Отменить это нельзя.')}
      </p>
      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <button type="button" onClick={() => void confirm()} disabled={busy} className={`${action} bg-brand ring-brand hover:bg-white hover:text-brand`}>
          {busy ? 'Удаляем' : 'Удалить заявку'}
        </button>
        <button type="button" onClick={() => setAsking(false)} disabled={busy} className={action} autoFocus>
          Оставить
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-[15px] text-brand-bright">
          {error}
        </p>
      )}
    </div>
  )
}

/** Часы «вторник, 14 июля, в 11:00 по Москве» — кнопками; день недели и число одной строкой */
const hourParts = (iso: string) => {
  const d = new Date(iso)
  const day = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', weekday: 'short', day: 'numeric', month: 'long' }).format(d)
  const time = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' }).format(d)
  return { day, time }
}

/**
 * Выбор времени собеседования (w2-booking): HR предложил — до 6 свободных часов кнопками. Выбор ставит собеседование,
 * его можно перенести или отменить. Занятое за секунду до нажатия время — «Это время уже заняли, выбери другое».
 * «Ни одно время не подходит — позвоните» создаёт задачу HR. Нет предложения — блока нет
 */
export function Booking({ app, onChange }: { app: SentApplication; onChange: () => void }) {
  const [offer, setOffer] = useState<BookingOffer | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [changing, setChanging] = useState(false)
  const [called, setCalled] = useState(false)
  const reload = () => (app.token ? bookingOffer(app.id, app.token).then(setOffer) : Promise.resolve())
  useEffect(() => {
    void reload()
    // при смене заявки
  }, [app.id, app.token])
  // Предложение HR есть — блок виден и без свободных часов: «мест нет» и «Ни одно время не подходит»
  if (!app.token || !offer || (!offer.offered && !offer.hours.length && !offer.booked)) return null

  /** Действие с записью; true — получилось. После любого ответа список часов обновляется */
  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true)
    setNote(null)
    let ok = false
    try {
      await fn()
      ok = true
      setChanging(false)
      if (done) setNote(done)
      onChange()
    } catch (e) {
      // 410 — срок выбора вышел или предложение отозвали: показываем текст сервера с контактами
      setNote(
        e instanceof SlotTaken
          ? 'Это время уже заняли, выбери другое.'
          : e instanceof ApiError && e.status === 410
            ? e.message
            : 'Не получилось. Попробуй ещё раз или позвони в отдел подбора.',
      )
    } finally {
      setBusy(false)
      await reload()
    }
    return ok
  }

  const showHours = !offer.booked || changing
  // Записался — время, адрес и календарь показывает блок «Собеседование» выше; здесь — только перенос и отмена
  if (!showHours)
    return (
      <div className="mt-5">
        <p className="text-[15px] text-white/65">{nb('Время выбрано на этой странице, его можно перенести или отменить.')}</p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <button type="button" disabled={busy} onClick={() => setChanging(true)} className={action}>
            Перенести
          </button>
          <button type="button" disabled={busy} onClick={() => void run(() => cancelBooking(app.id, app.token!), 'Запись отменена, место освободилось.')} className={action}>
            Отменить запись
          </button>
        </div>
        {note && (
          <p role="status" className="mt-3 text-[15px] text-white">
            {note}
          </p>
        )}
      </div>
    )
  return (
    <div className="mt-8 border-t-[3px] border-white pt-5">
      <p className={label}>{offer.hiringDay ? 'День найма: выбери час' : changing ? 'Другое время собеседования' : 'Выбери время собеседования'}</p>
      {showHours && (
        <>
          <p className="mt-2 max-w-lg text-[16px] leading-snug text-white/75">
            {nb(
              offer.hiringDay
                ? `Время по Москве. Адрес: ${offer.hiringDay.address}. Дату оформления HR назовёт позже.`
                : 'Время по Москве. Адрес и что взять придут после записи.',
            )}
          </p>
          {offer.hours.length ? (
            <ul className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {offer.hours.map((h) => {
                const { day, time } = hourParts(h)
                return (
                  <li key={h}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void run(() => bookHour(app.id, app.token!, h))}
                      className="flex min-h-16 w-full flex-col items-start justify-center px-3 py-2 text-left ring-1 ring-white/35 ring-inset transition-colors hover:bg-white hover:text-ink disabled:opacity-50"
                    >
                      <span className="text-[14px] leading-tight opacity-75">{day}</span>
                      <span className="font-display text-[26px] leading-none font-black tabular-nums">{time}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="mt-4 text-[16px] text-white/75">{nb(offer.full ? 'Мест нет: все часы уже разобрали.' : 'Свободного времени сейчас нет.')}</p>
          )}
          <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-[15px]">
            {changing && (
              <button type="button" onClick={() => setChanging(false)} className={`inline-flex min-h-11 items-center text-white/70 ${textLink}`}>
                Оставить прежнее время
              </button>
            )}
            {!called && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => noHourFits(app.id, app.token!), 'HR позвонит и предложит другое время.').then((ok) => ok && setCalled(true))}
                className={`inline-flex min-h-11 items-center text-white/70 ${textLink}`}
              >
                Ни одно время не подходит, позвоните мне
              </button>
            )}
          </div>
        </>
      )}
      {note && (
        <p role="status" className="mt-3 text-[15px] text-white">
          {note}
        </p>
      )}
    </div>
  )
}

const CALL_LABEL = 'Пусть HR позвонит'

/**
 * «Как дела на смене» — новичку после первой смены, через неделю и через месяц (shared/adaptation.ts).
 * Ответ видит отдел персонала; «Тяжело» с причиной — совет из справочника студента и звонок HR. Без вопроса — только «Пусть HR позвонит»
 */
export function Checkin({ app }: { app: SentApplication }) {
  const [view, setView] = useState<CheckinView | null>(null)
  const [hard, setHard] = useState(false)
  const [answered, setAnswered] = useState<CheckinAnswer | null>(null)
  const [reply, setReply] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [called, setCalled] = useState(false)
  useEffect(() => {
    if (app.token) void checkinView(app.id, app.token).then(setView)
  }, [app.id, app.token])
  if (!app.token || !view || (!view.step && !view.call && !reply)) return null

  const run = async (fn: () => Promise<string>, after?: () => void) => {
    setBusy(true)
    try {
      setReply(await fn())
      after?.()
    } catch (e) {
      setReply(e instanceof ApiError && e.status === 410 ? e.message : 'Не получилось отправить. Попробуй ещё раз или позвони в отдел подбора.')
    } finally {
      setBusy(false)
    }
  }
  const send = (answer: CheckinAnswer, reason?: CheckinReason) =>
    run(
      async () => {
        const r = await answerCheckin(app.id, app.token!, view.step!, answer, reason)
        if (answer === 'ok') return `Спасибо. Если что-то пойдёт не так, здесь есть кнопка «${CALL_LABEL}».`
        if (answer === 'question') return `Спроси Квасыча: он отвечает по справочнику студента. Если нужен человек из отдела персонала, нажми «${CALL_LABEL}».`
        return r.reply
      },
      () => (setAnswered(answer), setHard(false)),
    )
  const call = () => run(async () => (await askHrCall(app.id, app.token!)).reply, () => setCalled(true))

  const asking = view.step && !answered
  // После «Тяжело» и после просьбы позвонить звонок уже обещан — кнопку не повторяем
  const canCall = view.call && !called && answered !== 'hard'
  return (
    <div data-checkin className="mt-8 border-t-[3px] border-white pt-5">
      <p className={label}>Как дела на смене</p>
      {asking ? (
        <>
          <p className="mt-2 font-display text-[clamp(28px,2.6vw,36px)] leading-[0.95] font-extrabold uppercase">{hard ? 'Что тяжелее всего?' : view.question}</p>
          {!hard && <p className="mt-3 max-w-lg text-[16px] leading-snug text-white/75">{nb(CHECKIN_NOTE)}</p>}
          {hard ? (
            <ul className="mt-4 grid gap-2 sm:grid-cols-2" aria-label="Что тяжелее всего">
              {checkinReasons.map((r) => (
                <li key={r.id}>
                  <button type="button" disabled={busy} onClick={() => void send('hard', r.id)} className={`${action} w-full justify-start text-left`}>
                    {r.label}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              {checkinAnswers.map((a) => (
                <button key={a.id} type="button" disabled={busy} onClick={() => (a.id === 'hard' ? setHard(true) : void send(a.id))} className={action}>
                  {a.label}
                </button>
              ))}
            </div>
          )}
          {hard && (
            <button type="button" onClick={() => setHard(false)} className={`mt-3 inline-flex min-h-11 items-center text-[15px] text-white/70 ${textLink}`}>
              Назад
            </button>
          )}
        </>
      ) : (
        !reply && <p className="mt-2 max-w-lg text-[16px] leading-snug text-white/75">{nb('Если нужна помощь с графиком, учёбой или дорогой, отдел персонала перезвонит.')}</p>
      )}
      {reply && (
        <p role="status" className="mt-4 max-w-lg text-[16px] leading-snug whitespace-pre-line text-white">
          {nb(reply)}
        </p>
      )}
      {(answered === 'question' || (!asking && canCall)) && (
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {answered === 'question' && (
            <button type="button" aria-haspopup="dialog" onClick={() => openKvasychChat()} className={action}>
              Спросить Квасыча
            </button>
          )}
          {canCall && (
            <button type="button" disabled={busy} onClick={() => void call()} className={action}>
              {CALL_LABEL}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
