import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { HrShell } from '../components/hr/HrShell'
import { plural } from '../components/hr/hrUtils'
import { HrInput, HrLabel, hrBtn, Notice } from '../components/hr/ui'
import { ApiUnavailable, ApiValidationError, hrLogout, HrUnauthorized } from '../lib/api'
import { changeMyPassword, login, myAccount, passwordHint } from '../lib/hr/admin'
import { nb } from '../lib/typo'

/** «через 5 секунд», «через 2 мин» */
const after = (sec: number) => `через ${sec < 60 ? plural(sec, 'секунду', 'секунды', 'секунд') : `${Math.ceil(sec / 60)} мин`}`

/** Секунды до следующей попытки входа: тикает раз в секунду, пока не дойдёт до нуля */
function useCountdown() {
  const [left, setLeft] = useState(0)
  useEffect(() => {
    if (left <= 0) return
    const t = window.setTimeout(() => setLeft((s) => Math.max(0, s - 1)), 1000)
    return () => window.clearTimeout(t)
  }, [left])
  return [left, setLeft] as const
}

/**
 * Вход в панель отдела персонала. Если пароль задал администратор (новый сотрудник или сброс),
 * после входа — второй шаг: свой пароль. Без него панель не откроется: сервер отвечает 401 password_change_required
 */
/**
 * Стенд для жюри antihype.best: вход открыт, он же написан в README и на странице материалов. Подсказка с кнопкой
 * «Подставить» видна только на этом адресе: на сайте компании и в разработке её нет
 */
const JURY = typeof window !== 'undefined' && window.location.hostname === 'antihype.best' ? { email: 'jury@antihype.best', password: 'jury-antihype' } : null

export function HrLogin() {
  const navigate = useNavigate()
  const [step, setStep] = useState<'checking' | 'login' | 'change'>('checking')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const [wait, setWait] = useCountdown()
  /** Пароль, с которым только что вошли: на шаге смены его не нужно вводить второй раз */
  const [current, setCurrent] = useState<string | null>(null)

  useEffect(() => {
    document.title = 'Вход для HR — «Очаково»'
  }, [])

  // Уже вошли: панель — сразу; пароль нужно сменить (панель отправила сюда) — форма нового пароля
  useEffect(() => {
    let alive = true
    myAccount()
      .then((a) => {
        if (!alive) return
        if (!a.user) setStep('login')
        else if (a.mustChangePassword) setStep('change')
        else navigate('/hr', { replace: true })
      })
      .catch(() => alive && setStep('login'))
    return () => {
      alive = false
    }
  }, [navigate])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (wait > 0) return
    setError('')
    setSending(true)
    try {
      const r = await login(email, password)
      if (!r.ok) {
        setWait(r.retryAfter)
        if (r.reason === 'rate_limited') setError(`Слишком много попыток. Попробуй ${after(r.retryAfter)}.`)
        else setError(r.retryAfter ? `Почта или пароль не подходят. Следующая попытка ${after(r.retryAfter)}.` : 'Почта или пароль не подходят.')
        return
      }
      const account = await myAccount().catch(() => null)
      if (account?.mustChangePassword) {
        setCurrent(password)
        setPassword('')
        setStep('change')
        return
      }
      navigate('/hr', { replace: true, state: { fromLogin: true } })
    } catch (err) {
      if (err instanceof ApiUnavailable) setError('Сервер сейчас недоступен. Попробуй через минуту.')
      else setError('Не получилось войти. Попробуй ещё раз.')
    } finally {
      setSending(false)
    }
  }

  return (
    <HrShell>
      <div className="mx-auto grid min-h-[calc(100dvh-140px)] max-w-5xl content-center gap-12 md:grid-cols-2">
        <div>
          <p className="text-[13px] tracking-[0.14em] text-white/50 uppercase">Отдел персонала</p>
          {step === 'change' ? (
            <h1 className="mt-4 font-display text-[clamp(56px,8vw,120px)] leading-[0.8] font-black uppercase">
              Свой
              <br />
              <span className="text-brand">пароль</span>
            </h1>
          ) : (
            <h1 className="mt-4 font-display text-[clamp(64px,9vw,140px)] leading-[0.8] font-black uppercase">
              Вход
              <br />
              <span className="text-brand">для HR</span>
            </h1>
          )}
          <p className="mt-8 max-w-md text-[17px] text-white/60">
            {nb(
              step === 'change'
                ? 'Пароль для первого входа задал администратор. Задай свой: его будешь знать только ты, а прежний перестанет работать.'
                : 'Заявки кандидатов, собеседования, сообщения в ботах и воронка по источникам. Доступ выдаёт администратор панели.',
            )}
          </p>
        </div>

        {step === 'checking' && <p className="self-end text-white/50">Проверяем вход</p>}

        {step === 'login' && (
          <form onSubmit={submit} className="flex max-w-md flex-col gap-8 self-end" noValidate>
            <div>
              <HrLabel htmlFor="hr-email">Рабочая почта</HrLabel>
              <HrInput id="hr-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div>
              <HrLabel htmlFor="hr-password">Пароль</HrLabel>
              <HrInput id="hr-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
            {error && <Notice tone="error">{nb(error)}</Notice>}
            <button type="submit" className={`${hrBtn.red} w-full sm:w-fit`} disabled={sending || !email || !password || wait > 0}>
              {sending ? 'Входим' : wait > 0 ? `Войти · ${wait} с` : 'Войти'}
            </button>
            <p className="text-[15px] text-white/55">Не помнишь пароль? Новый задаст администратор панели.</p>
            {JURY && (
              <div className="border-t border-white/15 pt-5 text-[15px] leading-relaxed text-white/75">
                <p>
                  Вход для жюри: почта <b className="font-semibold text-white">{JURY.email}</b>, пароль <b className="font-semibold text-white">{JURY.password}</b>
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setEmail(JURY.email)
                    setPassword(JURY.password)
                  }}
                  className="mt-2 py-2 font-semibold text-white underline decoration-white/50 underline-offset-4 hover:decoration-white"
                >
                  Подставить
                </button>
              </div>
            )}
          </form>
        )}

        {step === 'change' && (
          <ChangePassword
            current={current}
            onDone={() => navigate('/hr', { replace: true, state: { fromLogin: true } })}
            onLogout={async () => {
              await hrLogout()
              setCurrent(null)
              setStep('login')
            }}
          />
        )}
      </div>
    </HrShell>
  )
}

