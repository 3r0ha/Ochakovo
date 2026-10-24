import { useState, type FormEvent, type ReactNode } from 'react'
import type { ChatButton, ChatEntry } from './useChat'

/** **жирный** → <strong>, остальное — как есть, с переносами строк */
function rich(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? (
      <strong key={i} className="font-semibold text-white">
        {part.slice(2, -2)}
      </strong>
    ) : (
      part
    ),
  )
}

const buttonBase =
  'min-h-11 grow basis-[6.5rem] px-3 py-2 text-left text-[15px] leading-snug font-medium ring-1 ring-inset transition-colors duration-200 disabled:cursor-default'

function ContactButton({ text, active, onSend }: { text: string; active: boolean; onSend: (phone: string) => void }) {
  const [open, setOpen] = useState(false)
  const [phone, setPhone] = useState('')
  const valid = phone.replace(/\D/g, '').length >= 10

  if (!open)
    return (
      <button
        type="button"
        disabled={!active}
        onClick={() => setOpen(true)}
        className={`${buttonBase} ${active ? 'text-white ring-white/25 hover:bg-white hover:text-ink' : 'text-white/35 ring-white/10'}`}
      >
        {text}
      </button>
    )

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (valid) onSend(phone.trim())
  }

  return (
    <form onSubmit={submit} className="flex grow basis-full gap-2">
      <label className="sr-only" htmlFor="chat-phone">
        Номер телефона
      </label>
      <input
        id="chat-phone"
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        autoFocus
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        placeholder="+7 999 123-45-67"
        className="min-h-11 min-w-0 flex-1 bg-white px-3 text-[16px] text-ink outline-none placeholder:text-ink/40"
      />
      <button
        type="submit"
        disabled={!valid}
        className="min-h-11 shrink-0 bg-brand px-4 font-display text-[17px] font-extrabold tracking-[0.04em] text-white uppercase transition-colors disabled:bg-coal disabled:text-white/40 disabled:ring-1 disabled:ring-white/10 disabled:ring-inset"
      >
        Отправить
      </button>
    </form>
  )
}

type Props = {
  entry: ChatEntry
  /** Кнопки активны только у последнего ответа бота */
  active: boolean
  onPress: (button: ChatButton, sourceId: string) => void
  onContact: (phone: string) => void
}

/** «Меню» — только под последним ответом: под каждым старым сообщением оно повторялось бы */
const isMenuRow = (row: ChatButton[]) => row.every((b) => b.kind === 'action' && b.action === 'm')

export function Message({ entry, active, onPress, onContact }: Props) {
  if (entry.from === 'user')
    return (
      <div className="flex justify-end" data-entry={entry.id}>
        <p className="max-w-[85%] bg-brand px-4 py-2.5 text-[15px] leading-snug whitespace-pre-line text-white">{entry.text}</p>
      </div>
    )

  const rows = (entry.buttons ?? []).filter((row) => active || !isMenuRow(row))

  return (
    // Ответы бота во всю ширину ленты — сообщения человека выровнены по тому же правому краю
    <div data-entry={entry.id}>
      {entry.image && (
        <img
          src={entry.image}
          alt=""
          loading="lazy"
          decoding="async"
          className="mb-2 block max-h-[280px] w-full bg-coal object-contain"
        />
      )}
      {entry.text && <p className="bg-coal px-4 py-3 text-[15px] leading-relaxed whitespace-pre-line text-white/85">{rich(entry.text)}</p>}
      {rows.length ? (
        <div className="mt-2 flex flex-col gap-2">
          {rows.map((row, r) => (
            <div key={r} className="flex flex-wrap gap-2">
              {row.map((b, i) => {
                const key = `${r}-${i}`
                if (b.kind === 'link')
                  return (
                    <a
                      key={key}
                      href={b.url}
                      target="_blank"
                      rel="noreferrer"
                      className={`${buttonBase} flex items-center justify-between gap-2 text-white ring-white/25 hover:bg-white hover:text-ink`}
                    >
                      {b.text}
                      <span aria-hidden="true" className="block h-[2px] w-4 shrink-0 bg-current" />
                    </a>
                  )
                if (b.kind === 'contact') return <ContactButton key={key} text={b.text} active={active} onSend={onContact} />
                return (
                  <button
                    key={key}
                    type="button"
                    disabled={!active}
                    onClick={() => onPress(b, entry.id)}
                    className={`${buttonBase} ${active ? 'text-white ring-white/25 hover:bg-white hover:text-ink' : 'text-white/35 ring-white/10'}`}
                  >
                    {b.text}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
