import { AnimatePresence, motion } from 'motion/react'
import { useRef, useState } from 'react'
import { faq, type FaqId, type FaqItem } from '@shared/content/faq'
import { nb } from '../lib/typo'
import { useReveal } from '../lib/motion'
import { Dash, sectionTitle } from './kit'

const ease = [0.16, 1, 0.3, 1] as const

/** Сколько вопросов видно сразу; остальные — под кнопкой «Ещё». Порядок и тексты — из shared/content/faq.ts как есть */
const FAQ_VISIBLE = 8

// Вопрос с пустым ответом не показываем: ответ появится в faq.ts — появится и вопрос
const homeFaq: FaqItem[] = faq.filter((item) => item.a.trim())

const questionsWord = (n: number) => {
  const d = n % 10
  const h = n % 100
  if (d === 1 && h !== 11) return 'вопрос'
  if (d >= 2 && d <= 4 && (h < 12 || h > 14)) return 'вопроса'
  return 'вопросов'
}

export function Faq() {
  const [open, setOpen] = useState<FaqId | null>(null)
  const [all, setAll] = useState(false)
  const firstHidden = useRef<HTMLButtonElement>(null)
  const title = useReveal<HTMLHeadingElement>()
  const hidden = homeFaq.length - FAQ_VISIBLE
  const items = all ? homeFaq : homeFaq.slice(0, FAQ_VISIBLE)

  const showAll = () => {
    setAll(true)
    // Кнопка «Ещё» пропадает — фокус переходит на первый из открывшихся вопросов
    requestAnimationFrame(() => firstHidden.current?.focus())
  }

  return (
    <section id="faq" className="border-t border-white/10 bg-coal py-16 text-white md:py-24">
      <div className="container-x grid gap-8 lg:grid-cols-[5fr_7fr] lg:gap-20">
        <h2 ref={title} className={sectionTitle}>
          Вопросы
        </h2>
        <div>
          <ul className="border-t-[3px] border-white">
            {items.map((item, i) => {
              const isOpen = open === item.id
              return (
                <li key={item.id} className="border-b border-white/15">
                  <button
                    ref={i === FAQ_VISIBLE ? firstHidden : undefined}
                    onClick={() => setOpen(isOpen ? null : item.id)}
                    aria-expanded={isOpen}
                    aria-controls={`faq-${item.id}`}
                    className="flex w-full items-center justify-between gap-6 py-5 text-left font-display text-[clamp(28px,2.6vw,38px)] leading-none font-extrabold uppercase transition-colors hover:text-brand"
                  >
                    {item.q}
                    <span className={`relative block size-4 shrink-0 transition-transform duration-300 ${isOpen ? 'rotate-45 text-brand' : ''}`} aria-hidden="true">
                      <span className="absolute top-1/2 left-0 h-[2px] w-full -translate-y-1/2 bg-current" />
                      <span className="absolute top-0 left-1/2 h-full w-[2px] -translate-x-1/2 bg-current" />
                    </span>
                  </button>
                  <AnimatePresence initial={false}>
                    {isOpen && (
                      <motion.div
                        id={`faq-${item.id}`}
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.4, ease }}
                        className="overflow-hidden"
                      >
                        <p className="max-w-[620px] pb-6 text-[17px] leading-relaxed text-white/80 md:text-lg">{nb(item.a)}</p>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </li>
              )
            })}
          </ul>
          {!all && hidden > 0 && (
            <button
              onClick={showAll}
              className="group mt-6 flex items-center gap-4 font-display text-[22px] font-extrabold tracking-[0.05em] uppercase hover:text-brand"
            >
              Ещё {hidden} {questionsWord(hidden)}
              <Dash />
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
