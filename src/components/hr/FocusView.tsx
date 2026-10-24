import { motion } from 'motion/react'
import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { encodeQr, qrPath, qrSvg, QR_QUIET, type QrCode } from '@shared/qr'
import { SOURCE_CODE_RE } from '@shared/sources'
import { ApiError, HrUnauthorized, request, type HrUser } from '../../lib/api'
import { nb } from '../../lib/typo'
import { plural, when } from './hrUtils'
import { saveBlob } from './download'
import { Dialog } from './overlay'
import { useSourceNames } from './sourcesCache'
import { useToast } from './toasts'
import { chip, Empty, hrBtn, HrInput, HrLabel, Notice, pageTitle } from './ui'

// Вкладка «Фокус-группа»: ответы анонимной анкеты /focus по вопросам и меткам, свободные ответы «Чего не хватает»,
// ссылка и QR на анкету с меткой, выгрузка CSV. Смотрят все сотрудники HR, пробные ответы удаляет администратор.
// Как читать: протокол фокус-группы (docs/brand/focus-group.md), раздел 6 — пока по метке меньше 30 ответов, только числа, без процентов,
// и метки между собой не сравниваем. Сервер — server/api/focus.ts.

/** Вкладка готова: Hr.tsx показывает её, когда ready = true (как «Источники», «Боты», «Рассылка») */
export const ready = true

/** С этого числа ответов показываем проценты (протокол фокус-группы, раздел 6) */
export const PERCENT_FROM = 30

type Option = { id: string; label: string }
type Question =
  | { id: string; kind: 'one'; title: string; short: string; look?: 'slogan'; hint?: string; options: Option[] }
  | { id: string; kind: 'text'; title: string; short: string; max: number; hint: string }
type ChoiceQuestion = Extract<Question, { kind: 'one' }>

/** Ответ GET /api/hr/focus */
type FocusData = {
  version: number
  questions: Question[]
  total: number
  tags: { tag: string; count: number; last: string }[]
  /** метка → вопрос → вариант → число ответов */
  counts: Record<string, Record<string, Record<string, number>>>
  texts: { id: number; tag: string; text: string; at: string }[]
  site: string
  canDelete: boolean
}

/** Все метки или одна; '' — ответы по ссылке без метки */
type Slice = { all: true } | { all: false; tag: string }

const sectionTitle = 'font-display text-[28px] leading-none font-black uppercase'
const ghost = hrBtn.smallGhost

/** Метки встреч из протокола: А — колледжи, Б — 4-е курсы и выпускники */
const MEETING_TAGS = ['fg-a', 'fg-b']

const getFocus = () => request<FocusData>('/api/hr/focus')

/** Сумма ответов по вопросу для среза: все метки или одна */
function countsFor(data: FocusData, slice: Slice, question: string): Record<string, number> {
  const tags = slice.all ? Object.keys(data.counts) : [slice.tag]
  const out: Record<string, number> = {}
  for (const tag of tags) for (const [option, n] of Object.entries(data.counts[tag]?.[question] ?? {})) out[option] = (out[option] ?? 0) + n
  return out
}

const percent = (n: number, total: number) => `${Math.round((n / total) * 100)}%`

