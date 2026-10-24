import { motion } from 'motion/react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { applicationNumber, useSentApplication } from '../components/candidate/sent'
import { Photo, type PhotoName } from '../components/Photo'
import { BottleShape } from '../game/Bottle'
import { prefersReducedMotion } from '../lib/motion'
import { inviteUrl } from '../lib/ref'
import { useOffscreenPause } from '../lib/useOffscreenPause'
import { useActivities, type ActivityId } from '../store/activities'
import { nb } from '../lib/typo'
import { useGoToTask } from './taskNav'
import { nextTask, SHIFT_DONE_LEFT, tasks } from './tasks'
import { formatRub, minMonthlyPay, type Vacancy } from '@shared/content/vacancies'

/**
 * Пропорция «ширина строки / размер шрифта» для заголовков во всю ширину — замерена в шрифте
 * Sofia Sans Extra Condensed, font-black, заглавными. Новая строка без записи здесь замеряется один раз в браузере
 */
const FIT_RATIO: Record<string, number> = {
  Работа: 2.5692,
  'на лето': 2.8014,
  'Работа на лето': 5.4964,
  Откликнуться: 5.434,
  'Моя заявка': 4.3571,
}

const capped = (size: string, max?: string) => (max ? `min(${size}, ${max})` : size)

/**
 * Строка, растянутая ровно на ширину контейнера, без замеров на каждом кадре: размер шрифта считает CSS
 * через единицы контейнера (100cqi / пропорция строки). JS меряет один раз — для строки, которой нет в FIT_RATIO,
 * и заново, только если строка перестала помещаться: человек включил свои интервалы между буквами и словами (WCAG 1.4.12).
 * max — потолок кегля (CSS-длина, например 21svh): строка тогда может быть уже контейнера, и это не повод перемерять
 */
export function FitLine({ children, className = '', max }: { children: string; className?: string; max?: string }) {
  const known = FIT_RATIO[children]
  const [measured, setMeasured] = useState(0)
  const text = useRef<HTMLSpanElement>(null)
  const ratio = measured || known

  useLayoutEffect(() => {
    const el = text.current
    if (!el) return
    let alive = true
    let measuredOnce = false
    // Ширина строки при 100px с текущими интервалами: em-интервалы растут вместе с кеглем, пропорция остаётся верной
    const measure = () => {
      if (!alive || !el.parentElement) return
      measuredOnce = true
      const probe = el.cloneNode(true) as HTMLSpanElement
      probe.style.cssText = 'position:absolute;visibility:hidden;font-size:100px;transition:none'
      el.parentElement.appendChild(probe)
      const width = probe.getBoundingClientRect().width
      probe.remove()
      if (width) setMeasured(width / 100)
    }
    if (!known) measure()
    // Замер мог случиться на запасном шрифте — после загрузки настоящего меряем ещё раз
    document.fonts.ready.then(() => (!known || measuredOnce) && measure())
    // Проверяем, только когда меняется размер самой строки — кегль, шрифт или интервалы. Не влезает или
    // заметно не дотягивает до края (замер пришёлся на запасной шрифт) — меряем заново; иначе ничего не делаем
    const ro = new ResizeObserver(() => {
      const box = el.parentElement
      if (!box) return
      const diff = el.offsetWidth - box.clientWidth
      if (diff > 1 || (!max && diff < -box.clientWidth * 0.02)) measure()
    })
    ro.observe(el)
    return () => {
      alive = false
      ro.disconnect()
    }
  }, [children, known, max])

  return (
    // overflow-x: clip — пока грузится шрифт, запасной шире и не должен давать горизонтальную прокрутку
    <div className="w-full [container-type:inline-size] [overflow-x:clip]">
      <span
        ref={text}
        className={`inline-block whitespace-nowrap ${className}`}
        // Запас 0,4 %: дробные пиксели не должны обрезать последнюю букву
        style={{ fontSize: capped(ratio ? `calc(100cqi / ${(ratio * 1.004).toFixed(4)})` : '10cqi', max) }}
      >
        {children}
      </span>
    </div>
  )
}

/**
 * Двухцветное фото: чёрно-белый кадр, умноженный на фирменный красный (или просто монохром).
 * Трансформации вешаем на обёртку, иначе смешивание не увидит красный фон.
 */
