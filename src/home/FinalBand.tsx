import { Link } from 'react-router'
import { applicationNumber, useSentApplication } from '../components/candidate/sent'
import { scrollToTarget } from '../lib/motion'
import { nb } from '../lib/typo'
import { selectDoneCount, useActivities } from '../store/activities'
import { FitLine, ShiftBottle, useInvite } from './kit'
import { HEADER_OFFSET, SHIFT_DONE_LEFT, SHIFT_HINT, tasks } from './tasks'

/** Финал: статус смены и полоса во всю ширину — «Откликнуться» или, после отправки, «Моя заявка» */
export function FinalBand() {
  const done = useActivities((s) => s.done)
  const count = useActivities(selectDoneCount)
  const sent = useSentApplication((s) => s.last)
  const { invite, status } = useInvite()
  const closed = count === tasks.length
  const left = tasks.filter((t) => !done[t.id])
  const label = sent ? 'Моя заявка' : 'Откликнуться'

  return (
    <section id="final" className="border-t border-white/10 bg-night text-white">
      <div className="container-x flex flex-col gap-5 border-b border-white/30 py-8 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-4">
          <span className="flex gap-1">
            {tasks.map((t) => (
              <ShiftBottle key={t.id} full={!!done[t.id]} className="h-9 w-auto" />
            ))}
          </span>
          <p className="font-display text-[clamp(26px,2.6vw,36px)] leading-none font-black whitespace-nowrap uppercase">
            {closed ? 'Смена закрыта: 4 из 4' : `Смена ${count} из 4`}
          </p>
        </div>
        <div className="flex flex-col gap-2 md:items-end">
          {sent ? (
            <p className="text-[15px] leading-relaxed md:text-right md:text-[17px]">
              Заявка отправлена, номер {applicationNumber(sent.id)}.{' '}
              <button type="button" onClick={invite} className="py-2.5 font-semibold underline decoration-white/60 underline-offset-4 hover:decoration-white">
                Позвать друга
              </button>
            </p>
          ) : (
            <>
              <p className="max-w-[620px] text-[15px] leading-relaxed text-white/90 md:text-right md:text-[17px]">
                {closed ? (
                  nb(SHIFT_DONE_LEFT)
                ) : (
                  <>
                    {SHIFT_HINT}. Осталось:{' '}
                    {left.map((t, i) => (
                      <span key={t.id}>
                        <button type="button" onClick={() => scrollToTarget(t.anchor, HEADER_OFFSET)} className="py-2.5 underline decoration-white/50 underline-offset-4 hover:decoration-white">
                          {t.label}
                        </button>
                        {i < left.length - 1 ? ', ' : '.'}
                      </span>
                    ))}
                  </>
                )}
              </p>
              {/* Позвать друга можно и до своей заявки: в ссылке личный код, HR свяжет две заявки */}
              <button
                type="button"
                onClick={invite}
                className="self-start py-2 text-[15px] font-semibold underline decoration-white/60 underline-offset-4 hover:decoration-white md:self-end md:text-[17px]"
              >
                Позвать друга
              </button>
            </>
          )}
          {status && (
            <p className="text-[15px] md:text-right" role="status">
              {status}
            </p>
          )}
        </div>
      </div>

      <Link to="/apply" className="group block px-4 py-8 transition-colors hover:text-brand-bright md:px-8 md:py-10">
        <span className="sr-only">{label}</span>
        <span aria-hidden="true" className="flex items-center gap-[2vw] font-display leading-[0.8] font-black uppercase">
          <span className="min-w-0 flex-1">
            <FitLine>{label}</FitLine>
          </span>
          <span className="shrink-0 text-[14vw] text-brand transition-transform duration-500 ease-out-expo group-hover:translate-x-3">→</span>
        </span>
      </Link>
    </section>
  )
}