export function FocusView({ user }: { user: HrUser }) {
  const [data, setData] = useState<FocusData | null>(null)
  const [failed, setFailed] = useState(false)
  const [slice, setSlice] = useState<Slice>({ all: true })
  const [removing, setRemoving] = useState<{ kind: 'one'; id: number; text: string } | { kind: 'tag'; tag: string; count: number } | null>(null)
  const names = useSourceNames()
  const toast = useToast()

  const load = useCallback(
    () =>
      getFocus()
        .then((d) => {
          setData(d)
          setFailed(false)
        })
        .catch(() => setFailed(true)),
    [],
  )
  useEffect(() => {
    void load()
  }, [load])

  /** Название метки: из реестра «Источников», если дали; без метки — так и пишем */
  // Метка demo — ответы из «Демо-данных» (server/db/demo.ts): подписываем, чтобы их не приняли за исследование
  const tagName = useCallback(
    (tag: string) => (tag === 'demo' ? 'Демо-ответы для показа' : tag ? (names[tag] ? `${names[tag]} · ${tag}` : tag) : 'Без метки'),
    [names],
  )

  if (!data) {
    return (
      <section aria-labelledby="focus-title">
        <h1 id="focus-title" className={pageTitle}>
          Фокус-группа
        </h1>
        <div className="mt-6">{failed ? <Notice tone="error">Ответы анкеты не загрузились. Обнови страницу.</Notice> : <p className="text-white/60">Загружаем ответы</p>}</div>
      </section>
    )
  }

  // Выбранной метки больше нет (ответы удалили) — снова все
  const current: Slice = !slice.all && !data.tags.some((t) => t.tag === slice.tag) ? { all: true } : slice
  const sliceTotal = current.all ? data.total : (data.tags.find((t) => t.tag === current.tag)?.count ?? 0)
  const texts = current.all ? data.texts : data.texts.filter((t) => t.tag === current.tag)
  const choices = data.questions.filter((q): q is ChoiceQuestion => q.kind === 'one')
  const canDelete = data.canDelete && user.role === 'admin'

  const download = async () => {
    const query = current.all ? '' : `?s=${encodeURIComponent(current.tag)}`
    try {
      const res = await fetch(`/api/hr/focus/export${query}`, { credentials: 'same-origin' })
      if (!res.ok) throw new Error(String(res.status))
      saveBlob(await res.blob(), current.all ? 'Фокус-группа.csv' : `Фокус-группа ${current.tag || 'без метки'}.csv`)
    } catch {
      toast({ text: 'Выгрузка не скачалась', detail: 'Проверь соединение и попробуй ещё раз', tone: 'error' })
    }
  }

  const remove = async () => {
    if (!removing) return
    try {
      if (removing.kind === 'one') await request(`/api/hr/focus/responses/${removing.id}`, { method: 'DELETE', hr: true })
      else await request(`/api/hr/focus/responses?tag=${encodeURIComponent(removing.tag)}`, { method: 'DELETE', hr: true })
      toast({ text: removing.kind === 'one' ? 'Ответ удалён' : `Удалены ответы: ${tagName(removing.tag)}` })
    } catch (e) {
      if (e instanceof HrUnauthorized) throw e
      toast({ text: 'Не удалилось', detail: e instanceof ApiError && e.status === 403 ? 'Удалять ответы может администратор' : 'Проверь соединение и попробуй ещё раз', tone: 'error' })
    }
    setRemoving(null)
    void load()
  }

  return (
    <section aria-labelledby="focus-title">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 id="focus-title" className={pageTitle}>
            Фокус-группа
          </h1>
          <p className="mt-3 max-w-2xl text-[15px] leading-snug text-white/65">
            {nb('Анонимная анкета о концепции «Смена»: какой слоган понятнее, что цепляет, подали бы заявку на практику и чего не хватает. Имён и телефонов анкета не спрашивает. Как проводить встречи и читать ответы, написано в протоколе фокус-группы на странице')}{' '}
            <a href="/materials" className="underline decoration-white/35 underline-offset-4 hover:decoration-white">
              «Материалы»
            </a>
            .
          </p>
        </div>
        <button type="button" onClick={() => void download()} className={`${ghost} w-fit shrink-0`} disabled={!sliceTotal}>
          Скачать CSV{current.all ? '' : ` · ${current.tag || 'без метки'}`}
        </button>
      </div>

      {data.total > 0 && (
        <div className="-mx-4 mt-8 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0" role="group" aria-label="Метка анкеты">
          <button type="button" className={`${chip(current.all, { plain: true })} shrink-0`} aria-pressed={current.all} onClick={() => setSlice({ all: true })}>
            Все метки · {data.total}
          </button>
          {data.tags.map((t) => {
            const on = !current.all && current.tag === t.tag
            return (
              <button key={t.tag || '-'} type="button" className={`${chip(on, { plain: true })} shrink-0`} aria-pressed={on} onClick={() => setSlice({ all: false, tag: t.tag })}>
                {tagName(t.tag)} · {t.count}
              </button>
            )
          })}
        </div>
      )}

      <div className="mt-10 grid gap-14 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] xl:gap-16">
        <div className="min-w-0">
          {data.total === 0 ? (
            <Empty title="Ответов пока нет">
              {nb('Дай участникам ссылку на анкету: QR на очной встрече или пост в сообществе вуза. Ответы появятся здесь сразу после отправки.')}
            </Empty>
          ) : (
            <>
              <Summary total={sliceTotal} label={current.all ? 'по всем меткам' : current.tag ? `с меткой ${tagName(current.tag)}` : 'без метки'} last={current.all ? data.tags.map((t) => t.last).sort().at(-1) : data.tags.find((t) => t.tag === current.tag)?.last} />
              {sliceTotal < PERCENT_FROM && (
                <div className="mt-6">
                  <Notice>
                    {nb(`Меньше ${PERCENT_FROM} ответов, поэтому показываем только числа, без процентов. Выводы делай вместе с заметками очных встреч, одной анкеты для них мало.`)}
                  </Notice>
                </div>
              )}
              <div className="mt-10 grid gap-12">
                {choices.map((q, i) => (
                  <QuestionBars key={q.id} question={q} number={i + 1} counts={countsFor(data, current, q.id)} total={sliceTotal} delay={i} />
                ))}
              </div>
              {current.all && data.tags.length > 1 && <ByTag data={data} choices={choices} tagName={tagName} />}
            </>
          )}
        </div>

        <div className="min-w-0">
          <LinkBuilder site={data.site} known={data.tags.map((t) => t.tag).filter(Boolean)} />
          {data.total > 0 && (
            <Texts
              texts={texts}
              total={current.all ? data.texts.length : texts.length}
              tagName={tagName}
              showTag={current.all}
              onDelete={canDelete ? (t) => setRemoving({ kind: 'one', id: t.id, text: t.text }) : undefined}
            />
          )}
          {canDelete && !current.all && (
            <div className="mt-10 border-t border-white/15 pt-5">
              <p className="text-[14px] leading-snug text-white/55">{nb('Пробные ответы перед встречей лучше убрать, чтобы не путали счёт.')}</p>
              <button
                type="button"
                className={`${ghost} mt-3`}
                onClick={() => setRemoving({ kind: 'tag', tag: current.tag, count: sliceTotal })}
              >
                Удалить ответы метки
              </button>
            </div>
          )}
        </div>
      </div>

      <Dialog open={removing !== null} title={removing?.kind === 'tag' ? 'Удалить ответы метки' : 'Удалить ответ'} onClose={() => setRemoving(null)}>
        {removing && (
          <>
            <p className="text-[16px] leading-snug">
              {removing.kind === 'tag'
                ? nb(`${tagName(removing.tag)}: ${plural(removing.count, 'ответ', 'ответа', 'ответов')} пропадут из счёта и выгрузки. Вернуть их нельзя.`)
                : nb('Ответ целиком пропадёт из счёта и выгрузки, вместе со слоганами и остальными вопросами. Вернуть его нельзя.')}
            </p>
            {removing.kind === 'one' && <p className="mt-3 border-l-2 border-white/30 pl-3 text-[15px] text-white/70">{removing.text}</p>}
            <div className="mt-6 flex flex-wrap gap-3">
              <button type="button" className={hrBtn.red} onClick={() => void remove()}>
                Удалить
              </button>
              <button type="button" className={hrBtn.ghost} onClick={() => setRemoving(null)}>
                Оставить
              </button>
            </div>
          </>
        )}
      </Dialog>
    </section>
  )
}