export function Duo({
  name,
  sizes,
  tone = 'red',
  priority,
  className = '',
  imgClassName = '',
}: {
  name: PhotoName
  sizes: string
  tone?: 'red' | 'mono'
  priority?: boolean
  className?: string
  imgClassName?: string
}) {
  return (
    // Позиционирование задаёт вызывающий (absolute/relative), иначе по умолчанию relative
    <div className={`${/\b(absolute|fixed|sticky)\b/.test(className) ? '' : 'relative'} overflow-hidden ${tone === 'red' ? 'bg-brand' : 'bg-night'} ${className}`}>
      <Photo
        name={name}
        alt=""
        sizes={sizes}
        priority={priority}
        className="absolute inset-0 !bg-none"
        imgClassName={`${tone === 'red' ? 'grayscale contrast-[1.35] brightness-[1.05] mix-blend-multiply' : 'grayscale contrast-[1.15]'} ${imgClassName}`}
      />
    </div>
  )
}

/**
 * Бегущая строка с фактами. Встаёт, когда её не видно, при наведении, при фокусе внутри и кнопкой «Пауза».
 * При «уменьшить движение» — обычный список с переносом строк: все факты видны целиком и на телефоне
 */
export function Ticker({ items, className = '', speed = 40 }: { items: string[]; className?: string; speed?: number }) {
  const { ref, paused } = useOffscreenPause<HTMLDivElement>()
  const [stopped, setStopped] = useState(false)
  const row = (copy: boolean) => (
    <ul
      className={`flex shrink-0 items-center motion-reduce:shrink motion-reduce:flex-wrap motion-reduce:gap-y-1 ${copy ? 'motion-reduce:hidden' : ''}`}
      aria-hidden={copy || undefined}
    >
      {items.map((item) => (
        <li key={item} className="flex items-center motion-reduce:items-start">
          <span className="px-6 whitespace-nowrap motion-reduce:pr-6 motion-reduce:pl-0 motion-reduce:whitespace-normal">{item}</span>
          {/* В бегущей строке квадрат — разделитель после факта, в списке — маркер перед ним */}
          <i className="size-2 shrink-0 bg-current motion-reduce:order-first motion-reduce:mt-[0.5em] motion-reduce:mr-3" />
        </li>
      ))}
    </ul>
  )
  return (
    <div ref={ref} data-ticker className={`group relative overflow-hidden ${className}`}>
      <div
        className="flex w-max animate-[belt-roll_var(--speed)_linear_infinite] group-has-[:focus-visible]:[animation-play-state:paused] motion-reduce:w-auto motion-reduce:animate-none motion-reduce:px-5 md:motion-reduce:px-10 group-hover:[animation-play-state:paused]"
        // Пока строка едет, состояние задают классы (наведение, фокус); стоит — всегда стоит
        style={{ ['--speed' as string]: `${speed}s`, animationPlayState: paused || stopped ? 'paused' : undefined }}
      >
        {row(false)}
        {row(true)}
      </div>
      <button
        type="button"
        onClick={() => setStopped(!stopped)}
        className="absolute inset-y-0 right-0 bg-inherit px-4 font-display text-[15px] font-bold tracking-[0.08em] uppercase underline decoration-2 underline-offset-4 motion-reduce:hidden md:px-8 md:text-[17px]"
      >
        {stopped ? 'Пуск' : 'Пауза'}
        <span className="sr-only"> бегущей строки</span>
      </button>
    </div>
  )
}

/**
 * Бутылка «Смены»: силуэт той же бутылки, что в игре, налив цвета кваса. onRed — на красной полосе: налив белый
 * (контур — цвет текста). Контур одной толщины при любом размере — .shift-bottle в index.css
 */
export function ShiftBottle({ full, onRed = false, className = '' }: { full: boolean; onRed?: boolean; className?: string }) {
  return <BottleShape level={full ? 1 : 0} fill={onRed ? 'white' : 'kvass'} duration={900} className={`shift-bottle ${className}`} />
}

/**
 * Шов-лента между двумя секциями одного цвета: та же полоса, что под бутылками первого экрана.
 * Рёбра сдвигаются только от прокрутки (CSS-переменная --seam-x), в покое кадров нет; при «уменьшить движение» стоят
 */
export function BeltSeam({ className = '' }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || prefersReducedMotion() || typeof IntersectionObserver === 'undefined') return
    let visible = false
    const move = () => {
      if (visible) el.style.setProperty('--seam-x', `${((window.scrollY * 0.5) % 40).toFixed(1)}px`)
    }
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting
      move()
    })
    io.observe(el)
    window.addEventListener('scroll', move, { passive: true })
    return () => {
      io.disconnect()
      window.removeEventListener('scroll', move)
    }
  }, [])
  return (
    <div ref={ref} className={`belt-seam relative h-2.5 overflow-hidden ${className}`} aria-hidden="true">
      <div className="belt-seam-ribs absolute inset-y-0 right-0 -left-10" />
    </div>
  )
}

