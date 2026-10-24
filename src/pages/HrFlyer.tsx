import { qrPath, QR_QUIET, type QrCode } from '@shared/qr'
import type { PracticePrint } from '@shared/sources'
import { Logo } from '../components/Logo'
import { nb } from '../lib/typo'

// Листовка A5 «Оплачиваемая практика» с QR на метку источника: лицевая и оборот, 148 × 210 мм.
// Сетка и тексты — docs/brand/visuals.md, раздел 3.1 (макет для согласования — docs/brand/print/leaflet-a5.html):
// поле 8 мм, модуль — квадрат 44 мм, три модуля в ширину. Цифры — из shared (practicePrint), QR — свой кодировщик.
// Фото на лицевой — кадр «Наставник и новичок у пульта» из ролика «Оператор линии розлива»: обрезан так, чтобы титр
// ролика не попал в кадр. Для тиража нужна своя съёмка — так записано в docs/brand/visuals.md.
// Страница печати — /hr/poster?src=<метка>&format=a5 (src/pages/HrPoster.tsx).

export const A5 = { w: 148, h: 210 }

/** QR на экране и в печати: контур тёмных модулей и белое свободное поле в 4 модуля — как в SVG для печати */
export function QrImage({ qr, title, className = '' }: { qr: QrCode; title: string; className?: string }) {
  const side = qr.size + QR_QUIET * 2
  return (
    <svg viewBox={`0 0 ${side} ${side}`} className={className} role="img" aria-label={title} shapeRendering="crispEdges">
      <rect width={side} height={side} fill="#fff" />
      <path d={qrPath(qr)} fill="#000" />
    </svg>
  )
}

/** Логотип нужной ширины в мм: у SVG логотипа свои width и height, их перекрывает w-full */
export function PrintLogo({ variant, width, className = '' }: { variant: 'line' | 'block'; width: string; className?: string }) {
  return (
    <span className={`block ${className}`} style={{ width }}>
      <Logo variant={variant} title="ОЧАКОВО — натуральные напитки" className="block h-auto w-full" />
    </span>
  )
}

const sheet = 'relative overflow-hidden bg-white text-ink'
const kicker = 'font-sans font-semibold uppercase tracking-[0.08em]'

export function FlyerFront({ print }: { print: PracticePrint }) {
  return (
    <section className={sheet} style={{ width: '148mm', height: '210mm' }} aria-label="Листовка, лицевая сторона">
      {/* Кадр 1280 × 720 увеличен и прижат к правому нижнему углу: двое у пульта, без титра ролика в левом верхнем углу */}
      <div className="absolute inset-x-0 top-0 overflow-hidden bg-ash" style={{ height: '108mm' }}>
        <img
          src="/video/bottling-operator-1280.webp"
          alt="Наставник и новичок у пульта линии розлива"
          className="absolute right-0 bottom-0 max-w-none"
          style={{ width: '171.4%' }}
          decoding="sync"
        />
      </div>
      <div className="absolute inset-x-0 bg-brand text-white" style={{ top: '108mm', height: '44mm', padding: '6.5mm 8mm 0' }}>
        <p className="display" style={{ fontSize: '19.2mm' }}>
          Квас делают
          <br />
          люди
        </p>
      </div>
      <div className="absolute grid" style={{ left: '8mm', right: '8mm', top: '158mm', bottom: '8mm', gridTemplateColumns: '1fr 30mm', columnGap: '4mm' }}>
        <div>
          <p className={`${kicker} text-brand`} style={{ fontSize: '2.6mm' }}>
            Оплачиваемая практика
          </p>
          <p className="display" style={{ fontSize: '13.4mm', marginTop: '1.6mm' }}>
            {print.range}
          </p>
          <p className="font-medium" style={{ fontSize: '3.1mm', marginTop: '1.4mm' }}>
            {nb(print.per)}
          </p>
          <p className="text-mute" style={{ fontSize: '2.75mm', lineHeight: 1.45, marginTop: '3.2mm' }}>
            {nb(`${print.units}.`)}
            <br />
            {nb(`${print.period}.`)}
          </p>
        </div>
        <div className="flex flex-col items-end justify-between">
          <p className="display text-right text-brand" style={{ fontSize: '8mm' }}>
            С&nbsp;18&nbsp;лет
          </p>
          <PrintLogo variant="block" width="27mm" className="text-brand" />
        </div>
      </div>
    </section>
  )
}