/** Свой пароль вместо временного: новый дважды; текущий — если вошли не только что */
function ChangePassword({ current, onDone, onLogout }: { current: string | null; onDone: () => void; onLogout: () => void }) {
  const [old, setOld] = useState('')
  const [next, setNext] = useState('')
  const [repeat, setRepeat] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [sending, setSending] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const found: Record<string, string> = {}
    if (current === null && !old) found.currentPassword = 'Введи пароль, который выдал администратор'
    const hint = passwordHint(next)
    if (hint) found.newPassword = hint
    else if (next !== repeat) found.repeat = 'Пароли не совпадают'
    setErrors(found)
    if (Object.keys(found).length) return
    setSending(true)
    try {
      await changeMyPassword(current ?? old, next)
      onDone()
    } catch (err) {
      if (err instanceof ApiValidationError) setErrors(err.errors)
      else if (err instanceof HrUnauthorized) setErrors({ form: 'Вход истёк. Войди снова с паролем от администратора.' })
      else if (err instanceof ApiUnavailable) setErrors({ form: 'Сервер сейчас недоступен. Попробуй через минуту.' })
      else setErrors({ form: 'Не получилось сохранить. Попробуй ещё раз через минуту.' })
    } finally {
      setSending(false)
    }
  }

  const field = (id: string, key: string, label: string, value: string, set: (v: string) => void, auto: string) => (
    <div>
      <HrLabel htmlFor={id}>{label}</HrLabel>
      <HrInput
        id={id}
        type="password"
        autoComplete={auto}
        value={value}
        onChange={(e) => set(e.target.value)}
        aria-invalid={Boolean(errors[key])}
        aria-describedby={errors[key] ? `${id}-error` : undefined}
      />
      {errors[key] && (
        <p id={`${id}-error`} className="mt-2 text-[14px] text-brand-bright">
          {errors[key]}
        </p>
      )}
    </div>
  )

  return (
    <form onSubmit={submit} className="flex max-w-md flex-col gap-7 self-end" noValidate>
      {current === null && field('hr-current', 'currentPassword', 'Пароль от администратора', old, setOld, 'current-password')}
      {field('hr-new', 'newPassword', 'Новый пароль', next, setNext, 'new-password')}
      {field('hr-repeat', 'repeat', 'Новый пароль ещё раз', repeat, setRepeat, 'new-password')}
      <p className="-mt-2 text-[14px] text-white/55">{nb('Не короче 10 символов. Удобно взять три-четыре слова через дефис: длина защищает лучше спецсимволов.')}</p>
      {errors.form && <Notice tone="error">{errors.form}</Notice>}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <button type="submit" className={`${hrBtn.red} w-full sm:w-fit`} disabled={sending || !next || !repeat}>
          {sending ? 'Сохраняем' : 'Сохранить и войти'}
        </button>
        <button type="button" onClick={onLogout} className="text-[15px] text-white/60 underline-offset-4 hover:text-white hover:underline">
          Выйти
        </button>
      </div>
    </form>
  )
}
