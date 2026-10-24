import { openKvasychChat } from '../components/chat/bus'
import { Mascot } from '../components/Mascot'
import { useReveal } from '../lib/motion'
import { nb } from '../lib/typo'
import { btn, Dash, sectionTitle } from './kit'
import { LEGEND, mentorCards, type MentorCard } from './legend'

const num = (i: number) => String(i + 1).padStart(2, '0')
const upperFirst = (t: string) => t.charAt(0).toUpperCase() + t.slice(1)

/** Карточка настоящего наставника по шаблону концепции. Показывается, только когда Учебный центр прислал её с согласием */
function Card({ m }: { m: MentorCard }) {
  return (
    <li className="border-t border-white/40 pt-5">
      {m.photo && <img src={m.photo} alt={m.name} loading="lazy" decoding="async" className="aspect-[4/5] w-full object-cover" />}
      <p className="mt-4 font-display text-[32px] leading-[0.9] font-black uppercase">{m.name}</p>
      <p className="mt-1 text-[15px] text-white/85">
        {m.unit} · {m.years}
      </p>
      <p className="mt-3 text-[17px] leading-snug">{nb(m.teaches)}</p>
      <p className="mt-2 text-[15px] leading-snug text-white/85">{nb(`Перед первой сменой: ${m.advice}`)}</p>
    </li>
  )
}

/**
 * Наставники — вторая половина легенды «Квас делают люди»: третий и четвёртый абзацы дословно (src/home/legend.ts).
 * Три шага на старте — по «Справочнику студента». Квасыч — собирательный образ наставника: поза «у пульта» встанет
 * в карточку, как только её нарисуют (public/mascot), лицо реального человека не выдумываем. Карточки настоящих
 * наставников — только из mentorCards
 */
export function Mentors() {
  const title = useReveal<HTMLHeadingElement>()
  return (
    <section id="mentors" className="bg-night py-20 text-white md:py-28">
      <div className="container-x grid grid-cols-[minmax(0,1fr)] gap-x-16 gap-y-12 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <div>
          <p className="font-display text-[17px] font-bold tracking-[0.08em] text-brand-bright uppercase">Как учат на заводе</p>
          <h2 ref={title} className={`mt-6 ${sectionTitle}`}>
            Наставник у&nbsp;каждого новичка
          </h2>
          <p className="mt-8 max-w-[640px] text-[clamp(20px,1.7vw,24px)] leading-snug font-medium">{nb(LEGEND.mentor.join(' '))}</p>

          <p className="mt-10 font-display text-[17px] font-bold tracking-[0.08em] uppercase">{LEGEND.stepsLead.replace(/:$/, '')}</p>
          <ol className="mt-4 border-t-[3px] border-white">
            {LEGEND.steps.map((step, i) => (
              <li key={step} className="flex items-baseline gap-5 border-b border-white/40 py-4 md:gap-8">
                <span className="font-display text-[22px] font-bold text-brand-bright tabular-nums md:text-[26px]" aria-hidden="true">
                  {num(i)}
                </span>
                <span className="font-display text-[clamp(36px,4vw,64px)] leading-[0.9] font-black uppercase">{upperFirst(step)}</span>
              </li>
            ))}
          </ol>
        </div>

        {/* Квасыч — проводник по сайту и боту. На заводе учит настоящий наставник: так и написано */}
        <aside className="self-end bg-white p-6 text-ink md:p-8" aria-labelledby="mentors-kvasych">
          <Mascot pose="mentor" className="mb-5 h-56 w-auto" />
          <p id="mentors-kvasych" className="font-display text-[clamp(44px,4.4vw,72px)] leading-[0.85] font-black uppercase">
            Квасыч
          </p>
          <p className="mt-4 text-[17px] leading-relaxed">{nb(LEGEND.kvasych)}</p>
          <button type="button" aria-haspopup="dialog" onClick={() => openKvasychChat('Кто будет учить?')} className={`${btn.red} mt-6 w-full justify-between`}>
            Спросить Квасыча
            <Dash />
          </button>
        </aside>

        {mentorCards.length > 0 && (
          <ul className="grid gap-8 sm:grid-cols-2 lg:col-span-2 lg:grid-cols-3">
            {mentorCards.map((m) => (
              <Card key={m.name} m={m} />
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
