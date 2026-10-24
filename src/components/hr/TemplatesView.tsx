import { useEffect, useState } from 'react'
import { templateKeys } from '@shared/applications'
import { placeholders, renderTemplate } from '@shared/notifyText'
import { ApiValidationError, saveTemplate, type NotifyTemplate } from '../../lib/api'
import { loadTemplates } from './templatesCache'
import { HrTextArea, hrBtn, Notice } from './ui'

/** Пример кандидата для предпросмотра */
const sample = {
  name: 'Аня Кузнецова',
  id: 'K7M2PQ9X',
  vacancyId: 'bottling-operator',
}
/** Пример собеседования в 11:00, а первой смены — в 8:00: с этого часа начинается дневная смена */
const sampleSlot = (hour = 11) => {
  const wall = new Date(Date.now() + 3 * 3600e3 + 3 * 864e5)
  wall.setUTCHours(hour, 0, 0, 0)
  return { startsAt: new Date(wall.getTime() - 3 * 3600e3).toISOString(), address: 'Москва, ул. Рябиновая, 44', bring: 'паспорт' }
}

const hints: Record<string, string> = {
  name: 'имя',
  id: 'номер заявки',
  vacancy: 'вакансия, если выбрана',
  ref: '«по заявке № …» или «по твоему отклику на hh.ru»',
  request: '«заявку № …» или «отклик на hh.ru»',
  date: 'день недели и дата',
  time: 'время',
  address: 'адрес',
  bring: 'что взять',
}

/** Тексты сообщений кандидату в боте. Предпросмотр меняется сразу, пока печатаешь */
export function TemplatesView() {
  const [list, setList] = useState<NotifyTemplate[] | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    loadTemplates(true)
      .then((l) => (l.length ? setList(l) : setError(true)))
      .catch(() => setError(true))
  }, [])

  return (
    <section aria-labelledby="tpl-title">
      <h2 id="tpl-title" className="sr-only">
        Уведомления
      </h2>
      <p className="mt-2 max-w-3xl text-[14px] leading-snug text-white/55">
        Сообщения уходят в&nbsp;бот кандидатам, подавшим заявку через бота, и&nbsp;тем, кто привязал к&nbsp;боту заявку с&nbsp;сайта. Отправка идёт через 20 секунд после действия, до&nbsp;этого HR может нажать «Отменить».
        Остальным панель показывает этот же текст, чтобы позвонить или написать. В&nbsp;напоминании о&nbsp;первой смене {'{date}'} и&nbsp;{'{time}'} означают день и&nbsp;начало смены. Подстановки:{' '}
        {placeholders.map((p, i) => (
          <span key={p}>
            <code className="text-white/80">{`{${p}}`}</code> ({hints[p]})
            {i < placeholders.length - 1 ? ', ' : '.'}
          </span>
        ))}
      </p>
      {error && (
        <div className="mt-5">
          <Notice tone="error">Тексты не загрузились. Обнови страницу.</Notice>
        </div>
      )}
      <div className="mt-6 grid gap-10 xl:grid-cols-2">
        {(list ?? []).map((t) => (
          <TemplateCard key={t.key} template={t} />
        ))}
      </div>
    </section>
  )
}

function TemplateCard({ template }: { template: NotifyTemplate }) {
  const [text, setText] = useState(template.text)
  const [enabled, setEnabled] = useState(template.enabled)
  const [saved, setSaved] = useState(template)
  const [message, setMessage] = useState<{ tone: 'info' | 'error'; text: string } | null>(null)
  const meta = templateKeys.find((k) => k.id === template.key)!
  const dirty = text.trim() !== saved.text || enabled !== saved.enabled
  const shift = template.key === 'shift_reminder' || template.key === 'sms_shift_reminder'
  const slot = shift ? sampleSlot(8) : ['interview', 'reminder', 'sms_interview', 'sms_reminder'].includes(template.key) ? sampleSlot() : null
  const sms = template.key.startsWith('sms_')
  const preview = renderTemplate(text, sample, slot)
  /** Кириллица: одно SMS — 70 знаков, длинное делится на части по 67 */
  const parts = preview.length <= 70 ? 1 : Math.ceil(preview.length / 67)

  const save = async () => {
    setMessage(null)
    try {
      const next = await saveTemplate(template.key, { text: text.trim(), enabled })
      setSaved(next)
      setText(next.text)
      void loadTemplates(true)
      setMessage({ tone: 'info', text: 'Сохранено. Следующие сообщения уйдут с новым текстом.' })
    } catch (e) {
      setMessage({ tone: 'error', text: e instanceof ApiValidationError ? e.message : 'Не сохранилось. Попробуй ещё раз.' })
    }
  }

  const id = `tpl-${template.key}`
  return (
    <article className="flex flex-col gap-3 border-t-[3px] border-double border-white/60 pt-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-display text-[24px] leading-none font-black uppercase">{meta.label}</h3>
          <p className="mt-1 text-[13px] text-white/50">{meta.hint}</p>
        </div>
        <label className="flex shrink-0 cursor-pointer items-center gap-2 text-[14px] text-white/70">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="size-4 accent-[var(--color-brand)]" />
          {enabled ? 'Отправлять' : 'Не отправлять'}
        </label>
      </div>
      <label htmlFor={id} className="sr-only">
        Текст: {meta.label}
      </label>
      <HrTextArea id={id} rows={5} value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} />
      <div className="bg-white/[0.04] p-3 text-[14px] leading-snug text-white/70">
        <p className="mb-1.5 text-[12px] tracking-[0.1em] text-white/55 uppercase">Так увидит кандидат</p>
        {preview}
        {sms && (
          <span className={`mt-2 block text-[12px] ${parts > 3 ? 'text-periwinkle' : 'text-white/60'}`}>
            {preview.length} знаков, {parts} SMS{parts > 3 ? '. Это дорого, сократи текст' : ''}
          </span>
        )}
      </div>
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      <button onClick={save} disabled={!dirty} className={`${hrBtn.small} w-fit bg-brand text-white hover:bg-white hover:text-brand`}>
        Сохранить
      </button>
    </article>
  )
}