/**
 * Метка задания в секции: номер по порядку на странице, четыре бутылки и статус.
 * light — белый текст на тёмном фоне, onRed — на красном: текст и налив бутылок белые
 */
export function TaskLabel({ id, light = false, onRed = false, className = '' }: { id: ActivityId; light?: boolean; onRed?: boolean; className?: string }) {
  const done = useActivities((s) => s.done)
  const index = tasks.findIndex((t) => t.id === id)
  const isDone = !!done[id]
  return (
    <div className={`flex items-center gap-4 font-display text-[17px] font-bold tracking-[0.08em] uppercase ${light || onRed ? 'text-white' : 'text-ink'} ${className}`}>
      <span className="flex gap-1">
        {tasks.map((t) => (
          <ShiftBottle key={t.id} full={!!done[t.id]} onRed={onRed} className={`h-6 w-auto ${t.id === id ? '' : 'opacity-40'}`} />
        ))}
      </span>
      <span>
        Задание {index + 1} из {tasks.length}
        {isDone && <span className="font-medium"> · выполнено</span>}
      </span>
    </div>
  )
}

/** Заголовок обычной секции — на уровень тише гигантских заголовков первого экрана */
export const sectionTitle = 'font-display text-[clamp(48px,6.5vw,104px)] leading-[0.86] font-black uppercase'

const buttonBase =
  'group inline-flex h-16 items-center justify-center gap-4 whitespace-nowrap px-8 font-display text-[22px] font-extrabold tracking-[0.05em] uppercase transition-colors duration-300'

export const btn = {
  red: `${buttonBase} bg-brand text-white hover:bg-white hover:text-brand`,
  white: `${buttonBase} bg-white text-ink hover:bg-brand hover:text-white`,
  ink: `${buttonBase} bg-ink text-white hover:bg-brand`,
  ghost: `${buttonBase} text-white ring-1 ring-white/60 ring-inset hover:bg-white hover:text-ink hover:ring-white`,
  ghostInk: `${buttonBase} text-ink ring-1 ring-ink/50 ring-inset hover:bg-ink hover:text-white hover:ring-ink`,
}

/** Короткая горизонтальная черта, которая удлиняется при наведении — вместо иконки-стрелки */
export function Dash() {
  return <span className="block h-[2px] w-6 bg-current transition-[width] duration-500 ease-out-expo group-hover:w-10" />
}

export function ButtonLink({ to, variant = 'red', children, className = '' }: { to: string; variant?: keyof typeof btn; children: ReactNode; className?: string }) {
  return (
    <Link to={to} className={`${btn[variant]} ${className}`}>
      {children}
      <Dash />
    </Link>
  )
}

/** Зарплата вакансии строкой; у бесплатной практики — «без оплаты», у практик с примерной суммой — пометка «ориентир» */
export function payText(v: Vacancy) {
  if (!v.pay) return v.format === 'Бесплатная практика' ? 'без оплаты' : 'по итогам собеседования'
  const rub = (n: number) => n.toLocaleString('ru-RU')
  return v.pay.to ? `${rub(v.pay.from)}–${rub(v.pay.to)}\u00A0₽` : `от ${rub(v.pay.from)}\u00A0₽`
}

/** Пометка «ориентир». light — на тёмном фоне, onRed — на красном (там читается только чистый белый) */
export function EstimateNote({ v, light = false, onRed = false }: { v: Vacancy; light?: boolean; onRed?: boolean }) {
  if (!v.pay?.estimate) return null
  return (
    <span className={`ml-2 align-middle font-sans text-[13px] font-medium tracking-normal normal-case ${onRed ? 'text-white' : light ? 'text-white/70' : 'text-mute'}`}>
      ориентир
    </span>
  )
}

/**
 * Следующий шаг после задания: отклик на конкретную вакансию и переход к следующему заданию.
 * Если все задания выполнены — вместо перехода ссылка к финалу.
 */
