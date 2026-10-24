import { Bottle } from './Bottle'
import { DEFECT_NAMES, type DefectKind } from './useConveyorGame'

const defects = Object.keys(DEFECT_NAMES) as DefectKind[]

/** Памятка контролёра в одну строку: норма слева, три вида брака справа */
export function DefectLegend({ className = '' }: { className?: string }) {
  return (
    <div className={`grid grid-cols-4 items-end gap-2 sm:flex sm:gap-8 ${className}`}>
      <figure className="flex flex-col items-center gap-2 max-sm:border-r max-sm:border-white/15">
        <Bottle kind="ok" tone="dark" className="h-16 w-auto sm:h-20" />
        <figcaption className="text-center text-[13px] leading-tight sm:text-[14px] text-white/75">
          Норма
          <span className="block">пропускай</span>
        </figcaption>
      </figure>
      <span className="mb-9 h-12 w-px bg-white/15 max-sm:hidden" aria-hidden="true" />
      {defects.map((kind) => (
        <figure key={kind} className="flex flex-col items-center gap-2">
          <Bottle kind={kind} tone="dark" className="h-16 w-auto sm:h-20" />
          <figcaption className="text-center text-[13px] leading-tight sm:text-[14px] text-white">
            {DEFECT_NAMES[kind]}
            {/* Метка «жми» — красной плашкой: подчёркнутое слово читалось как ссылка */}
            <span className="mx-auto mt-1 block w-fit bg-brand px-1.5 text-[12px] font-semibold tracking-[0.04em] uppercase sm:text-[13px]">жми</span>
          </figcaption>
        </figure>
      ))}
    </div>
  )
}
