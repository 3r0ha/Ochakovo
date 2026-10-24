import { Bottle, type BottleKind } from '../game/Bottle'
import { DEFECT_NAMES } from '../game/useConveyorGame'

/** Пять бутылок на ленте, брак — посередине: кривая этикетка видна с первого взгляда на любом экране */
const ROW: BottleKind[] = ['ok', 'ok', 'label', 'ok', 'ok']
const DEFECT = 'label' as const

/**
 * Этап «Контроль качества» в «Пути кваса»: вместо фото — кусок той же линии, что в игре «Поймай брак».
 * Лента, бутылки кваса из игры, одна с браком в рамке контроля. Размеры — от рамки этапа (единицы контейнера),
 * поэтому рисунок одинаково читается в карточке телефона и в большой панели компьютера. Неподвижный: кадров нет
 */
export function QcFragment({ className = '' }: { className?: string }) {
  return (
    <div
      role="img"
      aria-label={`Линия розлива: на контроле бутылка с браком (${DEFECT_NAMES[DEFECT].toLowerCase()})`}
      data-qc-fragment
      // Позиционирование задаёт вызывающий (absolute в панели компьютера), иначе relative. Высоту даёт рамка: размеры внутри — от неё
      className={`${/\b(absolute|fixed|sticky)\b/.test(className) ? '' : 'relative'} overflow-hidden bg-night [container-type:size] ${className}`}
    >
      {/* Лента — как в игре: тёмная, с красной кромкой и рёбрами */}
      <div
        className="absolute inset-x-0 bottom-[16%] h-[6%]"
        style={{
          backgroundColor: '#1d1b19',
          backgroundImage: 'repeating-linear-gradient(90deg, rgba(255,255,255,0.07) 0 2px, transparent 2px 40px)',
          boxShadow: 'inset 0 1px 0 var(--color-brand)',
        }}
      />
      <div className="absolute inset-x-0 bottom-[22%] flex items-end justify-center gap-[5.5cqw]">
        {ROW.map((kind, i) => (
          <div key={i} className="relative h-[46cqh]">
            <Bottle kind={kind} tone="dark" className="h-full w-auto" />
            {kind !== 'ok' && (
              // Рамка контроля вокруг брака и подпись над ней
              <>
                <span className="absolute -inset-x-[45%] -top-[8%] -bottom-[3%] border-2 border-dashed border-white/70" />
                <span className="absolute bottom-[calc(100%+9%)] left-1/2 -translate-x-1/2 bg-brand px-[1.6cqw] py-[0.8cqw] font-display text-[max(13px,3.4cqw)] leading-none font-bold tracking-[0.06em] whitespace-nowrap text-white uppercase">
                  Брак: {DEFECT_NAMES[kind].toLowerCase()}
                </span>
              </>
            )}
          </div>
        ))}
      </div>
      <div className="absolute inset-x-[5%] bottom-[4%] flex justify-between font-display text-[max(12px,2.6cqw)] font-bold tracking-[0.08em] text-white/60 uppercase">
        <span>Линия розлива</span>
        <span>Контроль</span>
        <span>Склад</span>
      </div>
    </div>
  )
}
