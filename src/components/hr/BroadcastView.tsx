import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { departmentList } from '@shared/content/departments'
import { ApiError, ApiValidationError, type HrUser } from '../../lib/api'
import {
  broadcastTitle,
  getBroadcast,
  getBroadcastState,
  previewBroadcast,
  saveRecruit,
  segmentLabels,
  sendBroadcast,
  type Audience,
  type BroadcastDraft,
  type BroadcastEntry,
  type BroadcastKind,
  type BroadcastPreview,
  type BroadcastSegment,
  type BroadcastState,
  type PreviewChannel,
  type RecruitState,
} from '../../lib/hr/bots'
import { BotBubble } from './BotsView'
import { formatDate, plural } from './hrUtils'
import { Dialog } from './overlay'
import { useToast } from './toasts'
import { chip, Empty, hrBtn, HrInput, HrLabel, HrSelect, Notice, RuDate } from './ui'

// Вкладка «Рассылка» в панели HR: рассылка подписавшимся на «Напомнить о наборе» и журнал доставки. Только администратору.
// Состояние набора и срок окончания приёма → какое сообщение можно отправить → кому → как увидит человек → отправка
// пачками через ботов. Не чаще раза в неделю на человека, в каждом сообщении — «Не присылать».

export const ready: boolean = true

/** Сообщение — действием: «Объявить набор», «Напомнить о сроке». Состояние набора — отдельно, в блоке «Набор» */
const kindLabel = (kind: BroadcastKind, daysLeft: number | null) =>
  kind === 'open'
    ? 'Объявить набор'
    : daysLeft === null
      ? 'Напомнить о сроке'
      : daysLeft <= 0
        ? 'Напомнить: последний день'
        : daysLeft === 7
          ? 'Напомнить о сроке · неделя'
          : `Напомнить о сроке · ${plural(daysLeft, 'день', 'дня', 'дней')}`

const deptName = (id: string | null) => departmentList.find((d) => d.id === id)?.name ?? ''

/** «Набор открыт · до конца приёма 5 дней» */
function recruitLine(s: BroadcastState['recruit']) {
  if (s.state === 'closed') return 'Набор закрыт'
  if (s.daysLeft === null) return 'Набор открыт, срок окончания не задан'
  if (s.daysLeft < 0) return 'Набор открыт, но срок приёма прошёл'
  if (s.daysLeft === 0) return 'Набор открыт, сегодня последний день приёма'
  return `Набор открыт, до конца приёма ${plural(s.daysLeft, 'день', 'дня', 'дней')}`
}

export function BroadcastView({ user }: { user: HrUser }) {
  const [state, setState] = useState<BroadcastState | null>(null)
  const [error, setError] = useState(false)

  const load = useCallback(
    () =>
      getBroadcastState()
        .then((s) => {
          setState(s)
          setError(false)
        })
        .catch(() => setError(true)),
    [],
  )
  useEffect(() => {
    void load()
  }, [load])

  if (user.role !== 'admin') return <Notice>Рассылку отправляет администратор панели.</Notice>
  if (error && !state) return <Notice tone="error">Рассылка не загрузилась. Обнови страницу.</Notice>
  if (!state) return <p className="text-white/50">Загружаем рассылку</p>

  // На телефоне по порядку: набор, рассылка, журнал, подписчики; на широком экране набор и подписчики — слева
  return (
    <div className="grid gap-14 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:grid-rows-[auto_1fr] lg:gap-x-16">
      <div className="min-w-0 lg:col-start-1 lg:row-start-1">
        <RecruitForm state={state} onSaved={(r) => setState((s) => s && { ...s, ...r })} />
      </div>
      <div className="min-w-0 lg:col-start-2 lg:row-span-2 lg:row-start-1">
        <Composer state={state} onSent={() => void load()} />
        <Journal entries={state.broadcasts} onChanged={() => void load()} />
      </div>
      <div className="min-w-0 lg:col-start-1 lg:row-start-2">
        <Subscribers state={state} />
      </div>
    </div>
  )
}

