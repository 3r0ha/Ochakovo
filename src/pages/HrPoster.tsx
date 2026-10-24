import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'
import { encodeQr, type QrCode } from '@shared/qr'
import { practicePrint, shortLink, siteBase, sourceKinds, sourceLinks, type PracticePrint } from '@shared/sources'
import { loadSources, useSources } from '../components/hr/sourcesCache'
import { GAME_SECONDS } from '../game/useConveyorGame'
import { nb } from '../lib/typo'
import { A5, FlyerBack, FlyerFront, PrintLogo, QrImage } from './HrFlyer'

// Печать для точек контакта с QR на метку источника (вкладка «Источники» в HR-панели):
//   /hr/poster?src=<метка>             — плакат A3 для стенда на ярмарке, в вузе, на экскурсии
//   /hr/poster?src=<метка>&format=a5   — листовка A5, лицевая и оборот (src/pages/HrFlyer.tsx)
// QR ведёт на сайт с меткой: /?src=<метка>. Адрес сайта — SITE_URL с сервера, без входа в панель — адрес этой страницы.
// Цифры — из shared (practicePrint): суммы, отделы, общежитие, телефоны. Дат на макетах нет.
// Печать из браузера: «Печать» → «Сохранить как PDF» или принтер, поля «Нет», фон включён. Без шапки сайта.

const A3 = { w: 297, h: 420 }
const MM = 96 / 25.4

type Format = 'a3' | 'a5'

/** Метка из адреса: те же символы, что в реестре (у встроенных бывает «_»), иначе метки нет */
const cleanCode = (raw: string | null) => (raw && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(raw) ? raw : '')

/** Лист в настоящем размере, на экране уменьшенный под ширину окна. В печати масштаб снимается */
function Sheet({ w, h, scale, children }: { w: number; h: number; scale: number; children: ReactNode }) {
  return (
    <div className="poster-frame shrink-0 shadow-[0_20px_60px_rgba(0,0,0,0.18)]" style={{ width: w * MM * scale, height: h * MM * scale }}>
      <div className="poster-sheet origin-top-left" style={{ width: `${w}mm`, height: `${h}mm`, transform: `scale(${scale})` }}>
        {children}
      </div>
    </div>
  )
}

/** Масштаб, при котором листы помещаются в ширину окна: сколько листов в ряд — столько и делим */
function useFit(width: number, perRow: number) {
  const ref = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0.5)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => {
      const css = getComputedStyle(el)
      const avail = el.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight)
      const gap = 24 * (perRow - 1)
      const fitsRow = avail >= width * MM * 0.42 * perRow + gap
      const n = fitsRow ? perRow : 1
      setScale(Math.min(1, (avail - (n - 1) * 24) / n / (width * MM)))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [width, perRow])
  return { ref, scale }
}

