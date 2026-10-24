import { useEffect, useState, type FormEvent } from 'react'
import { ApiValidationError, HrUnauthorized, type HrUser } from '../../lib/api'
import { nb } from '../../lib/typo'
import {
  changeMyPassword,
  createAccount,
  listAccounts,
  passwordHint,
  resetAccountPassword,
  setAssignQueue,
  temporaryPassword,
  updateAccount,
  type AssignQueue,
  type HrAccount,
} from '../../lib/hr/admin'
import { formatDate, plural } from './hrUtils'
import { Dialog } from './overlay'
import { useToast } from './toasts'
import { chip, copyText, HrInput, HrLabel, hrBtn, Notice } from './ui'

const roleName = { hr: 'HR', admin: 'Администратор' } as const
const small = `${hrBtn.small} text-white ring-1 ring-white/30 ring-inset hover:ring-white`

/** Первая ошибка из ответа сервера — для всплывающего сообщения */
const firstError = (e: unknown) => (e instanceof ApiValidationError ? (Object.values(e.errors)[0] ?? e.message) : (e as Error)?.message || 'Не получилось. Попробуй ещё раз.')

/**
 * Сотрудники панели: завести с временным паролем, выключить, сменить роль, сбросить пароль, раздача заявок по очереди.
 * Только для администратора. Временный пароль при входе нужно сменить — это проверяет сервер
 */
