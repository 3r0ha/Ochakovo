import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router'
import { statusLabel, type ApplicationStatus } from '@shared/applications'
import { callChanged, callStats, duplicateGroupCount, forgetCall, nextCall, recordCall, skipCall, startCall, type CallOutcome, type CallRun } from '@shared/hrFilter'
import { BotsView, ready as botsReady } from '../components/hr/BotsView'
import { BroadcastView, ready as broadcastReady } from '../components/hr/BroadcastView'
import { CandidateDrawer, type CallControl, type CardIntent } from '../components/hr/CandidateDrawer'
import { Candidates } from '../components/hr/Candidates'
import { DuplicatesView } from '../components/hr/DuplicatesView'
import { FocusView, ready as focusReady } from '../components/hr/FocusView'
import { FunnelView } from '../components/hr/FunnelView'
import { HrShell, type HrTab } from '../components/hr/HrShell'
import { plural } from '../components/hr/hrUtils'
import { KbGapsView } from '../components/hr/KbGapsView'
import { planText } from '../components/hr/notifyText'
import { Dialog } from '../components/hr/overlay'
import { SettingsView } from '../components/hr/SettingsView'
import { SourcesView, ready as sourcesReady } from '../components/hr/SourcesView'
import { useSourceNames } from '../components/hr/sourcesCache'
import { ToastProvider, useToast } from '../components/hr/toasts'
import { ScheduleView } from '../components/hr/ScheduleView'
import { hrBtn, Notice } from '../components/hr/ui'
import { ApiUnavailable, ApiValidationError, demoLocal, getKbGaps, getStaff, hrLogout, hrMe, HrUnauthorized, updateApplication, type HrApplication, type HrUser, type Staff } from '../lib/api'
import { loadDesk, undoAll } from '../lib/hr/desk'

type TabId = 'list' | 'schedule' | 'funnel' | 'dups' | 'gaps' | 'sources' | 'focus' | 'bots' | 'broadcast' | 'settings'

/**
 * Вкладки второй волны: видны, когда раздел готов (ready в его файле); «Рассылка» — только администратору.
 * more — второстепенные: на ноутбуке они в меню «Ещё»
 */
const laterTabs = (role: HrUser['role']) => [
  ...(sourcesReady ? [{ id: 'sources' as const, label: 'Источники' }] : []),
  ...(focusReady ? [{ id: 'focus' as const, label: 'Фокус-группа', more: true }] : []),
  ...(botsReady ? [{ id: 'bots' as const, label: 'Боты', more: true }] : []),
  ...(broadcastReady && role === 'admin' ? [{ id: 'broadcast' as const, label: 'Рассылка', more: true }] : []),
]

/** В демо-режиме без сервера панель открывается без входа и показывает заявки из этого браузера */
const localUser: HrUser = { id: 0, email: '', name: 'Демо без сервера', role: 'admin', disabled: false, createdAt: '', lastLoginAt: null }

/** Как часто подтягивать новые заявки, пока вкладка открыта. Без изменений сервер отвечает 304 без тела */
const POLL_MS = 30_000

/** Обзвон переживает перезагрузку страницы: список и итоги — в этой вкладке браузера */
const CALL_KEY = 'ochakovo.hr.call'

function savedCall(): CallRun | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(CALL_KEY) ?? 'null') as CallRun | null
    return v && Array.isArray(v.ids) && v.ids.length && Number.isInteger(v.pos) ? v : null
  } catch {
    return null
  }
}

function keepCall(run: CallRun | null) {
  try {
    if (run) sessionStorage.setItem(CALL_KEY, JSON.stringify(run))
    else sessionStorage.removeItem(CALL_KEY)
  } catch {
    // без sessionStorage обзвон просто не переживёт перезагрузку
  }
}

/** Панель отдела персонала */
export function Hr() {
  const navigate = useNavigate()
  const [user, setUser] = useState<HrUser | null>(demoLocal ? localUser : null)
  const [offline, setOffline] = useState(false)

  const onAuthError = useCallback(
    (e: unknown) => {
      if (e instanceof HrUnauthorized) navigate('/hr/login', { replace: true })
      else if (e instanceof ApiUnavailable) setOffline(true)
      else throw e
    },
    [navigate],
  )

  useEffect(() => {
    if (demoLocal) return
    hrMe().then(setUser).catch(onAuthError)
  }, [onAuthError])

  const undo = useCallback(async (ids: number[]) => {
    try {
      const results = await undoAll(ids)
      window.dispatchEvent(new CustomEvent('hr:changed', { detail: results.flatMap((r) => (r.application ? [r.application] : [])) }))
      // Обзвон: отменённый итог звонка больше не считается в «дозвонились N, недозвон M»
      window.dispatchEvent(new CustomEvent('hr:undone', { detail: results.filter((r) => r.ok).map((r) => r.historyId) }))
      const failed = results.find((r) => !r.ok)
      return failed ? (failed.error ?? 'Не получилось') : null
    } catch {
      return 'Нет связи с сервером'
    }
  }, [])

  if (!user) {
    return (
      <HrShell>
        {offline ? <Notice tone="error">Сервер панели сейчас недоступен. Обнови страницу через минуту.</Notice> : <p className="text-white/50">Загружаем панель</p>}
      </HrShell>
    )
  }

  return (
    <ToastProvider onUndo={undo}>
      <Panel user={user} onAuthError={onAuthError} offline={offline} setOffline={setOffline} />
    </ToastProvider>
  )
}