function RecruitForm({ state, onSaved }: { state: BroadcastState; onSaved: (r: Pick<BroadcastState, 'recruit' | 'kinds' | 'channels'>) => void }) {
  const [mode, setMode] = useState<RecruitState>(state.recruit.state)
  const [endsOn, setEndsOn] = useState(state.recruit.endsOn ?? '')
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const toast = useToast()
  const dateId = useId()
  const changed = mode !== state.recruit.state || (endsOn || null) !== state.recruit.endsOn

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setProblem(null)
    try {
      const r = await saveRecruit(mode, endsOn || null)
      onSaved(r)
      toast({ text: mode === 'open' ? 'Набор открыт' : 'Набор закрыт', detail: r.recruit.endsOn ? 'Срок окончания приёма сохранён.' : undefined })
    } catch (err) {
      setProblem(err instanceof ApiValidationError ? (err.errors.recruit ?? err.message) : 'Не сохранилось. Проверь соединение.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section aria-labelledby="recruit-title">
      <h2 id="recruit-title" className="font-display text-[28px] leading-none font-black uppercase">
        Набор
      </h2>
      <p className="mt-4 text-[16px]">{recruitLine(state.recruit)}</p>
      {state.recruit.updatedBy && state.recruit.updatedAt && (
        <p className="mt-1 text-[13px] text-white/65">
          Последнее изменение: {state.recruit.updatedBy}, {formatDate(state.recruit.updatedAt)}
        </p>
      )}
      <form onSubmit={save} className="mt-6 flex flex-col gap-5">
        <p className="-mb-3 font-display text-[15px] font-extrabold tracking-[0.06em] text-white/60 uppercase" id="recruit-state">
          Набор сейчас
        </p>
        <div role="radiogroup" aria-labelledby="recruit-state" className="flex gap-2">
          {(['closed', 'open'] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)} className={chip(mode === m)}>
              {m === 'open' ? 'Открыт' : 'Закрыт'}
            </button>
          ))}
        </div>
        <div className="max-w-xs">
          <HrLabel htmlFor={dateId}>Срок окончания приёма</HrLabel>
          <HrInput id={dateId} type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
          <RuDate value={endsOn} className="mt-1 block" />
          <p className="mt-2 text-[13px] leading-snug text-white/60">Без срока «Напомнить о сроке» не отправить.</p>
        </div>
        {problem && <Notice tone="error">{problem}</Notice>}
        <div>
          <button type="submit" disabled={saving || !changed} className={hrBtn.ghost}>
            Сохранить
          </button>
        </div>
      </form>
    </section>
  )
}

function Subscribers({ state }: { state: BroadcastState }) {
  const s = state.subscribers
  const depts = departmentList.filter((d) => s.byDept[d.id])
  return (
    <section aria-labelledby="subs-title">
      <h2 id="subs-title" className="font-display text-[28px] leading-none font-black uppercase">
        Подписчики
      </h2>
      <p className="mt-4 max-w-md text-[15px] leading-snug text-white/65">
        Нажали «Напомнить о наборе» в боте и не отписались. Подписчики из чата на сайте рассылку не получают, потому что подписка есть только в Telegram и MAX.
      </p>
      <dl className="mt-6 border-t border-white/15">
        <Row term="Всего" value={s.total} strong />
        <Row term="Telegram" value={s.byChannel.telegram} note={state.channels.telegram ? undefined : 'бот не подключён'} />
        <Row term="MAX" value={s.byChannel.max} note={state.channels.max ? undefined : 'бот не подключён'} />
        {s.byDept.any ? <Row term="Любое направление" value={s.byDept.any} /> : null}
        {depts.map((d) => (
          <Row key={d.id} term={d.name} value={s.byDept[d.id]} />
        ))}
      </dl>
    </section>
  )
}

function Row({ term, value, note, strong }: { term: string; value: number; note?: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-white/15 py-2.5">
      <dt className={strong ? 'text-[16px]' : 'text-[15px] text-white/70'}>
        {term}
        {note && <span className="text-white/60"> · {note}</span>}
      </dt>
      <dd className={`tabular-nums ${strong ? 'font-display text-[24px] leading-none font-black' : 'text-[15px]'}`}>{value}</dd>
    </div>
  )
}

/** «Уйдёт 12 подписчикам» и почему не всем: рассылка была меньше недели назад, бот мессенджера не подключён */
function audienceText(a: Audience) {
  const main = !a.total ? 'В этом сегменте подписчиков нет' : a.ready ? `Уйдёт ${plural(a.ready, 'подписчику', 'подписчикам', 'подписчикам')}` : 'Сейчас отправить некому'
  const skip = [
    ...(a.recent ? [`${plural(a.recent, 'подписчик получал', 'подписчика получали', 'подписчиков получали')} рассылку меньше недели назад`] : []),
    ...(a.offline ? [`У ${plural(a.offline, 'подписчика', 'подписчиков', 'подписчиков')} не подключён бот мессенджера`] : []),
  ]
  return { main, skip: skip.length ? `${skip.join('. ')}. Им сообщение не уйдёт.` : '' }
}

