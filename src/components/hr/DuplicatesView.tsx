import { useCallback, useEffect, useState } from 'react'
import { applicationStatuses, statusLabel, type HrApplication } from '@shared/applications'
import { getDuplicates, mergeApplication, unmergeApplication } from '../../lib/api'
import { channelName, formatDate, formatPhone, monthsRange, sourceName, vacancyTitle } from './hrUtils'
import { useToast } from './toasts'
import { Dash, Empty, hrBtn, Notice, pageTitle, StatusPill } from './ui'

const order = Object.fromEntries(applicationStatuses.map((s, i) => [s.id, i]))

/** Какую заявку оставить основной: дальше продвинутую по статусу, при равенстве — более раннюю */
const suggestPrimary = (list: HrApplication[]) =>
  [...list].sort((a, b) => {
    const rank = (x: HrApplication) => (x.status === 'declined' || x.status === 'no_answer' ? 0 : order[x.status] + 1)
    return rank(b) - rank(a) || a.createdAt.localeCompare(b.createdAt)
  })[0]

/** День заявки без времени: «от ДД.ММ» */
const day = (iso: string) => formatDate(iso).split(',')[0]

/**
 * Дубли по телефону: один человек — одна заявка в работе. «Сделать основной» только выбирает, какую оставить;
 * склеивает одна кнопка над группой, и «Отменить» во всплывающем сообщении снова разделяет заявки
 */
export function DuplicatesView({ onOpen, onChanged }: { onOpen: (id: string) => void; onChanged: () => void }) {
  const toast = useToast()
  const [groups, setGroups] = useState<{ phone: string; applications: HrApplication[] }[] | null>(null)
  const [error, setError] = useState(false)
  /** Выбранная основная заявка по телефону группы; без выбора — предложенная */
  const [chosen, setChosen] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(
    () =>
      getDuplicates()
        .then(setGroups)
        .catch(() => setError(true)),
    [],
  )
  useEffect(() => {
    void load()
  }, [load])

  const merge = async (phone: string, group: HrApplication[], primary: HrApplication) => {
    const dups = group.filter((a) => a.id !== primary.id)
    const merged: string[] = []
    setBusy(phone)
    try {
      for (const d of dups) {
        await mergeApplication(d.id, primary.id)
        merged.push(d.id)
      }
      toast({
        text: `Склеено: осталась заявка ${primary.name} от ${day(primary.createdAt)}`,
        detail: 'Пустые поля дополнены, заметки сохранены, дубли ушли из списка',
        revert: async () => {
          try {
            for (const id of merged) await unmergeApplication(id)
            onChanged()
            void load()
            return null
          } catch {
            return 'Нет связи с сервером. Отделить дубль можно в карточке основной заявки'
          }
        },
      })
      onChanged()
      void load()
    } catch (e) {
      toast({ text: 'Не получилось склеить', detail: (e as Error).message, tone: 'error' })
      if (merged.length) {
        onChanged()
        void load()
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <section aria-labelledby="dups-title">
      <h1 id="dups-title" className={pageTitle}>
        Дубли
      </h1>
      <p className="mt-2 max-w-2xl text-[14px] leading-snug text-white/65">
        Заявки с&nbsp;одним телефоном: человек написал и&nbsp;на&nbsp;сайте, и&nbsp;в&nbsp;боте или отправил форму дважды. Выбери, какую заявку оставить, и&nbsp;склей.
        Данные не&nbsp;удаляются: дубль остаётся в&nbsp;карточке основной заявки, его можно отделить обратно.
      </p>
      {error && (
        <div className="mt-5">
          <Notice tone="error">Список не загрузился. Обнови страницу.</Notice>
        </div>
      )}
      {groups && !groups.length && <Empty title="Дублей нет">Каждый телефон встречается в одной заявке.</Empty>}

      <div className="mt-6 flex flex-col gap-10">
        {groups?.map((g) => {
          const suggested = suggestPrimary(g.applications)
          const primary = g.applications.find((a) => a.id === chosen[g.phone]) ?? suggested
          return (
            <article key={g.phone} className="border-t border-white/30 pt-4" aria-label={`Телефон ${formatPhone(`+${g.phone}`)}`}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="font-display text-[26px] leading-none font-black tabular-nums">{formatPhone(`+${g.phone}`)}</h2>
                <button onClick={() => void merge(g.phone, g.applications, primary)} disabled={busy === g.phone} className={hrBtn.smallRed}>
                  Склеить: оставить заявку от {day(primary.createdAt)}, {statusLabel(primary.status)}
                </button>
              </div>
              <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {g.applications.map((a) => {
                  const main = a.id === primary.id
                  return (
                    <div key={a.id} className={`flex flex-col p-4 ring-inset ${main ? 'bg-white/[0.05] ring-2 ring-white/70' : 'ring-1 ring-white/15'}`}>
                      <div className="flex items-baseline justify-between gap-3">
                        <button onClick={() => onOpen(a.id)} className="text-left text-[16px] font-medium break-words underline-offset-4 hover:underline">
                          {a.name}
                        </button>
                        <span className={`shrink-0 text-[13px] ${main ? 'font-semibold text-white' : 'text-white/60'}`}>{main ? 'основная' : 'дубль'}</span>
                      </div>
                      <StatusPill status={a.status} className="mt-2 w-fit" />
                      <dl className="mt-3 grid grid-cols-[90px_1fr] gap-x-3 gap-y-1 text-[13px]">
                        <dt className="text-white/60">Пришла</dt>
                        <dd>
                          {formatDate(a.createdAt)} · {channelName(a.channel)}
                        </dd>
                        <dt className="text-white/60">Вакансия</dt>
                        <dd className="break-words">{vacancyTitle(a.vacancyId)}</dd>
                        <dt className="text-white/60">Месяцы</dt>
                        <dd>{monthsRange(a.months)}</dd>
                        <dt className="text-white/60">Источник</dt>
                        <dd>{sourceName(a.source)}</dd>
                        <dt className="text-white/60">Ведёт</dt>
                        <dd>{a.assigneeName ?? <Dash />}</dd>
                      </dl>
                      {!main && (
                        <button onClick={() => setChosen((c) => ({ ...c, [g.phone]: a.id }))} className={`${hrBtn.text} mt-3 w-fit`}>
                          Сделать основной
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
              <p className="mt-2 text-[13px] text-white/60">
                {primary.id === suggested.id
                  ? `Основная предложена по статусу «${statusLabel(suggested.status)}». Если в работе другая, нажми у неё «Сделать основной». Без нажатия кнопки ничего не склеится.`
                  : 'Основную выбрали вручную. Склеится только по кнопке над группой.'}
              </p>
            </article>
          )
        })}
      </div>
    </section>
  )
}