export function NextStep({
  after,
  vacancy,
  tone = 'dark',
  className = '',
}: {
  after: ActivityId
  vacancy?: Vacancy
  tone?: 'dark' | 'red' | 'light'
  className?: string
}) {
  const done = useActivities((s) => s.done)
  const sent = useSentApplication((s) => s.last)
  const goTo = useGoToTask()
  const next = nextTask(done, after)
  const apply = tone === 'light' ? btn.ink : tone === 'red' ? btn.white : btn.red
  const ghost = tone === 'light' ? btn.ghostInk : btn.ghost
  if (!next) return <ShiftComplete tone={tone} vacancy={vacancy} className={className} />
  return (
    <div className={`flex flex-col gap-3 sm:flex-row sm:flex-wrap ${className}`}>
      {/* Заявка уже отправлена — «Откликнуться» больше не предлагаем */}
      {vacancy && !sent && (
        <Link to={`/apply?vacancy=${vacancy.id}`} className={`${apply} !h-auto min-h-16 !whitespace-normal py-3 text-left leading-[1.05]`}>
          <span>
            Откликнуться: {vacancy.title}
            <span className="opacity-70">, {payText(vacancy)}</span>
          </span>
          <Dash />
        </Link>
      )}
      <button
        onClick={() => goTo(next)}
        className={`${ghost} !h-auto min-h-16 !whitespace-normal py-3 text-left leading-[1.05]`}
      >
        {`Следующее задание: ${next.label}`}
        <Dash />
      </button>
    </div>
  )
}

/**
 * Смена закрыта: спокойный момент без конфетти — бутылки заполняются по очереди,
 * и сразу понятно, что дальше: заявка уже наполовину заполнена.
 */
function ShiftComplete({ tone, vacancy, className = '' }: { tone: 'dark' | 'red' | 'light'; vacancy?: Vacancy; className?: string }) {
  const sent = useSentApplication((s) => s.last)
  const line = tone === 'light' ? 'border-ink' : 'border-white'
  const quiet = tone === 'light' ? 'text-ink/75' : tone === 'red' ? 'text-white' : 'text-white/80'
  const apply = tone === 'light' ? btn.ink : tone === 'red' ? btn.white : btn.red
  return (
    <div className={`border-t-[3px] pt-5 ${line} ${className}`} role="status">
      <div className="flex items-center gap-4">
        <span className="flex gap-1">
          {tasks.map((t, i) => (
            <motion.span key={t.id} initial={{ opacity: 0.35 }} animate={{ opacity: 1 }} transition={{ delay: 0.15 * i, duration: 0.5 }}>
              <ShiftBottle full onRed={tone === 'red'} className="h-9 w-auto" />
            </motion.span>
          ))}
        </span>
        <p className="font-display text-[clamp(28px,2.8vw,40px)] leading-none font-black uppercase">Смена закрыта: <span className="whitespace-nowrap">4 из 4</span></p>
      </div>
      <p className={`mt-3 max-w-[560px] text-[17px] leading-relaxed ${quiet}`}>
        {sent ? (
          <>Заявка уже у&nbsp;HR, номер {applicationNumber(sent.id)}.</>
        ) : (
          <>{nb(SHIFT_DONE_LEFT)}</>
        )}
      </p>
      <Link to={!sent && vacancy ? `/apply?vacancy=${vacancy.id}` : '/apply'} className={`${apply} mt-5`}>
        {sent ? 'Моя заявка' : 'Откликнуться'}
        <Dash />
      </Link>
    </div>
  )
}

/**
 * Невидимая строка для экранных читалок: всё, что в неё попадает, зачитывается вслух.
 * Новое сообщение — новый key, чтобы одинаковый текст тоже прозвучал.
 */
export function Announce({ message }: { message: { key: number; text: string } | null }) {
  return (
    <p className="sr-only" aria-live="polite" aria-atomic="true">
      {message && <span key={message.key}>{message.text}</span>}
    </p>
  )
}

/** Сообщение для Announce и счётчик, чтобы повторы тоже читались */
let announceSeq = 0
export const say = (text: string) => ({ key: ++announceSeq, text })

/**
 * «Позвать друга» — и до своей заявки, и после: системное меню на телефоне, иначе ссылка в буфер.
 * В ссылке личный код этого браузера (?src=ref_<код>, src/lib/ref.ts): HR увидит, кто кого позвал, и свяжет две заявки
 */
export function useInvite() {
  const [status, setStatus] = useState('')
  const invite = async () => {
    const url = inviteUrl()
    const text = `Оплачиваемая практика в «Очаково»: от ${formatRub(minMonthlyPay)} в месяц до вычета налога, опыт не нужен, учит наставник. Заявка занимает 2 минуты.`
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Сезон в «Очаково»', text, url })
        return
      }
      await navigator.clipboard.writeText(`${text} ${url}`)
      setStatus('Ссылка скопирована, отправь её другу.')
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setStatus(`Скопируй ссылку: ${url}`)
    }
  }
  return { invite, status }
}