function Composer({ state, onSent }: { state: BroadcastState; onSent: () => void }) {
  const firstKind = (['deadline', 'open'] as const).find((k) => !state.kinds[k]) ?? 'open'
  const [kind, setKind] = useState<BroadcastKind>(firstKind)
  const [segment, setSegment] = useState<BroadcastSegment>('all')
  const [dept, setDept] = useState<string>(departmentList[0].id)
  const [channel, setChannel] = useState<PreviewChannel>('telegram')
  const [preview, setPreview] = useState<BroadcastPreview | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [sending, setSending] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const toast = useToast()
  const deptId = useId()

  const draft: BroadcastDraft = { kind, segment, ...(segment === 'dept' ? { dept } : {}) }
  // Сообщение и число получателей пересчитываются при смене выбора, срока набора и после каждой рассылки
  const { state: recruitState, endsOn } = state.recruit
  const sent = state.broadcasts.length

  useEffect(() => {
    let alive = true
    previewBroadcast({ kind, segment, ...(segment === 'dept' ? { dept } : {}) })
      .then((p) => alive && setPreview(p))
      .catch(() => alive && setPreview(null))
    return () => {
      alive = false
    }
  }, [kind, segment, dept, recruitState, endsOn, sent])

  const unavailable = state.kinds[kind]
  const ready = preview?.audience.ready ?? 0
  const sendingNow = state.broadcasts.some((b) => b.status === 'sending')

  const send = async () => {
    setSending(true)
    setProblem(null)
    try {
      const r = await sendBroadcast(draft)
      setConfirm(false)
      toast({ text: 'Рассылка отправляется', detail: `${plural(r.audience.ready, 'сообщение', 'сообщения', 'сообщений')}, ход отправки виден в журнале.` })
      onSent()
    } catch (err) {
      setProblem(err instanceof ApiError && typeof err.data.message === 'string' ? err.data.message : 'Не отправилось. Проверь соединение.')
    } finally {
      setSending(false)
    }
  }

  const a = preview ? audienceText(preview.audience) : null

  return (
    <section aria-labelledby="compose-title">
      <h2 id="compose-title" className="font-display text-[28px] leading-none font-black uppercase">
        Рассылка
      </h2>
      <p className="mt-4 max-w-xl text-[15px] leading-snug text-white/65">
        Сообщение уходит в бот тем, кто подписался на «Напомнить о наборе». Одному человеку не чаще раза в неделю, в каждом сообщении есть кнопка «Не присылать».
      </p>

      <fieldset className="mt-8">
        <legend className="font-display text-[15px] font-extrabold tracking-[0.06em] text-white/60 uppercase">Что отправить</legend>
        <div role="radiogroup" aria-label="Что отправить" className="mt-3 flex flex-wrap gap-2">
          {(['open', 'deadline'] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)} className={chip(kind === k)}>
              {kindLabel(k, state.recruit.daysLeft)}
            </button>
          ))}
        </div>
        {unavailable && <p className="mt-3 text-[14px] leading-snug text-white/70">{unavailable}</p>}
      </fieldset>

      <fieldset className="mt-8">
        <legend className="font-display text-[15px] font-extrabold tracking-[0.06em] text-white/60 uppercase">Кому</legend>
        <div role="radiogroup" aria-label="Кому" className="mt-3 flex flex-wrap gap-2">
          {(['all', 'dept', 'tasks'] as const).map((s) => (
            <button key={s} type="button" role="radio" aria-checked={segment === s} onClick={() => setSegment(s)} className={chip(segment === s)}>
              {segmentLabels[s]}
            </button>
          ))}
        </div>
        {segment === 'dept' && (
          <div className="mt-4 max-w-xs">
            <HrLabel htmlFor={deptId}>Направление</HrLabel>
            <HrSelect id={deptId} value={dept} onChange={(e) => setDept(e.target.value)}>
              {departmentList.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </HrSelect>
            <p className="mt-2 text-[13px] leading-snug text-white/65">Сюда входят и те, кому подходит любое направление.</p>
          </div>
        )}
        {segment === 'tasks' && <p className="mt-3 text-[14px] leading-snug text-white/65">Прошли хотя бы одно из четырёх заданий в боте, а заявку пока не оставили.</p>}
      </fieldset>

      <div className="mt-8 flex flex-wrap items-end justify-between gap-4">
        <p className="font-display text-[15px] font-extrabold tracking-[0.06em] text-white/60 uppercase">Как увидит подписчик</p>
        <div role="radiogroup" aria-label="Вид мессенджера" className="flex gap-2">
          {(['telegram', 'max'] as const).map((c) => (
            <button key={c} type="button" role="radio" aria-checked={channel === c} onClick={() => setChannel(c)} className={chip(channel === c)}>
              {c === 'max' ? 'MAX' : 'Telegram'}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-3 border border-white/15 bg-coal px-3 py-4 sm:px-5">
        {preview ? (
          preview.views[channel].map((item) => (item.kind === 'bot' ? <BotBubble key={item.id} item={item} /> : null))
        ) : (
          <p className="text-[14px] text-white/65">Собираем сообщение</p>
        )}
      </div>

      <div className="mt-6" aria-live="polite">
        {a && (
          <p className="text-[16px]">
            {a.main}
            {preview!.audience.ready > 0 && (
              <span className="text-white/65">
                {' '}
                · Telegram {preview!.audience.byChannel.telegram}, MAX {preview!.audience.byChannel.max}
              </span>
            )}
          </p>
        )}
        {a?.skip && <p className="mt-1 text-[14px] text-white/65">{a.skip}</p>}
      </div>
      {problem && !confirm && (
        <div className="mt-4">
          <Notice tone="error">{problem}</Notice>
        </div>
      )}
      <div className="mt-5">
        <button type="button" disabled={Boolean(unavailable) || !ready || sendingNow} onClick={() => setConfirm(true)} className={hrBtn.red}>
          {ready ? `Отправить ${plural(ready, 'подписчику', 'подписчикам', 'подписчикам')}` : 'Отправить'}
        </button>
        {sendingNow && <p className="mt-2 text-[14px] text-white/65">Предыдущая рассылка ещё отправляется.</p>}
      </div>

      <Dialog open={confirm} title="Отправить рассылку" onClose={() => setConfirm(false)}>
        <p className="text-[16px] leading-snug">
          {plural(ready, 'подписчик получит', 'подписчика получат', 'подписчиков получат')} сообщение «{preview ? broadcastTitle(preview.text) : ''}» в боте. Остановить отправку нельзя.
        </p>
        {problem && (
          <div className="mt-4">
            <Notice tone="error">{problem}</Notice>
          </div>
        )}
        <div className="mt-6 flex flex-wrap gap-3">
          <button type="button" onClick={() => void send()} disabled={sending} className={hrBtn.red}>
            Отправить
          </button>
          <button type="button" onClick={() => setConfirm(false)} className={hrBtn.ghost}>
            Отмена
          </button>
        </div>
      </Dialog>
    </section>
  )
}

function Journal({ entries, onChanged }: { entries: BroadcastEntry[]; onChanged: () => void }) {
  const sending = entries.find((e) => e.status === 'sending')
  const [live, setLive] = useState<BroadcastEntry | null>(null)
  const changed = useRef(onChanged)
  changed.current = onChanged

  // Пока рассылка отправляется — обновляем её строку раз в 2 секунды, в конце перечитываем журнал
  useEffect(() => {
    if (!sending) return
    let alive = true
    const timer = window.setInterval(() => {
      getBroadcast(sending.id)
        .then((b) => {
          if (!alive) return
          setLive(b)
          if (b.status !== 'sending') changed.current()
        })
        .catch(() => {})
    }, 2000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [sending])

  const rows = entries.map((e) => (live && live.id === e.id ? live : e))

  return (
    <section aria-labelledby="journal-title" className="mt-14">
      <h2 id="journal-title" className="font-display text-[28px] leading-none font-black uppercase">
        Журнал
      </h2>
      <ul className="mt-6 border-t border-white/15">
        {rows.map((b) => (
          <li key={b.id} className="border-b border-white/15 py-4">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
              <p className="min-w-0 text-[16px] break-words">{broadcastTitle(b.text)}</p>
              <p className="shrink-0 text-[13px] text-white/65">
                {formatDate(b.createdAt)} · {b.userName || 'HR'}
              </p>
            </div>
            <p className="mt-1 text-[14px] text-white/65">
              {segmentLabels[b.segment]}
              {b.segment === 'dept' && b.dept ? `: ${deptName(b.dept)}` : ''} · подходило {b.recipients}
              {b.status === 'sending' ? ' · отправляется' : b.status === 'interrupted' ? ' · прервана перезапуском сервера' : ''}
            </p>
            <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
              <Stat term="Доставлено" value={b.delivered} />
              <Stat term="Заблокировали бота" value={b.blocked} />
              <Stat term="Отписались" value={b.unsubscribed} />
              <Stat term="Не отправлено" value={b.failed + b.skippedRecent + b.skippedOffline} />
            </dl>
          </li>
        ))}
      </ul>
      {!rows.length && <Empty title="Рассылок пока не было">Первая появится здесь сразу после отправки: доставлено, заблокировали бота, отписались.</Empty>}
    </section>
  )
}

function Stat({ term, value }: { term: string; value: number }) {
  return (
    <div className="min-w-0">
      <dt className="text-[13px] leading-tight text-white/65">{term}</dt>
      <dd className="mt-0.5 font-display text-[26px] leading-none font-black tabular-nums">{value}</dd>
    </div>
  )
}
