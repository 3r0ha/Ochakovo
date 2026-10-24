import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { workSettingsProblem, type WorkSettings } from '@shared/workdays'
import {
  checkYandexDisk,
  clearApplications,
  getIntegrations,
  hrDemoTools,
  hrWork,
  saveWorkSettings,
  seedDemoApplications,
  setDiskSnapshots,
  syncYandexDisk,
  type DiskStatus,
  type HrUser,
  type SmsStatus,
  getRetention,
  runRetentionNow,
  getHh,
  hhVacancyAction,
  hhResponses,
  commitImport,
  type HhAction,
  type RetentionEntry,
} from '../../lib/api'
import { accessLog, adminState, type AccessRow, type AdminState } from '../../lib/hr/admin'
import { TemplatesView } from './TemplatesView'
import { useToast } from './toasts'
import { chip, hrBtn, Notice, pageTitle } from './ui'
import { plural } from './hrUtils'
import { UsersView } from './UsersView'
import { VacanciesView } from './VacanciesView'

const sections = [
  { id: 'users', label: 'Сотрудники' },
  { id: 'vacancies', label: 'Вакансии' },
  { id: 'templates', label: 'Уведомления' },
  { id: 'integrations', label: 'Интеграции' },
  { id: 'work', label: 'Рабочее время' },
  { id: 'data', label: 'Данные' },
  { id: 'state', label: 'Состояние' },
] as const

