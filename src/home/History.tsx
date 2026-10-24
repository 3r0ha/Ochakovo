import { brands, companyFigures, timeline } from '@shared/content/company'
import { useReveal } from '../lib/motion'
import { nb } from '../lib/typo'
import { sectionTitle } from './kit'
import { LEGEND } from './legend'
import { Pictogram, type PictogramId } from './Pictogram'

/**
 * Пиктограмма года: комбинат к Олимпиаде-80 — установка с ёмкостями, двойное брожение — цилиндро-конический танк,
 * квас «Очаковский» — бутылка, сегодня — свои поля и солодовня (колосья)
 */
const stopPictogram: Record<string, PictogramId> = {
  olympics: 'tank-unit',
  'double-fermentation': 'cct',
  ochakovsky: 'glass-bottle',
  today: 'ears',
}

/** Три года из легенды: год и заголовок — из таймлайна shared, текст — предложение легенды про этот год */
const stops = LEGEND.years.map((y) => {
  const t = timeline.find((x) => x.id === y.id)
  return { id: y.id, when: t?.when ?? '', title: t?.title ?? '', text: y.text }
})
const today = timeline.find((t) => t.id === 'today')

/**
 * «Квас делают люди»: история и бренды для кейса. Легенда концепции, короткий таймлайн из трёх лет и «сегодня»
 * и «Очаково» сегодня в цифрах. Фон — тёмный, как у всей страницы: цвет кваса остаётся у самого кваса (лента, бутылка «Собери лето»).
 * Фото не берём: архивные кадры уже стоят в «Правде или мифе», а каждое фото на главной — один раз. Вместо фото — крупные годы
 * и фирменные пиктограммы красным
 */
export function History() {
  const title = useReveal<HTMLHeadingElement>()
  return (
    <section id="history" className="relative overflow-hidden bg-coal py-20 text-white md:py-28">
      <div className="container-x relative">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-x-16 gap-y-6 lg:grid-cols-[minmax(0,6fr)_minmax(0,6fr)] lg:items-end">
          <div>
            <p className="font-display text-[17px] font-bold tracking-[0.08em] uppercase">История «Очаково»</p>
            <h2 ref={title} className={`mt-6 ${sectionTitle}`}>
              {LEGEND.title}
            </h2>
          </div>
          <p className="max-w-[620px] text-[clamp(22px,2vw,30px)] leading-snug font-medium lg:pb-2">{nb(LEGEND.lead)}</p>
        </div>

        <ol className="mt-12 grid grid-cols-[minmax(0,1fr)] border-t-[3px] border-white md:mt-16 lg:grid-cols-3" aria-label="Годы истории">
          {stops.map((s) => (
            <li key={s.id} data-history-stop={s.id} className="border-b border-white/25 py-7 lg:border-r lg:border-b-0 lg:px-8 lg:first:pl-0 lg:last:border-r-0 lg:last:pr-0">
              <div className="flex items-start justify-between gap-4">
                <p className="font-display text-[clamp(96px,9.6vw,156px)] leading-[0.78] font-black tabular-nums">{s.when}</p>
                <Pictogram id={stopPictogram[s.id]} className="size-12 text-brand-bright md:size-14" />
              </div>
              <h3 className="mt-5 font-display text-[clamp(28px,2.4vw,36px)] leading-[0.95] font-extrabold uppercase">{nb(s.title)}</h3>
              <p className="mt-3 max-w-[460px] text-[17px] leading-relaxed text-white/85">{nb(s.text)}</p>
            </li>
          ))}
        </ol>

        {/* Сегодня: цифры крупно, без абзаца — те же источники, что у пункта «Сегодня» в таймлайне */}
        <div className="mt-14 md:mt-20">
          <div className="flex flex-col gap-3 border-b-[3px] border-white pb-5 md:flex-row md:items-end md:justify-between md:gap-10">
            <div className="flex items-end gap-5">
              <h3 className="font-display text-[clamp(64px,7vw,112px)] leading-[0.8] font-black uppercase">{today?.when ?? 'Сегодня'}</h3>
              <Pictogram id={stopPictogram.today} className="mb-1 size-12 text-brand-bright md:size-14" />
            </div>
            {today && <p className="font-display text-[clamp(24px,2.2vw,34px)] leading-[0.95] font-extrabold uppercase md:text-right">{nb(today.title)}</p>}
          </div>
          <dl className="grid grid-cols-2 lg:grid-cols-3">
            {companyFigures.map((f) => (
              <div key={f.id} className="flex flex-col-reverse justify-end gap-2 border-b border-white/25 py-5 pr-4 md:py-7">
                <dt className="max-w-[300px] text-[15px] leading-snug text-white/85 md:text-[17px]">{nb(f.label)}</dt>
                <dd className="font-display text-[clamp(52px,5.6vw,92px)] leading-[0.8] font-black whitespace-nowrap tabular-nums">{f.value}</dd>
              </div>
            ))}
          </dl>
        </div>

        {/* Бренды: квас первым и крупнее, остальные — с подписью, что это */}
        <div className="mt-14 md:mt-16">
          <h3 className="font-display text-[17px] font-bold tracking-[0.08em] uppercase">Что выпускает «Очаково»</h3>
          <ul className="mt-5 flex flex-wrap items-baseline gap-x-8 gap-y-4 border-t border-white/25 pt-5 md:gap-x-12">
            {brands.map((b) => (
              <li key={b.id} className="flex flex-col">
                <span className={`font-display leading-[0.9] font-black uppercase ${b.key ? 'text-[clamp(36px,3.6vw,56px)]' : 'text-[clamp(26px,2.4vw,36px)]'}`}>
                  {b.name}
                </span>
                <span className="mt-1 text-[15px] text-white/75">{b.kind}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  )
}