/** Сколько ответов в срезе и когда пришёл последний */
function Summary({ total, label, last }: { total: number; label: string; last?: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 border-b border-white/15 pb-5">
      <p className="font-display text-[56px] leading-[0.85] font-black" data-focus-total>
        {total}
      </p>
      <p className="text-[15px] leading-snug text-white/65">
        {plural(total, 'ответ', 'ответа', 'ответов').replace(/^\d+ /, '')} {label}
        {last ? <span className="block">последний: {when(last)}</span> : null}
      </p>
    </div>
  )
}

/**
 * Один вопрос: варианты в порядке анкеты, полоска — доля от ответов среза. Лидер (или лидеры поровну) — красным,
 * остальные — приглушённо: история вопроса в том, что выбирают чаще. Число стоит в каждой строке — это и таблица
 */
function QuestionBars({ question, number, counts, total, delay }: { question: ChoiceQuestion; number: number; counts: Record<string, number>; total: number; delay: number }) {
  const max = Math.max(0, ...Object.values(counts))
  const showPercent = total >= PERCENT_FROM
  return (
    <div data-focus-result={question.id}>
      <h2 className="text-[17px] leading-snug font-medium">
        <span className="text-white/60">{number}.</span> {nb(question.title)}
      </h2>
      <ul className="mt-4 border-t border-white/15">
        {question.options.map((o, i) => {
          const n = counts[o.id] ?? 0
          const lead = n > 0 && n === max
          return (
            <li key={o.id} className="border-b border-white/10 py-3">
              <div className="flex items-baseline justify-between gap-4">
                <span className={lead ? 'text-white' : 'text-white/75'}>{nb(o.label)}</span>
                <span className="flex shrink-0 items-baseline gap-3 tabular-nums">
                  <span className="font-display text-[26px] leading-none font-extrabold">{n}</span>
                  {showPercent && <span className="w-10 text-right text-[15px] text-white/55">{percent(n, total)}</span>}
                </span>
              </div>
              <div className="mt-2.5 h-1 bg-white/[0.08]" aria-hidden="true">
                <motion.div
                  initial={{ scaleX: 0 }}
                  animate={{ scaleX: total ? n / total : 0 }}
                  transition={{ duration: 0.8, delay: Math.min(0.4, delay * 0.04 + i * 0.03), ease: [0.16, 1, 0.3, 1] }}
                  className={`h-full origin-left ${lead ? 'bg-brand-bright' : 'bg-white/35'}`}
                />
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** Таблица «метка × варианты» для одного вопроса. Проценты — только у меток от 30 ответов */
function ByTag({ data, choices, tagName }: { data: FocusData; choices: ChoiceQuestion[]; tagName: (tag: string) => string }) {
  const [qid, setQid] = useState(choices[0]?.id ?? '')
  const question = choices.find((q) => q.id === qid) ?? choices[0]
  const selectId = useId()
  if (!question) return null
  return (
    <div className="mt-16" data-focus-by-tag>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <h2 className={sectionTitle}>По меткам</h2>
        <label htmlFor={selectId} className="sr-only">
          Вопрос
        </label>
        <select
          id={selectId}
          value={question.id}
          onChange={(e) => setQid(e.target.value)}
          className="h-10 max-w-full cursor-pointer border-b border-white/30 bg-night pr-6 text-[15px] text-white focus:border-white sm:max-w-[340px]"
        >
          {choices.map((q) => (
            <option key={q.id} value={q.id}>
              {q.title}
            </option>
          ))}
        </select>
      </div>
      <p className="mt-3 max-w-2xl text-[14px] leading-snug text-white/55">
        {nb(`Метки с ответами меньше ${PERCENT_FROM} между собой не сравниваем: разница может быть случайной. У таких меток показываем только числа.`)}
      </p>
      <div className="-mx-4 mt-5 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <table className="w-full min-w-[560px] border-collapse text-left text-[14px]">
          <caption className="sr-only">{question.title}: ответы по меткам</caption>
          <thead>
            <tr className="border-b border-white/30 text-[13px] text-white/65">
              <th scope="col" className="py-2.5 pr-4 font-normal">
                Метка
              </th>
              <th scope="col" className="py-2.5 pr-4 text-right font-normal">
                Ответов
              </th>
              {question.options.map((o) => (
                <th key={o.id} scope="col" className="max-w-[140px] py-2.5 pr-4 text-right align-bottom leading-snug font-normal">
                  {o.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.tags.map((t) => {
              const counts = data.counts[t.tag]?.[question.id] ?? {}
              const enough = t.count >= PERCENT_FROM
              return (
                <tr key={t.tag || '-'} className={`border-b border-white/10 ${enough ? '' : 'text-white/70'}`}>
                  <th scope="row" className="py-2.5 pr-4 font-normal whitespace-nowrap">
                    {tagName(t.tag)}
                  </th>
                  <td className="py-2.5 pr-4 text-right tabular-nums">{t.count}</td>
                  {question.options.map((o) => {
                    const n = counts[o.id] ?? 0
                    return (
                      <td key={o.id} className="py-2.5 pr-4 text-right tabular-nums">
                        {n}
                        {enough && n > 0 && <span className="ml-1.5 text-white/60">{percent(n, t.count)}</span>}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** Ответы «Чего не хватает, чтобы решиться?» — новые сверху */
function Texts({
  texts,
  total,
  tagName,
  showTag,
  onDelete,
}: {
  texts: FocusData['texts']
  total: number
  tagName: (tag: string) => string
  showTag: boolean
  onDelete?: (t: FocusData['texts'][number]) => void
}) {
  const [all, setAll] = useState(false)
  const shown = all ? texts : texts.slice(0, 12)
  return (
    <div className="mt-14" data-focus-texts>
      <h2 className={sectionTitle}>Чего не хватает</h2>
      <p className="mt-3 text-[14px] leading-snug text-white/55">
        {nb(`${plural(total, 'свободный ответ', 'свободных ответа', 'свободных ответов')}, новые сверху. Телефоны, почта, ники и ссылки вырезаны до записи. Три частые темы стоит добавить в FAQ, ответы Квасыча и на оборот листовки.`)}
      </p>
      {texts.length ? (
        <ul className="mt-5 border-t border-white/15">
          {shown.map((t) => (
            <li key={t.id} className="border-b border-white/10 py-3.5">
              <p className="text-[16px] leading-snug">{t.text}</p>
              <div className="mt-1.5 flex items-center justify-between gap-4 text-[13px] text-white/60">
                <span>
                  {showTag ? `${tagName(t.tag)} · ` : ''}
                  {when(t.at)}
                </span>
                {onDelete && (
                  <button type="button" onClick={() => onDelete(t)} className="underline decoration-white/30 underline-offset-4 hover:text-white">
                    Удалить<span className="sr-only"> ответ «{t.text.slice(0, 40)}»</span>
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-5 border-y border-white/15 py-6 text-[15px] text-white/55">Свободных ответов здесь пока нет.</p>
      )}
      {texts.length > shown.length && (
        <button type="button" onClick={() => setAll(true)} className={`${ghost} mt-4`}>
          Показать все · {texts.length}
        </button>
      )}
    </div>
  )
}

/** Квадрат QR на белом с полем, как в «Источниках» */
function QrPicture({ qr, title }: { qr: QrCode; title: string }) {
  const side = qr.size + QR_QUIET * 2
  return (
    <svg viewBox={`0 0 ${side} ${side}`} className="block w-full max-w-[168px]" role="img" aria-label={title} shapeRendering="crispEdges">
      <rect width={side} height={side} fill="#fff" />
      <path d={qrPath(qr)} fill="#000" />
    </svg>
  )
}

/** Ссылка и QR на анкету с меткой: fg-a и fg-b — очные встречи, остальные — каналы кампании */
function LinkBuilder({ site, known }: { site: string; known: string[] }) {
  const [tag, setTag] = useState('fg-a')
  const toast = useToast()
  const id = useId()
  const clean = tag.trim().toLowerCase()
  const valid = !clean || SOURCE_CODE_RE.test(clean)
  const url = `${site}/focus${clean && valid ? `?s=${clean}` : ''}`
  const qr = useMemo(() => (valid ? encodeQr(url) : null), [url, valid])
  // Метка demo — ответы из «Демо-данных», для новой ссылки её не предлагаем
  const suggestions = [...new Set([...MEETING_TAGS, ...known])].filter((t) => t !== 'demo')

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      toast({ text: 'Ссылка скопирована', detail: url.replace(/^https?:\/\//, '') })
    } catch {
      toast({ text: 'Не скопировалось', detail: 'Выдели ссылку и скопируй вручную', tone: 'error' })
    }
  }

  return (
    <div data-focus-link>
      <h2 className={sectionTitle}>Ссылка на анкету</h2>
      <p className="mt-3 text-[14px] leading-snug text-white/55">
        {nb('Своя метка на каждую встречу и канал: fg-a и fg-b для очных групп, остальные для постов и рассылок. Вопросы от метки не меняются, она только делит ответы.')}
      </p>
      <div className="mt-5">
        <HrLabel htmlFor={id}>Метка</HrLabel>
        <HrInput
          id={id}
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          placeholder="Без метки"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={!valid}
          aria-describedby={`${id}-hint`}
          className="mt-1"
        />
        <p id={`${id}-hint`} className={`mt-2 text-[13px] ${valid ? 'text-white/60' : 'text-brand-bright'}`}>
          {valid ? nb('Латиница, цифры и дефис, до 40 знаков. Если оставить пустым, ссылка будет без метки.') : nb('Только латиница, цифры и дефис, до 40 знаков, без дефиса по краям.')}
        </p>
        <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Готовые метки">
          {suggestions.map((s) => (
            <button key={s} type="button" className={chip(clean === s, { plain: true })} aria-pressed={clean === s} onClick={() => setTag(s)}>
              {s}
            </button>
          ))}
        </div>
      </div>
      {valid && qr && (
        <div className="mt-6 flex flex-col gap-5 sm:flex-row sm:items-start">
          <QrPicture qr={qr} title={`QR на анкету: ${url.replace(/^https?:\/\//, '')}`} />
          <div className="min-w-0">
            <p className="text-[15px] break-all text-white" data-focus-url>
              {url.replace(/^https?:\/\//, '')}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" className={ghost} onClick={() => void copy()}>
                Скопировать
              </button>
              <button
                type="button"
                className={ghost}
                onClick={() => saveBlob(new Blob([qrSvg(qr, { size: '30mm', title: url.replace(/^https?:\/\//, '') })], { type: 'image/svg+xml' }), `qr-focus${clean ? `-${clean}` : ''}.svg`)}
              >
                QR в SVG
              </button>
              <a href={url} target="_blank" rel="noopener noreferrer" className={ghost}>
                Открыть
              </a>
            </div>
            <p className="mt-3 text-[13px] leading-snug text-white/60">{nb('Печатай QR не меньше 3 × 3 см. На встрече его показывают на экране или раздают на листе.')}</p>
          </div>
        </div>
      )}
    </div>
  )
}
