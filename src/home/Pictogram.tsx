/**
 * Фирменные пиктограммы «Очаково» из брендбука (public/brand/pictograms, манифест там же — их выгружает node scripts/media.mjs).
 * Рисуются маской: цвет — currentColor, поэтому на белом они красные, на красном и тёмном — белые, как велит брендбук.
 * Правила брендбука: одна толщина линий, без поворотов и растяжения (только квадрат), в группе — один масштаб и один цвет,
 * вокруг — свободное поле. Пиктограммы пива, кега, ящика с бутылками и хмеля в манифест не попали и здесь не появятся
 */

/** Пиктограммы, которые стоят на главной, и их названия из манифеста */
export const PICTOGRAMS = {
  'pet-bottle': 'Бутылка ПЭТ',
  kettle: 'Варочный котёл',
  control: 'Контроль параметров',
  cycle: 'Цикл производства',
  'tank-unit': 'Установка с ёмкостями',
  cct: 'Цилиндро-конический танк',
  'glass-bottle': 'Стеклянная бутылка',
  ears: 'Колосья',
} as const

export type PictogramId = keyof typeof PICTOGRAMS

/** Пиктограмма квадратом. Размер задаёт className (size-12); без label — украшение, диктор её пропускает */
export function Pictogram({ id, label, className = '' }: { id: PictogramId; label?: string; className?: string }) {
  const url = `url(/brand/pictograms/${id}.svg)`
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-pictogram={id}
      className={`inline-block aspect-square shrink-0 bg-current [forced-color-adjust:none] ${className}`}
      style={{
        WebkitMaskImage: url,
        maskImage: url,
        WebkitMaskSize: 'contain',
        maskSize: 'contain',
        WebkitMaskRepeat: 'no-repeat',
        maskRepeat: 'no-repeat',
        WebkitMaskPosition: 'center',
        maskPosition: 'center',
      }}
    />
  )
}