export function HrPoster() {
  const [params, setParams] = useSearchParams()
  const format: Format = params.get('format') === 'a5' ? 'a5' : 'a3'
  const code = cleanCode(params.get('src'))
  const data = useSources()
  const [checked, setChecked] = useState(false)
  useEffect(() => {
    void loadSources().then(() => setChecked(true))
  }, [])

  const site = data?.site ?? { url: siteBase(window.location.origin), bots: { telegram: null, max: null }, active: { telegram: false, max: false } }
  const link = code ? sourceLinks(code, site).site : `${siteBase(site.url)}/`
  const qr = useMemo(() => encodeQr(link), [link])
  const print = useMemo(() => practicePrint(), [])
  const entry = data?.sources.find((s) => s.code === code) ?? null

  const size = format === 'a5' ? A5 : A3
  const { ref, scale } = useFit(size.w, format === 'a5' ? 2 : 1)

  useEffect(() => {
    const what = format === 'a5' ? 'Листовка A5' : 'Плакат A3'
    document.title = `${what}${entry ? ` · ${entry.name}` : code ? ` · ${code}` : ''} — «Очаково»`
  }, [format, entry, code])

  const set = (key: string, value: string | null) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p)
        if (value) next.set(key, value)
        else next.delete(key)
        return next
      },
      { replace: true },
    )

  const warning = !code
    ? 'Метка не выбрана: QR ведёт на сайт без метки, и заявки с этого макета не будут подписаны.'
    : data && !entry
      ? `Метки ${code} нет в реестре. QR работает, но в «Воронке» заявки будут подписаны кодом. Дай метке название во вкладке «Источники».`
      : checked && !data
        ? 'Реестр меток не загрузился. Войди в панель HR, чтобы проверить метку. QR всё равно ведёт на сайт с меткой.'
        : null

  const btn = 'inline-flex h-10 items-center px-4 font-display text-[16px] font-extrabold tracking-[0.05em] uppercase transition-colors'

  return (
    <div className="poster-page min-h-dvh bg-[#e9e7e3] text-ink">
      <style>{`
        @page { size: ${format === 'a5' ? 'A5' : 'A3'}; margin: 0; }
        .poster-sheet { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        @media print {
          html, body, .poster-page { background: #fff !important; }
          .poster-toolbar { display: none !important; }
          .poster-sheets { display: block !important; padding: 0 !important; }
          .poster-frame { width: auto !important; height: auto !important; box-shadow: none !important; }
          .poster-sheet { transform: none !important; break-after: page; }
          .poster-frame:last-child .poster-sheet { break-after: auto; }
        }
      `}</style>

      <header className="poster-toolbar border-b border-ink/10 bg-white">
        <div className="mx-auto flex max-w-[1400px] flex-col gap-4 px-4 py-4 md:px-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <Link to="/hr?tab=sources" className="text-[15px] text-mute underline-offset-4 hover:text-ink hover:underline">
              ← Источники
            </Link>
            <div className="flex" role="group" aria-label="Что печатать">
              {(['a3', 'a5'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  aria-pressed={format === f}
                  onClick={() => set('format', f === 'a5' ? 'a5' : null)}
                  className={`${btn} ring-1 ring-ink/20 ring-inset ${format === f ? 'bg-ink text-white ring-ink' : 'text-ink hover:ring-ink'}`}
                >
                  {f === 'a3' ? 'Плакат A3' : 'Листовка A5'}
                </button>
              ))}
            </div>
            {data && data.sources.length > 0 ? (
              <label className="flex items-center gap-2 text-[15px]">
                <span className="text-mute">Метка</span>
                <select value={code} onChange={(e) => set('src', e.target.value || null)} className="h-10 max-w-[260px] border-b border-ink/30 bg-transparent pr-6 text-[15px]">
                  <option value="">Без метки</option>
                  {sourceKinds
                    .filter((k) => k.id !== 'own' && data.sources.some((s) => s.kind === k.id))
                    .map((k) => (
                      <optgroup key={k.id} label={k.label}>
                        {data.sources
                          .filter((s) => s.kind === k.id)
                          .map((s) => (
                            <option key={s.code} value={s.code}>
                              {s.name} · {s.code}
                            </option>
                          ))}
                      </optgroup>
                    ))}
                  {code && !entry && <option value={code}>{code}</option>}
                </select>
              </label>
            ) : (
              <p className="text-[15px] text-mute">Метка: {code || 'не выбрана'}</p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <p className="max-w-md text-[13px] leading-snug text-mute">
              {nb(`В окне печати: ${format === 'a5' ? 'A5, две страницы (лицевая и оборот)' : 'A3, одна страница'}, поля «Нет», фон включён. Для типографии выбери «Сохранить как PDF».`)}
            </p>
            <button type="button" onClick={() => window.print()} className={`${btn} bg-brand text-white hover:bg-ink`}>
              Печать
            </button>
          </div>
        </div>
        {warning && (
          <div className="mx-auto max-w-[1400px] px-4 pb-4 md:px-6">
            <p role="status" className="border-l-2 border-brand pl-3 text-[14px] leading-snug">
              {nb(warning)}
            </p>
          </div>
        )}
      </header>

      <div ref={ref} className="poster-sheets mx-auto flex max-w-[1400px] flex-wrap items-start justify-center gap-6 px-4 py-6 md:px-6 md:py-10">
        {format === 'a5' ? (
          <>
            <Sheet w={A5.w} h={A5.h} scale={scale}>
              <FlyerFront print={print} />
            </Sheet>
            <Sheet w={A5.w} h={A5.h} scale={scale}>
              <FlyerBack print={print} qr={qr} link={shortLink(link)} />
            </Sheet>
          </>
        ) : (
          <Sheet w={A3.w} h={A3.h} scale={scale}>
            <PosterA3 print={print} qr={qr} link={shortLink(link)} />
          </Sheet>
        )}
      </div>
    </div>
  )
}

const kicker = 'font-sans font-semibold uppercase tracking-[0.08em]'

/** «койко-место» не переносится по дефису */
export const unbreak = (s: string) => s.replace(/койко-место/g, 'койко\u2011место')

/** Разряды суммы через неразрывный пробел */
const groups = (n: number) => n.toLocaleString('ru-RU').replace(/\s/g, ' ')

/** Сторона QR на плакате вместе со свободным полем, мм: при версии 3 модуль около 4 мм */
const POSTER_QR = 146

/**
 * Плакат A3 для стенда: читается с 1,5 м. Сверху — квас на свету, на красном — слоган, ниже — сумма и крупный QR.
 * Свободное поле QR (4 модуля) — белое, оно заходит в поля листа: видимая часть кода около 115 мм. Проверка на модели
 * камеры телефона (кадр 1920 px, угол 70°) — QR читается с 1,5 м
 */
export function PosterA3({ print, qr, link }: { print: PracticePrint; qr: QrCode; link: string }) {
  const quiet = (POSTER_QR * 4) / (qr.size + 8)
  return (
    <section className="relative overflow-hidden bg-white text-ink" style={{ width: '297mm', height: '420mm' }} aria-label="Плакат A3">
      <div className="absolute inset-x-0 top-0 overflow-hidden bg-kvass" style={{ height: '108mm' }}>
        <img src="/photos/hero-line-2200.webp" alt="Бутылки кваса на линии розлива" className="absolute inset-0 size-full object-cover" style={{ objectPosition: '50% 58%' }} decoding="sync" />
        <div className="absolute inset-x-0 top-0" style={{ height: '50mm', background: 'linear-gradient(rgba(0,0,0,0.55), rgba(0,0,0,0))' }} aria-hidden="true" />
        <div className="absolute flex items-start justify-between text-white" style={{ left: '14mm', right: '14mm', top: '13mm' }}>
          <PrintLogo variant="line" width="92mm" />
          <p className="display" style={{ fontSize: '15mm' }}>
            С&nbsp;18&nbsp;лет
          </p>
        </div>
      </div>

      <div className="absolute inset-x-0 bg-brand text-white" style={{ top: '108mm', height: '104mm', padding: '12mm 14mm 0' }}>
        <p className={kicker} style={{ fontSize: '5.4mm' }}>
          Оплачиваемая практика в&nbsp;«Очаково»
        </p>
        <p className="display" style={{ fontSize: '41mm', marginTop: '6mm' }}>
          Квас делают
          <br />
          люди
        </p>
      </div>

      <div className="absolute flex flex-col" style={{ left: '14mm', width: '118mm', top: '226mm', bottom: '36mm' }}>
        <p className="display" style={{ fontSize: '25mm' }}>
          <span className="block">от&nbsp;{groups(print.min)}</span>
          <span className="block">до&nbsp;{groups(print.max)}&nbsp;₽</span>
        </p>
        <p className="font-medium" style={{ fontSize: '6.2mm', marginTop: '3mm' }}>
          {nb(print.per)}
        </p>
        <p style={{ fontSize: '4.4mm', lineHeight: 1.35, marginTop: '6mm' }}>{nb(`${print.units}.`)}</p>
        <p className="text-mute" style={{ fontSize: '4mm', lineHeight: 1.35, marginTop: '1.5mm' }}>
          {nb(`${print.period}.`)}
        </p>
        <ul style={{ marginTop: '6mm', fontSize: '4.4mm', lineHeight: 1.3 }}>
          {[print.gives[0], print.gives[1], print.gives[3]].map((g) => (
            <li key={g} className="relative" style={{ padding: '1mm 0 1mm 6mm' }}>
              <span className="absolute left-0 bg-brand" style={{ top: '3.8mm', width: '3mm', height: '0.9mm' }} aria-hidden="true" />
              {nb(unbreak(g))}
            </li>
          ))}
        </ul>
      </div>

      <div className="absolute" style={{ right: '10mm', top: `${226 - quiet + 2}mm`, width: `${POSTER_QR}mm` }}>
        <QrImage qr={qr} title={`QR: ${link}`} className="block w-full" />
        {/* Подпись — за двумя модулями свободного поля: ближе текст мешал бы камере */}
        <div style={{ margin: `${8 - quiet}mm ${quiet}mm 0` }}>
          <p className="display" style={{ fontSize: '11.5mm' }}>
            Поймай брак за&nbsp;{GAME_SECONDS}&nbsp;секунд
          </p>
          <p style={{ fontSize: '4.4mm', lineHeight: 1.3, marginTop: '2mm' }}>{nb('Наведи камеру: игра, вакансии и заявка за 2 минуты')}</p>
          <p className="break-all text-mute" style={{ fontSize: '3.8mm', marginTop: '1.2mm' }}>
            {link}
          </p>
        </div>
      </div>

      <div className="absolute flex items-end justify-between border-t border-line" style={{ left: '14mm', right: '14mm', bottom: '10mm', paddingTop: '4mm', columnGap: '10mm' }}>
        <p style={{ fontSize: '3.4mm', lineHeight: 1.4, maxWidth: '205mm' }}>
          <span className="font-semibold">{nb(print.address)}.</span> {nb(print.route)}
        </p>
        <p className="shrink-0 text-right font-semibold" style={{ fontSize: '3.6mm', lineHeight: 1.4 }}>
          {nb(print.phone)}
        </p>
      </div>
    </section>
  )
}
