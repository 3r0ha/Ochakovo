import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { getKbGaps, resolveKbGap, type KbGaps } from '../../lib/api'
import {
  checkKbAnswer,
  createKbAnswer,
  KB_ANSWER_MAX,
  listKbAnswers,
  updateKbAnswer,
  variantsFromText,
  type KbAnswer,
  type KbAnswerCheck,
  type KbAnswerDraft,
} from '../../lib/hr/kb'
import { Breakdown } from './Breakdown'
import { channelName, formatDate } from './hrUtils'
import { useToast } from './toasts'
import { DisabledHint, Empty, hrBtn, HrLabel, HrTextArea, Notice } from './ui'

/**
 * «Вопросы к Квасычу»: что спрашивают, а точного ответа в данных нет. HR отвечает прямо здесь —
 * и Квасыч дальше отвечает этим текстом на тот же вопрос и похожие. Ответы можно поправить и выключить
 */
export function KbGapsView() {
  const [data, setData] = useState<KbGaps | null>(null)
  const [answers, setAnswers] = useState<KbAnswer[] | null>(null)
  const [error, setError] = useState(false)
  const [answering, setAnswering] = useState<number | null>(null)
  const [editing, setEditing] = useState<number | null>(null)
  const toast = useToast()

  const load = () =>
    Promise.all([getKbGaps(), listKbAnswers()])
      .then(([gaps, list]) => {
        setData(gaps)
        setAnswers(list)
        setError(false)
      })
      .catch(() => setError(true))
  useEffect(() => {
    void load()
  }, [])

  const resolve = async (id: number) => {
    setData((d) => d && { ...d, items: d.items.filter((i) => i.id !== id) })
    await resolveKbGap(id).catch(() => void load())
    void load()
  }

  const saved = (r: { answer: KbAnswer; resolved: number }, gapId?: number) => {
    setAnswering(null)
    setEditing(null)
    setAnswers((list) => [r.answer, ...(list ?? []).filter((a) => a.id !== r.answer.id)])
    setData((d) => d && { ...d, items: d.items.filter((i) => i.id !== gapId) })
    const more = r.resolved > 0 ? ` Закрыты похожие вопросы: ${r.resolved}.` : ''
    toast({ text: 'Квасыч отвечает этим текстом', detail: `На этот вопрос и похожие формулировки.${more}` })
    void load()
  }

  const toggle = async (a: KbAnswer) => {
    setAnswers((list) => list && list.map((x) => (x.id === a.id ? { ...x, enabled: !a.enabled } : x)))
    try {
      await updateKbAnswer(a.id, { enabled: !a.enabled })
      toast({ text: a.enabled ? 'Ответ выключен' : 'Ответ включён', detail: a.enabled ? 'На этот вопрос Квасыч снова советует отдел персонала.' : 'Квасыч снова отвечает этим текстом.' })
    } catch {
      toast({ text: 'Не получилось сохранить', detail: 'Обнови страницу и попробуй ещё раз.', tone: 'error' })
    }
    void load()
  }

  const total = data?.topics.reduce((sum, t) => sum + t.count, 0) ?? 0
  const items = data?.items ?? []

  return (
    <section aria-labelledby="gaps-title" className="grid gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
      <div className="min-w-0">
        <Breakdown
          title="Вопросы к Квасычу"
          total={total}
          rows={(data?.topics ?? []).map((t) => [t.topic || 'Без темы', t.count])}
          note="Вопросы, на которые у Квасыча нет точного ответа в данных. Когда ответишь на вопрос, Квасыч будет отвечать этим текстом всем, кто спросит так же или похоже."
        />
        {error && (
          <div className="mt-6">
            <Notice tone="error">Список не загрузился. Обнови страницу.</Notice>
          </div>
        )}
      </div>

      <div className="min-w-0">
        <h2 id="gaps-title" className="font-display text-[28px] leading-none font-black uppercase">
          Последние вопросы
        </h2>
        <ul className="mt-8 border-t border-white/15">
          {items.map((q) => (
            <li key={q.id} className="border-b border-white/15 py-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
                <div className="min-w-0">
                  <p className="text-[16px] break-words">{q.question}</p>
                  <p className="mt-1 text-[13px] text-white/55">
                    {formatDate(q.createdAt)} · {channelName(q.channel)}
                    {q.topic ? ` · ${q.topic}` : ''}
                  </p>
                </div>
                {answering !== q.id && (
                  <div className="flex shrink-0 flex-wrap gap-x-5 self-start">
                    <button onClick={() => setAnswering(q.id)} className={hrBtn.text} aria-label={`Ответить: ${q.question.slice(0, 60)}`}>
                      Ответить
                    </button>
                    <button onClick={() => void resolve(q.id)} className={hrBtn.text} aria-label={`Разобрано: ${q.question.slice(0, 60)}`}>
                      Разобрано
                    </button>
                  </div>
                )}
              </div>
              {answering === q.id && (
                <AnswerForm
                  question={q.question}
                  submitLabel="Сохранить ответ"
                  onCancel={() => setAnswering(null)}
                  onSubmit={(draft) => createKbAnswer({ ...draft, gapId: q.id })}
                  onSaved={(r) => saved(r, q.id)}
                />
              )}
            </li>
          ))}
        </ul>
        {data && !items.length && <Empty title="Все вопросы разобраны">Новые вопросы, на которые у Квасыча нет точного ответа, появятся здесь.</Empty>}

        <h2 className="mt-16 font-display text-[28px] leading-none font-black uppercase">Ответы отдела персонала</h2>
        <p className="mt-4 max-w-xl text-[15px] leading-snug text-white/55">
          Квасыч проверяет их раньше своей базы. Выключенный ответ он не использует, на такой вопрос снова советует отдел персонала.
        </p>
        <ul className="mt-8 border-t border-white/15">
          {(answers ?? []).map((a) => (
            <li key={a.id} className={`border-b border-white/15 py-4 ${a.enabled ? '' : 'text-white/55'}`}>
              {editing === a.id ? (
                <AnswerForm
                  question={a.question}
                  initial={a}
                  submitLabel="Сохранить правку"
                  onCancel={() => setEditing(null)}
                  onSubmit={(draft) => updateKbAnswer(a.id, { answer: draft.answer, variants: draft.variants })}
                  onSaved={(r) => saved(r)}
                />
              ) : (
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
                  <div className="min-w-0">
                    <p className="text-[13px] break-words text-white/55">{a.question}</p>
                    <p className="mt-1 text-[16px] break-words whitespace-pre-line">{a.answer}</p>
                    {a.variants.length > 0 && <p className="mt-2 text-[13px] break-words text-white/55">Ещё формулировки: {a.variants.join('; ')}</p>}
                    <p className="mt-2 text-[13px] text-white/60">
                      {a.enabled ? 'Включён' : 'Выключен'} · {a.authorName || 'HR'} · {formatDate(a.updatedAt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-x-5 self-start">
                    <button onClick={() => setEditing(a.id)} className={hrBtn.text} aria-label={`Править ответ: ${a.question.slice(0, 60)}`}>
                      Править
                    </button>
                    <button onClick={() => void toggle(a)} className={hrBtn.text} aria-label={`${a.enabled ? 'Выключить' : 'Включить'} ответ: ${a.question.slice(0, 60)}`}>
                      {a.enabled ? 'Выключить' : 'Включить'}
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
        {answers && !answers.length && <Empty title="Ответов пока нет">Нажми «Ответить» у вопроса выше, и Квасыч начнёт отвечать этим текстом.</Empty>}
      </div>
    </section>
  )
}

type Saved = { answer: KbAnswer; resolved: number }

/** Форма ответа: текст, необязательные формулировки, проверка на лету. Сохраняет только то, что прошло проверку */
function AnswerForm({
  question,
  initial,
  submitLabel,
  onSubmit,
  onSaved,
  onCancel,
}: {
  question: string
  initial?: Pick<KbAnswer, 'answer' | 'variants'>
  submitLabel: string
  onSubmit: (draft: KbAnswerDraft) => Promise<Saved>
  onSaved: (r: Saved) => void
  onCancel: () => void
}) {
  const id = useId()
  const [answer, setAnswer] = useState(initial?.answer ?? '')
  const [variants, setVariants] = useState(initial?.variants.join('\n') ?? '')
  const [check, setCheck] = useState<KbAnswerCheck | null>(null)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const area = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    area.current?.focus()
  }, [])

  const draft = (): KbAnswerDraft => ({ question, answer, variants: variantsFromText(variants) })

  // Проверка на лету: «!», даты, род — пока HR печатает, без отправки
  useEffect(() => {
    if (answer.trim().length < 10) {
      setCheck(null)
      return
    }
    const timer = setTimeout(() => {
      checkKbAnswer(draft())
        .then(setCheck)
        .catch(() => {})
    }, 450)
    return () => clearTimeout(timer)
  }, [answer, variants]) // draft() собирается из них же

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setFailed(false)
    try {
      const c = await checkKbAnswer(draft())
      setCheck(c)
      if (Object.keys(c.errors).length) {
        // Личные данные убраны сервером — показываем, что именно сохранится
        if (c.cleaned.answer !== answer.trim() && /личные данные/.test(c.errors.answer ?? '')) setAnswer(c.cleaned.answer)
        if (/личные данные/.test(c.errors.variants ?? '')) setVariants(c.cleaned.variants.join('\n'))
        return
      }
      onSaved(await onSubmit(c.cleaned))
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  const errors = check?.errors ?? {}
  const answerError = errors.answer ?? errors.question
  return (
    <form onSubmit={(e) => void submit(e)} className="mt-4 grid gap-4 border-l-2 border-white/25 pl-4" noValidate>
      <div className="grid gap-2">
        <HrLabel htmlFor={`${id}-answer`}>Ответ Квасыча</HrLabel>
        <HrTextArea
          id={`${id}-answer`}
          ref={area}
          rows={4}
          maxLength={KB_ANSWER_MAX + 50}
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          aria-invalid={Boolean(answerError)}
          aria-describedby={`${id}-rules`}
          placeholder="В первой фразе сам ответ. Например: «Отдельной парковки нет: удобнее доехать на корпоративном автобусе от м. „Озёрная“»."
        />
        <p id={`${id}-rules`} className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-[13px] text-white/55">
          <span>Без «!» и дат. Телефоны и почту людей не пиши, можно только общие контакты отдела подбора.</span>
          <span className={`tabular-nums ${answer.length > KB_ANSWER_MAX ? 'text-white' : ''}`}>
            {answer.length} / {KB_ANSWER_MAX}
          </span>
        </p>
      </div>
      <div className="grid gap-2">
        <HrLabel htmlFor={`${id}-variants`}>Другие формулировки (если нужно)</HrLabel>
        <HrTextArea
          id={`${id}-variants`}
          rows={2}
          value={variants}
          onChange={(e) => setVariants(e.target.value)}
          aria-invalid={Boolean(errors.variants)}
          placeholder="По одной в строке: «можно приехать на машине?»"
        />
      </div>
      {(answerError || errors.variants) && <Notice tone="error">{answerError ?? errors.variants}</Notice>}
      {check?.hints.map((h) => (
        <Notice key={h}>{h}</Notice>
      ))}
      {failed && <Notice tone="error">Не получилось сохранить. Проверь связь и попробуй ещё раз.</Notice>}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={saving || answer.trim().length < 10} className={hrBtn.red}>
          {saving ? 'Сохраняю' : submitLabel}
        </button>
        <button type="button" onClick={onCancel} className={hrBtn.ghost}>
          Отмена
        </button>
        {answer.trim().length < 10 && <DisabledHint>Напиши хотя бы 10 знаков</DisabledHint>}
      </div>
    </form>
  )
}