/** Раздел администратора: сотрудники, вакансии, тексты уведомлений, интеграции, демо-данные и очистка, состояние сервера */
export function SettingsView({ me, onDataChanged }: { me: HrUser; onDataChanged: () => void }) {
  const [params, setParams] = useSearchParams()
  const section = sections.find((s) => s.id === params.get('section'))?.id ?? 'users'
  return (
    <section aria-labelledby="settings-title">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <h1 id="settings-title" className={pageTitle}>
          Настройки
        </h1>
        <div className="flex flex-wrap gap-2">
          {sections.map((s) => (
            <button key={s.id} onClick={() => setParams({ tab: 'settings', section: s.id }, { replace: true })} aria-pressed={section === s.id} className={chip(section === s.id)}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-6">
        {section === 'users' && <UsersView me={me} />}
        {section === 'vacancies' && <VacanciesView />}
        {section === 'templates' && <TemplatesView />}
        {section === 'integrations' && <Integrations />}
        {section === 'work' && <WorkSection />}
        {section === 'data' && <DataSection onChanged={onDataChanged} />}
        {section === 'state' && <StateSection />}
      </div>
    </section>
  )
}

const ago = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }) : '—')
const size = (b: number | null) => (b == null ? '—' : b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} КБ` : `${(b / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`)

function Integrations() {
  const toast = useToast()
  const [disk, setDisk] = useState<DiskStatus | null>(null)
  const [sms, setSms] = useState<SmsStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    getIntegrations()
      .then((r) => {
        setDisk(r.yandexDisk)
        setSms(r.sms)
      })
      .catch(() => setError(true))
  }, [])

  const sync = async () => {
    setBusy(true)
    try {
      const r = await syncYandexDisk()
      setDisk(r.status)
      toast(r.result.ok ? { text: 'Заявки выгружены на Диск', detail: `${r.result.rows} заявок, ${size(r.result.bytes)}` } : { text: 'Не выгрузилось', detail: r.result.error, tone: 'error' })
    } catch {
      toast({ text: 'Сервер не ответил', tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const check = async () => {
    setBusy(true)
    try {
      const r = await checkYandexDisk()
      toast(r.ok ? { text: 'Диск на связи', detail: `${r.user ? `${r.user} · ` : ''}свободно ${size(r.total - r.used)}` } : { text: 'Диск не отвечает', detail: r.error, tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  if (error) return <Notice tone="error">Не удалось загрузить состояние интеграций.</Notice>
  if (!disk) return <p className="text-white/50">Загружаем</p>

  return (
    <div className="grid gap-10 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <article className="flex flex-col gap-5 border-t-[3px] border-double border-white/60 pt-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="font-display text-[28px] leading-none font-black uppercase">Яндекс Диск</h2>
          <span className={`text-[14px] ${disk.configured ? (disk.lastError ? 'text-brand-bright' : 'text-leaf') : 'text-white/50'}`}>
            {disk.configured ? (disk.lastError ? 'Ошибка выгрузки' : 'Подключён') : 'Не подключён'}
          </span>
        </div>
        <p className="text-[15px] leading-snug text-white/65">
          Файл «Заявки.xlsx» со&nbsp;всеми заявками и&nbsp;листом «Воронка» перезаписывается в&nbsp;папке компании {disk.intervalMinutes ? `раз в ${disk.intervalMinutes} мин` : 'только по кнопке'}. Его
          можно открыть в&nbsp;Яндекс Документах. Публичные ссылки панель не&nbsp;создаёт.
        </p>

        {disk.configured ? (
          <>
            <dl className="grid grid-cols-[minmax(0,170px)_1fr] gap-x-5 gap-y-2 text-[15px]">
              <dt className="text-white/55">Папка</dt>
              <dd className="break-all">{disk.root}</dd>
              <dt className="text-white/55">Последняя выгрузка</dt>
              <dd>
                {ago(disk.lastOkAt)}
                {disk.lastRows != null ? ` · ${disk.lastRows} заявок · ${size(disk.lastBytes)}` : ''}
              </dd>
              <dt className="text-white/55">Последняя попытка</dt>
              <dd>{ago(disk.lastAttemptAt)}</dd>
              <dt className="text-white/55">Токен</dt>
              <dd>{disk.canRefresh ? 'обновляется сам' : 'постоянный: когда истечёт, нужен новый'}</dd>
            </dl>
            {disk.lastError && <Notice tone="error">{disk.lastError}</Notice>}
            <label className="inline-flex cursor-pointer items-center gap-2.5 text-[15px] text-white/80">
              <input
                type="checkbox"
                checked={disk.snapshots}
                onChange={async (e) => setDisk(await setDiskSnapshots(e.target.checked))}
                className="size-4 accent-[var(--color-brand)]"
              />
              Ещё хранить копию за каждый день в&nbsp;папке «Архив»
            </label>
            <div className="flex flex-wrap gap-3">
              <button onClick={() => void sync()} disabled={busy} className={hrBtn.red}>
                {busy ? 'Выгружаем' : 'Выгрузить сейчас'}
              </button>
              <button onClick={() => void check()} disabled={busy} className={hrBtn.ghost}>
                Проверить подключение
              </button>
            </div>
          </>
        ) : (
          <div className="flex flex-col gap-3 text-[15px] leading-snug text-white/70">
            <p>Чтобы подключить, администратор сервера задаёт переменные окружения и перезапускает сервер:</p>
            <ul className="flex flex-col gap-1.5 font-mono text-[13px] text-white/85">
              <li>YANDEX_DISK_TOKEN: OAuth-токен приложения с правом записи на Диск</li>
              <li>YANDEX_DISK_ROOT: папка disk:/Очаково HR или на общем диске vd:&lt;id&gt;:disk:/Очаково HR</li>
              <li>YANDEX_DISK_SYNC_MINUTES: как часто выгружать, по умолчанию 60</li>
              <li>YANDEX_DISK_REFRESH_TOKEN, YANDEX_CLIENT_ID, YANDEX_CLIENT_SECRET: чтобы токен обновлялся сам</li>
            </ul>
            <p>Пошаговая инструкция лежит в docs/hr.md.</p>
          </div>
        )}
      </article>

      <aside className="flex flex-col gap-3 self-start border-l-2 border-periwinkle bg-periwinkle/[0.06] p-4 text-[14px] leading-snug text-white/75">
        <p className="font-display text-[20px] leading-none font-black text-white uppercase">Персональные данные</p>
        <p>
          В выгрузке есть имена и телефоны кандидатов. Храни её только на корпоративном Диске организации в&nbsp;Яндекс 360 для бизнеса: там есть договор поручения
          обработки персональных данных и&nbsp;хранение в&nbsp;России. Личный Диск сотрудника для этого не&nbsp;подходит.
        </p>
        <p>Доступ к папке давай только отделу персонала. Ссылки «для всех» на файл не открывай.</p>
      </aside>

      <article className="flex flex-col gap-4 border-t-[3px] border-double border-white/60 pt-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="font-display text-[28px] leading-none font-black uppercase">SMS</h2>
          <span className={`text-[14px] ${sms?.configured ? 'text-leaf' : 'text-white/60'}`}>{sms?.configured ? `Подключены: ${sms.provider}` : 'Выключены'}</span>
        </div>
        <p className="text-[15px] leading-snug text-white/70">
          Кандидатам без бота (оставили заявку на&nbsp;сайте или их&nbsp;добавили вручную) приглашение на&nbsp;собеседование и&nbsp;напоминание накануне уходят SMS.
          Остальное по-прежнему сообщают звонком. Тексты SMS короткие, их можно поправить в&nbsp;«Уведомлениях».
        </p>
        {sms?.configured ? (
          <p className="text-[15px] text-white/70">Имя отправителя: {sms.sender ?? 'по умолчанию у провайдера'}.</p>
        ) : (
          <ul className="flex flex-col gap-1.5 font-mono text-[13px] text-white/85">
            <li>SMS_PROVIDER: smsru или smsc</li>
            <li>SMS_API_KEY: api_id SMS.ru или API-ключ SMSC.ru</li>
            <li>SMS_LOGIN, SMS_PASSWORD: вместо ключа для SMSC.ru</li>
            <li>SMS_SENDER: имя отправителя, согласованное с провайдером</li>
          </ul>
        )}
      </article>
      <aside className="flex flex-col gap-3 self-start border-l-2 border-periwinkle bg-periwinkle/[0.06] p-4 text-[14px] leading-snug text-white/75">
        <p className="font-display text-[20px] leading-none font-black text-white uppercase">Согласие</p>
        <p>SMS уходят только тем, кто сам оставил телефон в&nbsp;заявке, и&nbsp;только по&nbsp;этой заявке. Согласие в&nbsp;форме кандидата упоминает связь по&nbsp;SMS. Рекламу этим каналом не&nbsp;отправляй.</p>
      </aside>

      <div className="xl:col-span-2">
        <HhCard />
      </div>
    </div>
  )
}

const scopeName: Record<string, string> = { applications: 'заявки', bot_users: 'аудитория ботов', sessions: 'диалоги с ботом', kb_gaps: 'вопросы к Квасычу' }

/** Срок хранения: когда последний раз удаляли, что и сколько. Персональных данных в журнале нет */
function Retention() {
  const toast = useToast()
  const [data, setData] = useState<{ months: number; lastRunAt: string | null; log: RetentionEntry[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const load = () => getRetention().then(setData).catch(() => {})
  useEffect(() => {
    void load()
  }, [])
  const run = async () => {
    setBusy(true)
    try {
      const r = await runRetentionNow()
      toast(
        'busy' in r
          ? { text: 'Удаление уже идёт', tone: 'error' }
          : { text: 'Проверено', detail: `Обезличено заявок: ${r.applications}, профилей ботов: ${r.botUsers}, диалогов удалено: ${r.sessions}, вопросов: ${r.kbGaps}` },
      )
      void load()
    } catch (e) {
      toast({ text: 'Не получилось', detail: (e as Error).message, tone: 'error' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <article className="flex flex-col gap-4 border-t-[3px] border-double border-white/60 pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="font-display text-[28px] leading-none font-black uppercase">Срок хранения</h2>
        <span className="text-[14px] text-white/70">{data ? `${data.months} мес. после последнего изменения статуса` : ''}</span>
      </div>
      <p className="max-w-3xl text-[15px] leading-snug text-white/70">
        По политике обработки данных заявку храним в&nbsp;течение сезона и&nbsp;ещё {data?.months ?? 12} месяцев. Каждую ночь сервер обезличивает старые заявки: стирает
        имя, телефон, контакты, комментарии и&nbsp;заметки, а&nbsp;статусы и&nbsp;даты оставляет для воронки. У&nbsp;ботов стираются имя и&nbsp;ник, старые диалоги удаляются. Удалить данные
        по&nbsp;запросу кандидата можно в&nbsp;его карточке.
      </p>
      <p className="text-[14px] text-white/60">
        Последняя проверка: {data?.lastRunAt ? new Date(data.lastRunAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }) : 'ещё не было'}
      </p>
      <button onClick={() => void run()} disabled={busy} className={`${hrBtn.ghost} w-fit`}>
        {busy ? 'Проверяем' : 'Проверить сейчас'}
      </button>
      <h3 className="mt-2 font-display text-[20px] leading-none font-black uppercase">Журнал удаления</h3>
      {data && !data.log.length ? (
        <p className="text-[14px] text-white/60">Пока ничего не удаляли.</p>
      ) : (
        <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
          <table className="w-full min-w-[640px] border-collapse text-left text-[14px]">
            <thead>
              <tr className="border-b border-white/30 text-[12px] tracking-[0.06em] text-white/60 uppercase">
                <th className="py-2 pr-3 font-semibold">Когда</th>
                <th className="py-2 pr-3 font-semibold">Что</th>
                <th className="py-2 pr-3 text-right font-semibold">Сколько</th>
                <th className="py-2 pr-3 font-semibold">Кто</th>
                <th className="py-2 font-semibold">Причина</th>
              </tr>
            </thead>
            <tbody>
              {data?.log.map((e) => (
                <tr key={e.id} className="border-b border-white/10 align-top">
                  <td className="py-2 pr-3 whitespace-nowrap text-white/70 tabular-nums">
                    {new Date(e.createdAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' })}
                  </td>
                  <td className="py-2 pr-3">
                    {scopeName[e.scope] ?? e.scope}
                    {e.applicationId ? ` · ${e.applicationId}` : ''}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">{e.count}</td>
                  <td className="py-2 pr-3">{e.userName}</td>
                  <td className="py-2 text-white/75">{e.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </article>
  )
}

/** hh.ru: предпросмотр вакансий, черновик и публикация только по кнопке */
function HhCard() {
  const toast = useToast()
  const [data, setData] = useState<Awaited<ReturnType<typeof getHh>> | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const load = () => getHh().then(setData).catch(() => {})
  useEffect(() => {
    void load()
  }, [])

  const act = async (id: string, action: HhAction, live: boolean) => {
    if (live && action === 'publish' && !window.confirm('Опубликовать вакансию на hh.ru? Публикация списывает услугу из пакета компании.')) return
    setBusy(`${id}:${action}`)
    try {
      const r = await hhVacancyAction(id, action, !live)
      if (!live) toast({ text: 'Проверено, ничего не отправлено', detail: (r.problems as string[]).length ? `Поправить: ${(r.problems as string[]).join('; ')}` : 'Запрос готов к отправке' })
      else toast({ text: action === 'publish' ? 'Отправлено на hh.ru, вакансия пройдёт модерацию' : action === 'draft' ? 'Черновик создан на hh.ru' : action === 'archive' ? 'Вакансия в архиве hh.ru' : 'Изменения отправлены' })
      void load()
    } catch (e) {
      toast({ text: 'hh.ru: не получилось', detail: (e as Error).message, tone: 'error' })
    } finally {
      setBusy(null)
    }
  }

  const importResponses = async (id: string) => {
    setBusy(`${id}:responses`)
    try {
      const { rows } = await hhResponses(id)
      const ok = rows.filter((r) => !r.problems.length)
      if (!ok.length) return toast({ text: 'Новых откликов с контактами нет' })
      const report = await commitImport(ok, 'hh', true)
      toast({ text: `Отклики с hh.ru: добавлено ${report.created.length}`, detail: report.duplicates.length ? `Уже были в базе: ${report.duplicates.length}` : undefined })
    } catch (e) {
      toast({ text: 'Отклики не загрузились', detail: (e as Error).message, tone: 'error' })
    } finally {
      setBusy(null)
    }
  }

  if (!data) return null
  const small = `${hrBtn.small} text-white ring-1 ring-white/30 ring-inset hover:ring-white`
  return (
    <article className="flex flex-col gap-4 border-t-[3px] border-double border-white/60 pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="font-display text-[28px] leading-none font-black uppercase">hh.ru</h2>
        <span className={`text-[14px] ${data.connected ? 'text-leaf' : 'text-white/60'}`}>{data.connected ? `Подключено${data.employerId ? `, работодатель ${data.employerId}` : ''}` : 'Не подключено'}</span>
      </div>
      <p className="max-w-3xl text-[15px] leading-snug text-white/70">
        Вакансии с&nbsp;сайта собираются в&nbsp;запрос API работодателя hh.ru: название, описание, зарплата, график, роль. Само ничего не&nbsp;публикуется. Сначала идёт проверка без
        отправки, потом бесплатный черновик или публикация по&nbsp;кнопке. Публикация списывает услугу из&nbsp;пакета компании и&nbsp;проходит модерацию hh.ru.
      </p>
      {!data.connected && (
        <ul className="flex flex-col gap-1.5 font-mono text-[13px] text-white/85">
          <li>HH_CLIENT_ID, HH_CLIENT_SECRET: приложение на dev.hh.ru</li>
          <li>HH_ACCESS_TOKEN, HH_REFRESH_TOKEN: токен менеджера компании (OAuth, роль работодателя)</li>
          <li>HH_EMPLOYER_ID: номер работодателя на hh.ru</li>
          <li>HH_USER_AGENT: «Название/версия (почта)», обязателен для каждого запроса</li>
          <li>HH_ADDRESS_ID: адрес из списка адресов работодателя, чтобы на вакансии была карта</li>
        </ul>
      )}
      {!data.addressId && <p className="text-[14px] text-white/70">Адрес не задан: укажи HH_ADDRESS_ID из списка адресов работодателя на hh.ru, иначе вакансии выйдут без карты.</p>}
      <ul className="border-t border-white/10">
        {data.vacancies.map((v) => {
          const pub = data.published[v.id]
          return (
            <li key={v.id} className="flex flex-col gap-2 border-b border-white/10 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="font-medium">{v.title}</span>
                <span className="text-[13px] text-white/60">
                  {pub ? `${pub.kind === 'draft' ? 'черновик' : pub.archived ? 'в архиве' : 'опубликована'} на hh.ru · № ${pub.hhId}` : 'не отправлялась'}
                </span>
              </div>
              {v.problems.length > 0 && <p className="text-[13px] text-periwinkle">Поправить: {v.problems.join('; ')}</p>}
              {v.warnings.filter((w) => !w.startsWith('Адрес не задан')).length > 0 && (
                <p className="text-[13px] text-white/60">{v.warnings.filter((w) => !w.startsWith('Адрес не задан')).join('; ')}</p>
              )}
              <details>
                <summary className="cursor-pointer text-[13px] text-white/70">Показать запрос к hh.ru</summary>
                <pre className="mt-2 max-h-64 overflow-auto bg-white/[0.04] p-3 text-[12px] whitespace-pre-wrap text-white/80">{JSON.stringify(v.payload, null, 2)}</pre>
              </details>
              <div className="flex flex-wrap gap-2">
                <button className={small} disabled={busy !== null} onClick={() => void act(v.id, 'publish', false)}>
                  Проверить без отправки
                </button>
                <button className={small} disabled={!data.connected || busy !== null} onClick={() => void act(v.id, 'draft', true)}>
                  Черновик на hh.ru
                </button>
                <button
                  className={`${hrBtn.small} bg-brand text-white hover:bg-white hover:text-brand`}
                  disabled={!data.connected || busy !== null || v.problems.length > 0 || (pub?.kind === 'vacancy' && !pub.archived)}
                  onClick={() => void act(v.id, 'publish', true)}
                >
                  Опубликовать
                </button>
                {pub?.kind === 'vacancy' && !pub.archived && (
                  <>
                    <button className={small} disabled={busy !== null} onClick={() => void act(v.id, 'update', true)}>
                      Обновить
                    </button>
                    <button className={small} disabled={busy !== null} onClick={() => void act(v.id, 'archive', true)}>
                      В архив
                    </button>
                    <button className={small} disabled={busy !== null} onClick={() => void importResponses(v.id)}>
                      Отклики → заявки
                    </button>
                  </>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </article>
  )
}

/** Список дат с добавлением и удалением — для переносов выходных */
function DayList({ title, hint, days, onChange }: { title: string; hint: string; days: string[]; onChange: (d: string[]) => void }) {
  const [value, setValue] = useState('')
  const id = `days-${title.length}`
  const label = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-[14px] text-white/80">{title}</legend>
      <p className="text-[13px] text-white/60">{hint}</p>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={id} className="sr-only">
          Дата: {title}
        </label>
        <input id={id} type="date" value={value} onChange={(e) => setValue(e.target.value)} className="h-9 border-b border-white/30 bg-transparent text-[15px] text-white [color-scheme:dark]" />
        <button
          type="button"
          disabled={!value || days.includes(value)}
          onClick={() => {
            onChange([...days, value].sort())
            setValue('')
          }}
          className={chip(false)}
        >
          Добавить
        </button>
      </div>
      {days.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {days.map((d) => (
            <li key={d} className="inline-flex items-center gap-2 bg-white/[0.06] py-1 pr-1 pl-3 text-[14px]">
              {label(d)}
              <button type="button" onClick={() => onChange(days.filter((x) => x !== d))} aria-label={`Убрать ${label(d)}`} className="grid size-7 place-items-center text-white/70 hover:text-white">
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  )
}

/** Рабочее время: на него ставятся задачи «перезвонить», по норме считается загрузка собеседований */
function WorkSection() {
  const toast = useToast()
  const [s, setS] = useState<WorkSettings>(hrWork)
  const problem = workSettingsProblem(s)
  const names = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']
  const save = async () => {
    try {
      setS(await saveWorkSettings(s))
      toast({ text: 'Рабочее время сохранено' })
    } catch (e) {
      toast({ text: 'Не сохранилось', detail: (e as Error).message, tone: 'error' })
    }
  }
  const num = 'h-10 w-20 border-b border-white/30 bg-transparent text-[16px] text-white tabular-nums focus:border-white'
  return (
    <article className="flex max-w-2xl flex-col gap-5 border-t-[3px] border-double border-white/60 pt-4">
      <h2 className="font-display text-[28px] leading-none font-black uppercase">Рабочее время</h2>
      <p className="text-[15px] leading-snug text-white/70">
        На рабочие дни и часы ставятся задачи «перезвонить» и напоминания о собеседованиях для кандидатов без бота. Например, если собеседование в понедельник, задача придёт в пятницу. Праздники по ст. 112 ТК РФ панель знает сама. Переносы выходных правительство утверждает каждый год, их внеси ниже.
      </p>
      <fieldset>
        <legend className="mb-2 text-[14px] text-white/70">Рабочие дни</legend>
        <div className="flex flex-wrap gap-2">
          {names.map((n, i) => {
            const on = s.days.includes(i + 1)
            return (
              <button key={n} aria-pressed={on} onClick={() => setS({ ...s, days: on ? s.days.filter((d) => d !== i + 1) : [...s.days, i + 1] })} className={chip(on)}>
                {n}
              </button>
            )
          })}
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-6 text-[14px] text-white/70">
        <label className="flex flex-col gap-1">
          Начало, час
          <input type="number" min={0} max={23} value={s.start} onChange={(e) => setS({ ...s, start: Number(e.target.value) })} className={num} />
        </label>
        <label className="flex flex-col gap-1">
          Конец, час
          <input type="number" min={1} max={24} value={s.end} onChange={(e) => setS({ ...s, end: Number(e.target.value) })} className={num} />
        </label>
        <label className="flex flex-col gap-1">
          Собеседований в час
          <input type="number" min={1} max={100} value={s.slotCapacity} onChange={(e) => setS({ ...s, slotCapacity: Number(e.target.value) })} className={num} />
        </label>
      </div>
      <DayList
        title="Дополнительные выходные"
        hint="Переносы из постановления правительства на год, корпоративные выходные. Праздники по ст. 112 ТК РФ уже учтены."
        days={s.extraOff}
        onChange={(extraOff) => setS({ ...s, extraOff })}
      />
      <DayList
        title="Рабочие выходные"
        hint="Суббота или воскресенье, которые по переносу становятся рабочими."
        days={s.extraWork}
        onChange={(extraWork) => setS({ ...s, extraWork })}
      />
      {problem && <p className="text-[14px] text-brand-bright" role="alert">{problem}</p>}
      <button onClick={() => void save()} disabled={Boolean(problem)} className={`${hrBtn.red} w-fit`}>
        Сохранить
      </button>
    </article>
  )
}

function DataSection({ onChanged }: { onChanged: () => void }) {
  const toast = useToast()
  const [confirm, setConfirm] = useState('')
  return (
    <div className="flex flex-col gap-12">
    <Retention />
    {!hrDemoTools ? (
      <p className="max-w-2xl text-[15px] text-white/70">
        Демо-данные и очистка базы в&nbsp;рабочей версии отключены. Заявки удаляются только по&nbsp;сроку хранения или по&nbsp;запросу кандидата, и&nbsp;каждое удаление записывается в&nbsp;журнал.
      </p>
    ) : (
    <div className="grid gap-10 md:grid-cols-2">
      <article className="flex flex-col gap-4 border-t-[3px] border-double border-white/60 pt-4">
        <h2 className="font-display text-[28px] leading-none font-black uppercase">Демо-данные</h2>
        <p className="text-[15px] text-white/65">Два десятка правдоподобных заявок с историей, собеседованиями, недозвонами, парой дублей и событиями воронки. Пригодятся для показа панели и обучения новых сотрудников.</p>
        <button
          onClick={async () => {
            await seedDemoApplications()
            onChanged()
            toast({ text: 'Демо-данные добавлены' })
          }}
          className={`${hrBtn.ghost} w-fit`}
        >
          Добавить демо-данные
        </button>
      </article>
      <article className="flex flex-col gap-4 border-t-[3px] border-double border-brand pt-4">
        <h2 className="font-display text-[28px] leading-none font-black text-brand uppercase">Очистить базу</h2>
        <p className="text-[15px] text-white/65">Удалит все заявки с&nbsp;историей, собеседования, очередь сообщений и&nbsp;события воронки. Сотрудники, тексты и&nbsp;настройки останутся. Отменить нельзя.</p>
        <label className="text-[14px] text-white/60">
          Чтобы подтвердить, напиши «очистить»
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} className="mt-1 h-10 w-full border-b border-white/30 bg-transparent text-[16px] text-white focus:border-white" />
        </label>
        <button
          disabled={confirm.trim().toLowerCase() !== 'очистить'}
          onClick={async () => {
            await clearApplications()
            setConfirm('')
            onChanged()
            toast({ text: 'База очищена' })
          }}
          className={`${hrBtn.red} w-fit`}
        >
          Очистить
        </button>
      </article>
    </div>
    )}
    </div>
  )
}

/** Названия задач очереди для людей */
const jobName: Record<string, string> = {
  notify: 'Сообщение кандидату',
  reminder: 'Напоминание о собеседовании',
  shift_reminder: 'Напоминание о первой смене',
}

/** Формат выгрузки для людей: «Excel», «1С» */
const formatName: Record<string, string> = { xlsx: 'Excel', csv: 'CSV', csv1c: '1С', json: 'JSON' }
const accessWhat = (r: AccessRow) => (r.action === 'disk' ? 'Яндекс Диск' : r.action === 'token_read' ? 'Чтение по служебному токену' : (formatName[r.format] ?? r.format) || 'Файл')
const roleShort: Record<string, string> = { admin: 'админ', hr: 'HR' }

const moment = (iso: string | null, empty = 'ещё не было') =>
  iso ? new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }) : empty

/**
 * Состояние сервера для администратора: проваленные задачи очереди, выгрузка на Диск, срок хранения, последнее
 * сообщение в ботах — и журнал выгрузок: кто, с какой ролью, в каком формате и сколько заявок забрал
 */
function StateSection() {
  const [state, setState] = useState<AdminState | null>(null)
  const [log, setLog] = useState<AccessRow[] | null>(null)
  const [error, setError] = useState(false)
  const [format, setFormat] = useState('')
  const [who, setWho] = useState('')

  useEffect(() => {
    adminState().then(setState).catch(() => setError(true))
  }, [])
  useEffect(() => {
    const t = window.setTimeout(() => {
      const filter = format === 'disk' ? { action: 'disk' } : format ? { action: 'export', format } : {}
      accessLog({ ...filter, user: who.trim() }).then(setLog).catch(() => setError(true))
    }, 250)
    return () => window.clearTimeout(t)
  }, [format, who])

  if (error) return <Notice tone="error">Состояние не загрузилось. Обнови страницу.</Notice>
  if (!state) return <p className="text-white/50">Загружаем</p>

  const tile = 'flex flex-col gap-2 border-t-[3px] border-double border-white/60 pt-4'
  const tileTitle = 'font-display text-[22px] leading-none font-black uppercase'
  return (
    <div className="flex flex-col gap-12">
      <div className="grid gap-10 md:grid-cols-2 xl:grid-cols-4">
        <article className={tile}>
          <h2 className={tileTitle}>Очередь задач</h2>
          <p className={`text-[15px] ${state.jobs.failed24h ? 'text-brand-bright' : 'text-white/75'}`}>
            {state.jobs.failed24h ? `Не выполнено за сутки: ${state.jobs.failed24h}` : 'За сутки все задачи выполнены'}
          </p>
          {state.jobs.stuck > 0 && <p className="text-[14px] text-periwinkle">Ждут дольше 10 минут: {state.jobs.stuck}. Проверь, запущен ли сервер задач.</p>}
          <p className="text-[13px] text-white/55">Сообщения кандидатам и напоминания. После трёх неудачных попыток задача считается проваленной.</p>
        </article>
        <article className={tile}>
          <h2 className={tileTitle}>Яндекс Диск</h2>
          <p className="text-[15px] text-white/75">Последняя выгрузка: {moment(state.disk.lastOkAt)}{state.disk.lastRows != null ? ` · ${state.disk.lastRows} заявок` : ''}</p>
          {state.disk.error ? <p className="text-[14px] text-brand-bright">Ошибка: {state.disk.error}</p> : <p className="text-[13px] text-white/55">Ошибок при последней попытке нет.</p>}
        </article>
        <article className={tile}>
          <h2 className={tileTitle}>Срок хранения</h2>
          <p className="text-[15px] text-white/75">Последнее удаление по сроку: {moment(state.retention.lastRunAt)}</p>
          <p className="text-[13px] text-white/55">Сервер проверяет каждую ночь. Журнал есть в разделе «Данные».</p>
        </article>
        <article className={tile}>
          <h2 className={tileTitle}>Боты</h2>
          <p className="text-[15px] text-white/75">Telegram: {moment(state.bots.telegram, 'сообщений не было')}</p>
          <p className="text-[15px] text-white/75">MAX: {moment(state.bots.max, 'сообщений не было')}</p>
          <p className="text-[13px] text-white/55">Когда пришло последнее сообщение от людей.</p>
        </article>
      </div>

      {state.jobs.list.length > 0 && (
        <section aria-labelledby="failed-jobs" className="flex flex-col gap-3">
          <h2 id="failed-jobs" className="font-display text-[22px] leading-none font-black uppercase">
            Проваленные задачи
          </h2>
          <ul className="border-t border-white/15">
            {state.jobs.list.map((j) => (
              <li key={j.id} className="flex flex-col gap-1 border-b border-white/10 py-3 text-[14px] sm:flex-row sm:items-baseline sm:gap-6">
                <span className="shrink-0 text-white/60 tabular-nums sm:w-40">{moment(j.at, '—')}</span>
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{jobName[j.kind] ?? j.kind}</span>
                  <span className="text-white/60"> · попыток: {j.attempts}</span>
                  {j.error && <span className="block break-words text-white/70">{j.error}</span>}
                </span>
                {j.applicationId && (
                  <a href={`/hr?card=${encodeURIComponent(j.applicationId)}`} className="shrink-0 text-[14px] underline underline-offset-4 hover:text-white">
                    Заявка {j.applicationId}
                  </a>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="access-log" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="access-log" className="font-display text-[28px] leading-none font-black uppercase">
            Журнал выгрузок
          </h2>
          <p className="text-[14px] text-white/60">Кто и что забрал из панели. Сами данные здесь не хранятся, только формат и число заявок</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {[
            ['', 'Все'],
            ['xlsx', 'Excel'],
            ['csv', 'CSV'],
            ['csv1c', '1С'],
            ['json', 'JSON'],
            ['disk', 'Яндекс Диск'],
          ].map(([id, label]) => (
            <button key={id} onClick={() => setFormat(id)} aria-pressed={format === id} className={chip(format === id)}>
              {label}
            </button>
          ))}
          <label className="ml-0 flex items-center gap-2 text-[14px] text-white/60 sm:ml-4">
            <span className="sr-only">Сотрудник</span>
            <input
              value={who}
              onChange={(e) => setWho(e.target.value)}
              placeholder="Имя сотрудника"
              className="h-9 w-48 border-b border-white/30 bg-transparent text-[15px] text-white placeholder:text-white/55 focus:border-white"
            />
          </label>
        </div>
        {log && !log.length ? (
          <p className="text-[14px] text-white/60">{format || who ? 'По этому отбору выгрузок нет.' : 'Выгрузок ещё не было.'}</p>
        ) : (
          <ul className="border-t border-white/15">
            {(log ?? []).map((r) => (
              <li key={r.id} className="flex flex-col gap-0.5 border-b border-white/10 py-3 text-[15px] sm:flex-row sm:items-baseline sm:gap-6">
                <span className="shrink-0 text-[14px] text-white/60 tabular-nums sm:w-40">{moment(r.createdAt, '—')}</span>
                <span className="min-w-0 flex-1">
                  {/* Сотрудник: «Ирина (админ) · Excel · 17 заявок»; расписание и токен: «Выгрузка на Яндекс Диск по расписанию · 26 заявок» */}
                  {roleShort[r.role] ? (
                    <>
                      {r.userName}
                      <span className="text-white/55"> ({roleShort[r.role]})</span> · {accessWhat(r)}
                    </>
                  ) : (
                    r.userName || accessWhat(r)
                  )}{' '}
                  · {plural(r.rows, 'заявка', 'заявки', 'заявок')}
                  {r.filter && <span className="block text-[13px] break-all text-white/50">Отбор: {r.filter}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