function Panel({
  user,
  onAuthError,
  offline,
  setOffline,
}: {
  user: HrUser
  onAuthError: (e: unknown) => void
  offline: boolean
  setOffline: (v: boolean) => void
}) {
  const navigate = useNavigate()
  const toast = useToast()
  // Подписка на реестр меток: когда он загрузится или изменится, подписи источников в списке и карточке обновятся
  useSourceNames()
  const [params, setParams] = useSearchParams()
  const [apps, setApps] = useState<HrApplication[]>([])
  const [staff, setStaff] = useState<Staff[]>([])
  const [loaded, setLoaded] = useState(false)
  const [intent, setIntent] = useState<CardIntent>(null)
  const known = useRef<Set<string> | null>(null)
  const etag = useRef<string | null>(null)

  const tabIds: TabId[] = ['list', 'schedule', 'funnel', 'dups', 'gaps', ...laterTabs(user.role).map((t) => t.id), 'settings']
  const tab = tabIds.find((t) => t === params.get('tab')) ?? 'list'
  const cardId = params.get('card')

  const setParam = useCallback(
    (key: string, value: string | null) =>
      setParams(
        (p) => {
          const next = new URLSearchParams(p)
          if (value === null) next.delete(key)
          else next.set(key, value)
          return next
        },
        { replace: true },
      ),
    [setParams],
  )

  const setTab = (id: string) => setParams(id === 'list' ? {} : { tab: id }, { replace: true })
  const openCard = useCallback(
    (id: string, why: CardIntent = null) => {
      setIntent(why)
      setParam('card', id)
    },
    [setParam],
  )
  const closeCard = useCallback(() => {
    setIntent(null)
    setParam('card', null)
  }, [setParam])

  const reload = useCallback(
    async (force = false) => {
      try {
        const list = await loadDesk(force ? null : etag.current)
        setOffline(false)
        if (!list) return
        etag.current = list.etag
        // Новые заявки, пока панель открыта, — подсказываем, а не молча подмешиваем
        if (known.current) {
          const fresh = list.rows.filter((a) => !known.current!.has(a.id))
          if (fresh.length) toast({ text: fresh.length === 1 ? `Новая заявка: ${fresh[0].name}` : `Новых заявок: ${fresh.length}` })
        }
        known.current = new Set(list.rows.map((a) => a.id))
        setApps(list.rows)
        setLoaded(true)
      } catch (e) {
        onAuthError(e)
      }
    },
    [onAuthError, setOffline, toast],
  )

  useEffect(() => {
    void reload()
    if (!demoLocal) getStaff().then(setStaff).catch(() => {})
  }, [reload])

  useEffect(() => {
    if (demoLocal) return
    const timer = window.setInterval(() => document.visibilityState === 'visible' && void reload(), POLL_MS)
    const onFocus = () => void reload()
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [reload])

  const replace = useCallback((changed: HrApplication[]) => {
    if (!changed.length) return
    const byId = new Map(changed.map((a) => [a.id, a]))
    setApps((list) => {
      // Обезличенная заявка уходит из списка — её больше нельзя менять
      const next = list.map((a) => byId.get(a.id) ?? a).filter((a) => !a.anonymizedAt)
      for (const a of changed) if (!a.anonymizedAt && !list.some((x) => x.id === a.id)) next.unshift(a)
      return next
    })
    known.current = new Set([...(known.current ?? []), ...changed.map((a) => a.id)])
  }, [])

  // Отмена из всплывающего сообщения обновляет строки через событие
  useEffect(() => {
    const onChanged = (e: Event) => replace((e as CustomEvent<HrApplication[]>).detail)
    window.addEventListener('hr:changed', onChanged)
    return () => window.removeEventListener('hr:changed', onChanged)
  }, [replace])

  /** Смена статуса прямо в строке. Собеседование и отказ требуют деталей — открываем карточку */
  const quickStatus = useCallback(
    async (app: HrApplication, status: ApplicationStatus) => {
      if (status === app.status) return
      if (status === 'interview' || status === 'declined') return openCard(app.id, status)
      try {
        const r = await updateApplication(app.id, { status })
        replace([r.application])
        toast({ text: `${app.name}: ${statusLabel(status)}`, detail: planText(r.notify), undo: r.historyId ? [r.historyId] : undefined })
      } catch (e) {
        if (e instanceof HrUnauthorized) return onAuthError(e)
        // Нет 18 лет или согласия: сервер объясняет, что сделать, — подтвердить можно в карточке
        if (e instanceof ApiValidationError) {
          toast({ text: 'Статус не сменился', detail: e.message, tone: 'error' })
          return openCard(app.id)
        }
        toast({ text: 'Статус не сменился', detail: 'Проверь соединение и попробуй ещё раз', tone: 'error' })
      }
    },
    [openCard, replace, toast, onAuthError],
  )

  // ── Обзвон ──────────────────────────────────────────────────────────
  const [call, setCallState] = useState<CallRun | null>(() => (demoLocal ? null : savedCall()))
  const [summary, setSummary] = useState<ReturnType<typeof callStats> | null>(null)
  // Свежий обзвон — сразу в ref: итог звонка и переход к следующей идут одним нажатием, до перерисовки
  const callRef = useRef(call)
  const setCall = useCallback((run: CallRun | null) => {
    callRef.current = run
    keepCall(run)
    setCallState(run)
  }, [])
  const appsRef = useRef(apps)
  appsRef.current = apps
  /** Строка истории → заявка, где записан итог звонка: «Отменить» убирает итог из счёта обзвона */
  const callHistory = useRef(new Map<number, string>())
  /** Заявку изменили после старта обзвона — пропускаем: её уже ведут */
  const changedSince = useCallback((run: CallRun) => {
    const byId = new Map(appsRef.current.map((a) => [a.id, a]))
    return (id: string) => callChanged(run, id, byId.get(id))
  }, [])

  const beginCall = useCallback(
    (ids: string[]) => {
      if (!ids.length) return
      const run = startCall(ids, appsRef.current)
      callHistory.current.clear()
      setCall(run)
      setSummary(null)
      openCard(run.ids[0])
    },
    [openCard, setCall],
  )
  const finishCall = useCallback(
    (run: CallRun | null = callRef.current) => {
      if (!run) return
      setSummary(callStats(run))
      setCall(null)
      closeCard()
    },
    [closeCard, setCall],
  )
  const callOutcome = useCallback(
    (id: string, outcome: CallOutcome, historyId?: number | null) => {
      const run = callRef.current
      if (!run) return
      if (historyId) callHistory.current.set(historyId, id)
      setCall(recordCall(run, id, outcome))
    },
    [setCall],
  )
  const callNext = useCallback(() => {
    const run = callRef.current
    if (!run) return
    const next = nextCall(run, changedSince(run))
    if (!next) return finishCall({ ...run, skipped: [...new Set([...(run.skipped ?? []), ...run.ids.slice(run.pos + 1)])] })
    setCall(next)
    openCard(next.ids[next.pos])
  }, [changedSince, finishCall, openCard, setCall])
  /** Открытую заявку изменили, пока шёл обзвон (видно по свежей карточке) — пропускаем и говорим об этом */
  const callSkip = useCallback(
    (id: string, name: string) => {
      const run = callRef.current
      if (!run || run.ids[run.pos] !== id) return
      toast({ text: `Пропущена заявка: ${name}`, detail: 'Её уже изменили после начала обзвона, звонить не нужно' })
      const { run: next, done } = skipCall(run, changedSince(run))
      if (done) return finishCall(next)
      setCall(next)
      openCard(next.ids[next.pos])
    },
    [changedSince, finishCall, openCard, setCall, toast],
  )

  // «Отменить» во всплывающем сообщении: итог звонка по этой заявке больше не считается
  useEffect(() => {
    const onUndone = (e: Event) => {
      const run = callRef.current
      if (!run) return
      let next = run
      for (const historyId of (e as CustomEvent<number[]>).detail) {
        const id = callHistory.current.get(historyId)
        if (id) next = forgetCall(next, id)
        callHistory.current.delete(historyId)
      }
      if (next !== run) setCall(next)
    }
    window.addEventListener('hr:undone', onUndone)
    return () => window.removeEventListener('hr:undone', onUndone)
  }, [setCall])

  const callControl: CallControl | null = call
    ? {
        ...callStats(call),
        current: call.ids[call.pos],
        onOutcome: callOutcome,
        onNext: callNext,
        onStop: () => finishCall(),
        onResume: () => openCard(call.ids[call.pos]),
        outcomeOf: (id) => call.outcomes[id],
        changed: (app) => callChanged(call, app.id, app),
        onSkip: callSkip,
      }
    : null

  const logout = async () => {
    await hrLogout()
    navigate('/hr/login', { replace: true })
  }

  const dupGroups = useMemo(() => duplicateGroupCount(apps), [apps])
  // Неразобранные вопросы к Квасычу — число на вкладке, как у дублей: это очередь работы
  const [gaps, setGaps] = useState(0)
  useEffect(() => {
    if (demoLocal) return
    getKbGaps()
      .then((d) => setGaps(d.items.length))
      .catch(() => {})
  }, [tab])
  const tabs: HrTab[] = [
    { id: 'list', label: 'Заявки' },
    ...(demoLocal
      ? []
      : [
          { id: 'schedule', label: 'График' },
          { id: 'funnel', label: 'Воронка' },
          { id: 'dups', label: 'Дубли', count: dupGroups },
          { id: 'gaps', label: 'Вопросы к Квасычу', count: gaps },
          ...laterTabs(user.role),
          ...(user.role === 'admin' ? [{ id: 'settings', label: 'Настройки', more: true }] : []),
        ]),
  ]

  // Название вкладки браузера — по разделу; после входа фокус на заголовок раздела
  useEffect(() => {
    document.title = `${tabs.find((t) => t.id === tab)?.label ?? 'Заявки'} — панель HR «Очаково»`
  }, [tab, tabs])
  const location = useLocation()
  const focused = useRef(false)
  useEffect(() => {
    if (!loaded || focused.current || !(location.state as { fromLogin?: boolean } | null)?.fromLogin) return
    focused.current = true
    const h1 = document.querySelector<HTMLElement>('#hr-main h1')
    if (h1) {
      h1.tabIndex = -1
      h1.focus({ preventScroll: true })
    }
  }, [loaded, location.state])

  return (
    <HrShell tabs={tabs} active={tab} onTab={setTab} user={user} onLogout={demoLocal ? undefined : logout}>
      {offline && (
        <div className="mb-4">
          <Notice tone="error">Связь с&nbsp;сервером пропала. Данные могут быть неактуальны, обновим их, как только связь вернётся.</Notice>
        </div>
      )}
      {demoLocal && (
        <div className="mb-4">
          <Notice>Демо без сервера: заявки хранятся только в&nbsp;этом браузере, статусы менять нельзя.</Notice>
        </div>
      )}

      {tab === 'list' && (
        <Candidates
          apps={apps}
          loaded={loaded}
          me={user}
          staff={staff}
          onOpen={openCard}
          onStatus={quickStatus}
          onChanged={replace}
          onImported={() => void reload(true)}
          readOnly={demoLocal}
          call={callControl}
          onStartCall={beginCall}
        />
      )}
      {tab === 'schedule' && <ScheduleView apps={apps} onOpen={openCard} onChanged={replace} />}
      {tab === 'funnel' && <FunnelView apps={apps} onSource={(source) => setParams({ source }, { replace: true })} />}
      {tab === 'dups' && <DuplicatesView onOpen={openCard} onChanged={() => void reload(true)} />}
      {tab === 'gaps' && <KbGapsView />}
      {tab === 'sources' && <SourcesView user={user} />}
      {tab === 'focus' && <FocusView user={user} />}
      {tab === 'bots' && <BotsView user={user} />}
      {tab === 'broadcast' && <BroadcastView user={user} />}
      {tab === 'settings' && user.role === 'admin' && <SettingsView me={user} onDataChanged={() => void reload(true)} />}

      {!demoLocal && (
        <CandidateDrawer
          id={cardId}
          intent={intent}
          me={user}
          staff={staff}
          onClose={closeCard}
          onChange={(a) => replace([a])}
          onOpen={(id) => openCard(id)}
          apps={apps}
          call={callControl}
        />
      )}

      <Dialog open={summary !== null} title="Обзвон закончен" onClose={() => setSummary(null)}>
        {summary && (
          <>
            <p className="text-[17px]" role="status">
              Дозвонились {summary.reached}, недозвон {summary.missed}
              {summary.skipped > 0 ? `, пропущено ${summary.skipped}` : ''}
              {summary.total - summary.reached - summary.missed - summary.skipped > 0 ? `, без звонка ${summary.total - summary.reached - summary.missed - summary.skipped}` : ''}.
            </p>
            {summary.skipped > 0 && <p className="mt-2 text-[15px] text-white/65">Пропущенные заявки изменили после начала обзвона: их уже ведут.</p>}
            <p className="mt-2 text-[15px] text-white/65">
              Открыто {summary.position} из {plural(summary.total, 'заявки', 'заявок', 'заявок')}. Итог каждого звонка записан в истории заявки.
            </p>
            <button onClick={() => setSummary(null)} className={`${hrBtn.red} mt-6 w-full sm:w-fit`}>
              Готово
            </button>
          </>
        )}
      </Dialog>
    </HrShell>
  )
}