export function FlyerBack({ print, qr, link }: { print: PracticePrint; qr: QrCode; link: string }) {
  return (
    <section className={sheet} style={{ width: '148mm', height: '210mm' }} aria-label="Листовка, оборотная сторона">
      <div className="absolute flex flex-col" style={{ left: '8mm', right: '8mm', top: '8mm', bottom: '48mm' }}>
        <div className="flex items-start justify-between" style={{ marginBottom: '6mm' }}>
          <PrintLogo variant="line" width="42mm" className="text-brand" />
          <p className={`${kicker} text-brand`} style={{ fontSize: '2.6mm' }}>
            Оплачиваемая практика
          </p>
        </div>

        <h2 className="display" style={{ fontSize: '9.6mm', marginBottom: '2.4mm' }}>
          Роли и&nbsp;деньги
        </h2>
        <ul>
          {print.roles.map((r, i) => {
            const sameUnit = i > 0 && print.roles[i - 1].unit === r.unit
            return (
              <li
                key={r.id}
                className="grid items-start"
                style={{ gridTemplateColumns: '10mm 1fr 27mm', columnGap: '3mm', padding: sameUnit ? '0 0 1.8mm' : '1.8mm 0', borderTop: sameUnit ? 0 : '0.25mm solid #e1e1e1' }}
              >
                <span style={{ marginTop: '0.3mm' }}>{!sameUnit && r.picto && <img src={r.picto} alt="" style={{ width: '7mm', height: '7mm' }} />}</span>
                <span style={{ fontSize: '2.75mm', lineHeight: 1.35 }}>
                  {!sameUnit && (
                    <span className={`${kicker} block text-brand`} style={{ fontSize: '2.3mm' }}>
                      {r.unit}
                    </span>
                  )}
                  <span className="block font-semibold" style={{ fontSize: '3.1mm' }}>
                    {r.title}
                  </span>
                  <span className="block text-mute">{nb(r.what)}</span>
                </span>
                <span className="display text-right" style={{ fontSize: '5.6mm', paddingTop: '0.6mm' }}>
                  {r.pay}
                  {r.note && (
                    <span className="block font-sans font-medium normal-case text-mute" style={{ fontSize: '2.2mm', marginTop: '0.8mm', letterSpacing: 0, lineHeight: 1.2 }}>
                      {r.note}
                    </span>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
        <p className="text-mute" style={{ fontSize: '2.4mm', lineHeight: 1.4, paddingTop: '1.8mm', borderTop: '0.25mm solid #e1e1e1' }}>
          {nb(print.footnote)}
        </p>

        <div style={{ marginTop: 'auto' }}>
          <h3 className="display" style={{ fontSize: '6.2mm', marginBottom: '1.6mm' }}>
            Что даёт компания
          </h3>
          <ul style={{ columns: 2, columnGap: '6mm', fontSize: '2.75mm', lineHeight: 1.32 }}>
            {print.gives.map((g) => (
              <li key={g} className="relative break-inside-avoid" style={{ padding: '0.7mm 0 0.7mm 3.2mm' }}>
                <span className="absolute left-0 bg-brand" style={{ top: '2.2mm', width: '1.4mm', height: '0.5mm' }} aria-hidden="true" />
                {nb(g.replace(/койко-место/g, 'койко\u2011место'))}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="absolute inset-x-0 bottom-0 grid bg-brand text-white" style={{ height: '44mm', padding: '4mm 8mm 4mm 6mm', gridTemplateColumns: '36mm 1fr', columnGap: '5mm', alignItems: 'start' }}>
        <QrImage qr={qr} title={`QR: ${link}`} className="block w-full" />
        <div>
          <ol style={{ paddingTop: '1.5mm' }}>
            {print.steps.map((s, i) => (
              <li key={s} className="relative" style={{ paddingLeft: '7mm', marginBottom: '1.6mm', fontSize: '3mm', lineHeight: 1.3 }}>
                <span className="display absolute left-0" style={{ top: '-0.6mm', fontSize: '5.4mm', lineHeight: 1 }} aria-hidden="true">
                  {i + 1}
                </span>
                {nb(s)}
              </li>
            ))}
          </ol>
          <p style={{ marginTop: '2.4mm', fontSize: '2.35mm', lineHeight: 1.45, opacity: 0.92 }}>
            {nb(`${print.phone} · ${print.street}`)}
            <br />
            {nb(`${print.shuttle.replace(/ до завода/, '').replace(/\.$/, '')} · Берём с 18 лет`)}
          </p>
        </div>
      </div>
    </section>
  )
}