export function UsersView({ me }: { me: HrUser }) {
  const toast = useToast()
  const [users, setUsers] = useState<HrAccount[] | null>(null)
  const [queue, setQueue] = useState<AssignQueue | null>(null)
  const [failed, setFailed] = useState(false)
  const [reset, setReset] = useState<HrAccount | null>(null)
  const [own, setOwn] = useState(false)

  const load = () =>
    listAccounts()
      .then((r) => {
        setUsers(r.users)
        setQueue(r.queue)
        setFailed(false)
      })
      .catch(() => setFailed(true))
  useEffect(() => {
    void load()
  }, [])

  const patch = async (u: HrAccount, change: Parameters<typeof updateAccount>[1], done: string) => {
    try {
      await updateAccount(u.id, change)
      toast({ text: done })
      void load()
    } catch (e) {
      toast({ text: 'Не сохранилось', detail: firstError(e), tone: 'error' })
    }
  }

  // Переключатель меняется сразу, ответ сервера уточняет строку состояния; не сохранилось — возвращаем как было
  const toggleQueue = async (enabled: boolean) => {
    const before = queue
    if (before) setQueue({ ...before, enabled })
    try {
      setQueue(await setAssignQueue(enabled))
      toast({ text: enabled ? 'Новые заявки раздаются по очереди' : 'Раздача по очереди выключена' })
    } catch (e) {
      setQueue(before)
      toast({ text: 'Не сохранилось', detail: firstError(e), tone: 'error' })
    }
  }

  return (
    <section aria-labelledby="users-title" className="grid gap-14 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-20">
      <div className="min-w-0">
        <h2 id="users-title" className="sr-only">
          Сотрудники
        </h2>
        {failed && <Notice tone="error">Список не загрузился. Обнови страницу.</Notice>}
        {queue && <QueueCard queue={queue} onToggle={toggleQueue} />}
        <ul className="mt-8 border-t border-white/15">
          {(users ?? []).map((u) => (
            <li key={u.id} className={`flex flex-col gap-4 border-b border-white/15 py-5 sm:flex-row sm:items-start sm:justify-between ${u.disabled ? 'opacity-55' : ''}`}>
              <div className="min-w-0">
                <p className="text-[17px] font-medium">
                  {u.name}
                  {u.id === me.id && <span className="text-white/55"> · это ты</span>}
                </p>
                <p className="text-[14px] break-all text-white/50">{u.email}</p>
                <p className="mt-1 text-[13px] text-white/60">
                  {roleName[u.role]}
                  {u.disabled ? ' · доступ выключен' : u.lastLoginAt ? ` · последний вход ${formatDate(u.lastLoginAt)}` : ' · входа ещё не было'}
                  {!u.disabled && (u.inQueue ? ' · получает заявки по очереди' : ' · не в очереди')}
                </p>
                {u.mustChangePassword && !u.disabled && <p className="mt-1 text-[13px] text-periwinkle">{nb('Пароль временный: при входе нужно задать свой')}</p>}
              </div>
              <div className="flex shrink-0 flex-wrap gap-2 sm:max-w-[300px] sm:justify-end">
                {u.id === me.id ? (
                  <button onClick={() => setOwn(true)} className={small}>
                    Сменить пароль
                  </button>
                ) : (
                  <>
                    {!u.disabled && (
                      <button
                        onClick={() => void patch(u, { inQueue: !u.inQueue }, u.inQueue ? `${u.name}: больше не получает заявки по очереди` : `${u.name}: получает заявки по очереди`)}
                        aria-pressed={u.inQueue}
                        className={small}
                      >
                        {u.inQueue ? 'Убрать из очереди' : 'В очередь'}
                      </button>
                    )}
                    <button onClick={() => void patch(u, { role: u.role === 'admin' ? 'hr' : 'admin' }, `${u.name}: роль изменена`)} className={small}>
                      {u.role === 'admin' ? 'Сделать HR' : 'Сделать админом'}
                    </button>
                    {!u.disabled && (
                      <button onClick={() => setReset(u)} className={small}>
                        Сбросить пароль
                      </button>
                    )}
                    <button
                      onClick={() => void patch(u, { disabled: !u.disabled }, u.disabled ? `${u.name} снова может входить` : `${u.name} больше не может входить`)}
                      className={`${hrBtn.small} ring-1 ring-inset ${u.disabled ? 'text-white ring-white/30 hover:ring-white' : 'text-brand-bright ring-brand/60 hover:ring-brand'}`}
                    >
                      {u.disabled ? 'Включить' : 'Выключить'}
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
      <NewUser onCreated={() => void load()} />
      <ResetPassword user={reset} onClose={() => setReset(null)} onDone={() => void load()} />
      <OwnPassword open={own} onClose={() => setOwn(false)} />
    </section>
  )
}

/** Переключатель раздачи по очереди и строка состояния: кто следующий, сколько в очереди, сколько раздано */
function QueueCard({ queue, onToggle }: { queue: AssignQueue; onToggle: (on: boolean) => void }) {
  const status = !queue.enabled
    ? 'Выключено: новые заявки с сайта и из ботов приходят без ответственного.'
    : !queue.next
      ? 'Включено, но в очереди никого: нажми «В очередь» у сотрудников ниже.'
      : `Включено. Следующую заявку получит ${queue.next.name}. В очереди ${plural(queue.members.length, 'сотрудник', 'сотрудника', 'сотрудников')}, раздано ${plural(queue.assigned, 'заявка', 'заявки', 'заявок')}.`
  return (
    <div className="flex flex-col gap-3 border-t-[3px] border-double border-white/60 pt-4">
      <label className="flex cursor-pointer items-start justify-between gap-5">
        <span>
          <span className="block font-display text-[22px] leading-none font-black uppercase">Раздавать новые заявки по очереди</span>
          <span className="mt-2 block max-w-xl text-[14px] leading-snug text-white/65">
            Заявке с&nbsp;сайта или из&nbsp;бота без ответственного назначается следующий сотрудник по&nbsp;кругу. Добавленные вручную и&nbsp;загруженные из&nbsp;файла
            остаются у&nbsp;того, кого выбрали при добавлении.
          </span>
        </span>
        <input
          type="checkbox"
          role="switch"
          checked={queue.enabled}
          onChange={(e) => onToggle(e.target.checked)}
          className="peer sr-only"
          aria-describedby="queue-status"
        />
        <span
          aria-hidden="true"
          className={`relative mt-1 h-7 w-12 shrink-0 rounded-full ring-1 ring-inset transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand-bright ${
            queue.enabled ? 'bg-leaf ring-leaf' : 'bg-white/[0.06] ring-white/35'
          }`}
        >
          <span className={`absolute top-1 size-5 rounded-full bg-white transition-[left] duration-200 motion-reduce:transition-none ${queue.enabled ? 'left-6' : 'left-1'}`} />
        </span>
      </label>
      <p id="queue-status" role="status" className={`text-[15px] ${queue.enabled && queue.next ? 'text-white' : 'text-white/65'}`}>
        {nb(status)}
      </p>
    </div>
  )
}

function NewUser({ onCreated }: { onCreated: () => void }) {
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'hr' as 'hr' | 'admin' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [done, setDone] = useState<{ name: string; email: string; password: string } | null>(null)
  const [sending, setSending] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setErrors({})
    setDone(null)
    setSending(true)
    try {
      const u = await createAccount(form)
      setDone({ name: u.name, email: u.email, password: form.password })
      setForm({ name: '', email: '', password: '', role: 'hr' })
      onCreated()
    } catch (err) {
      setErrors(err instanceof ApiValidationError ? err.errors : { form: 'Не получилось. Попробуй ещё раз.' })
    } finally {
      setSending(false)
    }
  }

  const field = (key: 'name' | 'email', label: string, type = 'text', auto = 'off') => (
    <div>
      <HrLabel htmlFor={`new-${key}`}>{label}</HrLabel>
      <HrInput
        id={`new-${key}`}
        type={type}
        autoComplete={auto}
        value={form[key]}
        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
        aria-invalid={Boolean(errors[key])}
        aria-describedby={errors[key] ? `new-${key}-error` : undefined}
      />
      {errors[key] && (
        <p id={`new-${key}-error`} className="mt-2 text-[14px] text-brand-bright">
          {errors[key]}
        </p>
      )}
    </div>
  )

  return (
    <form onSubmit={submit} className="flex min-w-0 flex-col gap-5 self-start border-t-[3px] border-double border-white/60 pt-4" noValidate>
      <h3 className="font-display text-[24px] leading-none font-black uppercase">Новый сотрудник</h3>
      {field('name', 'Имя')}
      {field('email', 'Рабочая почта', 'email')}
      <div>
        <HrLabel htmlFor="new-password">Временный пароль</HrLabel>
        <div className="flex items-end gap-3">
          <HrInput
            id="new-password"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={form.password}
            onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
            aria-invalid={Boolean(errors.password)}
            aria-describedby={errors.password ? 'new-password-error' : 'new-password-hint'}
            className="font-mono"
          />
          <button type="button" onClick={() => setForm((f) => ({ ...f, password: temporaryPassword() }))} className={`${small} shrink-0`}>
            Придумать
          </button>
        </div>
        {errors.password ? (
          <p id="new-password-error" className="mt-2 text-[14px] text-brand-bright">
            {errors.password}
          </p>
        ) : (
          <p id="new-password-hint" className="mt-2 text-[13px] text-white/55">
            От 10 символов. При первом входе сотрудник задаст свой.
          </p>
        )}
      </div>
      <fieldset className="flex gap-2">
        <legend className="mb-3 font-display text-[16px] font-extrabold tracking-[0.06em] text-white/50 uppercase">Роль</legend>
        {(['hr', 'admin'] as const).map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => setForm((f) => ({ ...f, role: r }))}
            aria-pressed={form.role === r}
            className={chip(form.role === r)}
          >
            {roleName[r]}
          </button>
        ))}
      </fieldset>
      <p className="text-[14px] text-white/55">
        Администратор ещё заводит сотрудников, правит тексты уведомлений, вакансии и&nbsp;рабочее время, подключает интеграции и&nbsp;видит журналы удалений и&nbsp;выгрузок.
      </p>
      {errors.form && <Notice tone="error">{errors.form}</Notice>}
      {done && <CreatedNotice {...done} />}
      <button type="submit" disabled={sending} className={`${hrBtn.red} w-full sm:w-fit`}>
        {sending ? 'Добавляем' : 'Добавить'}
      </button>
    </form>
  )
}

/** Почта и временный пароль после заведения: показываются один раз, передать лично */
function CreatedNotice({ name, email, password }: { name: string; email: string; password: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div role="status" className="flex flex-col gap-2 border-l-2 border-leaf bg-leaf/[0.07] py-3 pr-3 pl-4 text-[15px]">
      <p>{name} может входить. Передай почту и&nbsp;пароль лично, в&nbsp;общий чат их&nbsp;не&nbsp;пиши.</p>
      <p className="font-mono text-[15px] break-all text-white">
        {email}
        <br />
        {password}
      </p>
      <button
        type="button"
        onClick={async () => setCopied(await copyText(`${email}\n${password}`))}
        className={`${small} w-fit`}
      >
        {copied ? 'Скопировано' : 'Скопировать'}
      </button>
    </div>
  )
}

/** Сброс пароля: окно вместо системного запроса. Все входы сотрудника закрываются */
function ResetPassword({ user, onClose, onDone }: { user: HrAccount | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState<{ email: string; password: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [sending, setSending] = useState(false)

  useEffect(() => {
    setPassword(user ? temporaryPassword() : '')
    setError('')
    setDone(null)
    setCopied(false)
  }, [user])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!user) return
    const hint = passwordHint(password)
    if (hint) return setError(hint)
    setSending(true)
    try {
      await resetAccountPassword(user.id, password)
      setDone({ email: user.email, password })
      toast({ text: `${user.name}: пароль сброшен, входы закрыты` })
      onDone()
    } catch (err) {
      setError(firstError(err))
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog open={Boolean(user)} title="Сброс пароля" onClose={onClose}>
      {user && !done && (
        <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
          <p className="text-[15px] leading-snug text-white/75">
            {user.name}, {user.email}. Все входы сотрудника закроются. При входе с&nbsp;новым паролем панель попросит задать свой.
          </p>
          <div>
            <HrLabel htmlFor="reset-password">Временный пароль</HrLabel>
            <div className="flex items-end gap-3">
              <HrInput
                id="reset-password"
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? 'reset-password-error' : undefined}
                className="font-mono"
              />
              <button type="button" onClick={() => setPassword(temporaryPassword())} className={`${small} shrink-0`}>
                Другой
              </button>
            </div>
            {error && (
              <p id="reset-password-error" className="mt-2 text-[14px] text-brand-bright">
                {error}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-3">
            <button type="submit" disabled={sending} className={hrBtn.red}>
              {sending ? 'Сбрасываем' : 'Сбросить пароль'}
            </button>
            <button type="button" onClick={onClose} className={hrBtn.ghost}>
              Отмена
            </button>
          </div>
        </form>
      )}
      {done && (
        <div className="flex flex-col gap-4">
          <p className="text-[15px] leading-snug text-white/75">Передай почту и&nbsp;пароль лично, в&nbsp;общий чат их&nbsp;не&nbsp;пиши. Больше пароль нигде не&nbsp;покажется.</p>
          <p className="bg-white/[0.06] p-3 font-mono text-[16px] break-all">
            {done.email}
            <br />
            {done.password}
          </p>
          <div className="flex flex-wrap gap-3">
            <button type="button" onClick={async () => setCopied(await copyText(`${done.email}\n${done.password}`))} className={hrBtn.ghost}>
              {copied ? 'Скопировано' : 'Скопировать'}
            </button>
            <button type="button" onClick={onClose} className={hrBtn.red}>
              Готово
            </button>
          </div>
        </div>
      )}
    </Dialog>
  )
}

/** Свой пароль из панели: текущий и новый дважды. Остальные входы закрываются */
function OwnPassword({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast()
  const [form, setForm] = useState({ current: '', next: '', repeat: '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [sending, setSending] = useState(false)

  useEffect(() => {
    if (!open) {
      setForm({ current: '', next: '', repeat: '' })
      setErrors({})
    }
  }, [open])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const found: Record<string, string> = {}
    if (!form.current) found.currentPassword = 'Введи текущий пароль'
    const hint = passwordHint(form.next)
    if (hint) found.newPassword = hint
    else if (form.next !== form.repeat) found.repeat = 'Пароли не совпадают'
    setErrors(found)
    if (Object.keys(found).length) return
    setSending(true)
    try {
      await changeMyPassword(form.current, form.next)
      toast({ text: 'Пароль сменён', detail: 'Другие входы закрыты, этот остался' })
      onClose()
    } catch (err) {
      if (err instanceof ApiValidationError) setErrors(err.errors)
      else setErrors({ form: err instanceof HrUnauthorized ? 'Вход истёк. Войди снова.' : firstError(err) })
    } finally {
      setSending(false)
    }
  }

  const field = (key: 'current' | 'next' | 'repeat', errKey: string, label: string, auto: string) => (
    <div>
      <HrLabel htmlFor={`own-${key}`}>{label}</HrLabel>
      <HrInput
        id={`own-${key}`}
        type="password"
        autoComplete={auto}
        value={form[key]}
        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
        aria-invalid={Boolean(errors[errKey])}
        aria-describedby={errors[errKey] ? `own-${key}-error` : undefined}
      />
      {errors[errKey] && (
        <p id={`own-${key}-error`} className="mt-2 text-[14px] text-brand-bright">
          {errors[errKey]}
        </p>
      )}
    </div>
  )

  return (
    <Dialog open={open} title="Сменить пароль" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
        {field('current', 'currentPassword', 'Текущий пароль', 'current-password')}
        {field('next', 'newPassword', 'Новый пароль', 'new-password')}
        {field('repeat', 'repeat', 'Новый пароль ещё раз', 'new-password')}
        <p className="text-[13px] text-white/55">Не короче 10 символов. Другие входы в&nbsp;панель закроются, этот останется.</p>
        {errors.form && <Notice tone="error">{errors.form}</Notice>}
        <div className="flex flex-wrap gap-3">
          <button type="submit" disabled={sending} className={hrBtn.red}>
            {sending ? 'Сохраняем' : 'Сохранить'}
          </button>
          <button type="button" onClick={onClose} className={hrBtn.ghost}>
            Отмена
          </button>
        </div>
      </form>
    </Dialog>
  )
}
