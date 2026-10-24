import { motion } from 'motion/react'
import type { PointerEvent as ReactPointerEvent, ReactNode, Ref } from 'react'
import { Bottle } from './Bottle'
import type { BeltItem, FloatText } from './useConveyorGame'

export const BELT_H = 22
/** Отступ ленты от низа сцены — под ним подписи */
export const BELT_Y = 40
/** Место над бутылками под всплывающие подписи */
export const HEADROOM = 100
/**
 * Брак засчитывается, если нажатие попало в силуэт или рядом — не дальше этого отступа.
 * Нормальная бутылка штрафует только за нажатие по самому силуэту: промах мимо брака в зазор — не ошибка
 */
const HIT_MARGIN = 12
/** Нажатие почти посередине между двумя бутылками — непонятно, в какую целились: не засчитываем и не штрафуем */
const AMBIGUOUS = 0.18

export const stageHeight = (bottleH: number) => bottleH + BELT_H + BELT_Y + HEADROOM

type Props = {
  beltRef: Ref<HTMLDivElement>
  width: number
  items: BeltItem[]
  floats: FloatText[]
  bottleW: number
  bottleH: number
  beltOffset: number
  /** Игровое время — для тряски нормальной бутылки после ошибки */
  clock: number
  onHit: (id: number) => void
  overlay?: ReactNode
  /** dark — тёмная сцена главной и страницы игры */
  tone?: 'light' | 'dark'
  /** Слой между фоном и бутылками: демо-лента на заставке */
  underlay?: ReactNode
  /** Центр рамки контроля для игры с клавиатуры, px; не задан — рамки нет */
  zone?: number
  /** Без тряски и подпрыгивания подписей — режим «меньше движения» */
  calm?: boolean
}

/** Сцена конвейера: лента, бутылки, всплывающие подписи. Без логики — только отрисовка. */
export function ConveyorStage({ beltRef, width, items, floats, bottleW, bottleH, beltOffset, clock, onHit, overlay, tone = 'light', underlay, zone, calm = false }: Props) {
  const dark = tone === 'dark'
  const stageH = stageHeight(bottleH)
  const half = Math.min(110, width / 2 - 8)
  const clampCenter = (x: number) => Math.min(width - half, Math.max(half, x))
  const live = items.length > 0

  // Попадание считаем по всей ленте сразу: ближайшая к пальцу бутылка в пределах своего силуэта и небольшого отступа
  const onBeltDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!live) return
    const r = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - r.left
    const fromBottom = r.bottom - e.clientY
    const base = BELT_Y + BELT_H - 1
    if (fromBottom < base - HIT_MARGIN || fromBottom > base + bottleH + HIT_MARGIN + 24) return
    const near = items
      .filter((it) => it.state === 'moving')
      .map((it) => ({ id: it.id, d: Math.abs(px - (it.x + bottleW / 2)), reach: bottleW / 2 + (it.kind === 'ok' ? 0 : HIT_MARGIN) }))
      .filter((c) => c.d <= c.reach)
      .sort((a, b) => a.d - b.d)
    e.preventDefault()
    if (!near.length) return
    if (near[1] && near[1].d - near[0].d < bottleW * AMBIGUOUS) return
    onHit(near[0].id)
  }

  return (
    <div className={`relative overflow-hidden select-none ${dark ? '' : 'rounded-[28px] bg-white'}`} style={{ height: stageH }}>
      <div
        className={`pointer-events-none absolute inset-x-0 bottom-0 flex justify-between px-5 pb-2.5 font-display text-[15px] font-bold tracking-[0.08em] uppercase ${
          dark ? 'text-white/60' : 'text-mute'
        }`}
      >
        <span>Линия розлива</span>
        <span>Склад</span>
      </div>

      <div
        ref={beltRef}
        onPointerDown={onBeltDown}
        className={`absolute inset-x-0 bottom-0 ${live ? 'cursor-pointer touch-none' : ''}`}
        style={{ height: stageH }}
      >
        {/* Лента */}
        <div
          className={`absolute inset-x-0 ${dark ? '' : 'bg-ink'}`}
          style={{
            bottom: BELT_Y,
            height: BELT_H,
            backgroundColor: dark ? '#1d1b19' : undefined,
            backgroundImage: `repeating-linear-gradient(90deg, rgba(255,255,255,${dark ? 0.07 : 0.1}) 0 2px, transparent 2px 40px)`,
            backgroundPositionX: `${beltOffset}px`,
            boxShadow: dark ? 'inset 0 1px 0 var(--color-brand)' : undefined,
          }}
        />

        {underlay}

        {/* Рамка контроля: пробел снимает бутылку, которая сейчас в ней. Только для мыши и клавиатуры */}
        {zone !== undefined && (
          <div
            className="pointer-events-none absolute hidden [@media(hover:hover)_and_(pointer:fine)_and_(min-width:768px)]:block"
            style={{ left: zone - bottleW * 0.8, bottom: BELT_Y + BELT_H - 4, width: bottleW * 1.6, height: bottleH + 18 }}
            aria-hidden="true"
          >
            <div className={`size-full border-2 border-dashed ${dark ? 'border-white/30' : 'border-ink/25'}`} />
          </div>
        )}
        {zone !== undefined && (
          <span
            className={`pointer-events-none absolute bottom-2.5 hidden -translate-x-1/2 font-display text-[15px] font-bold tracking-[0.08em] whitespace-nowrap uppercase [@media(hover:hover)_and_(pointer:fine)_and_(min-width:768px)]:block ${dark ? 'text-white/75' : 'text-mute'}`}
            style={{ left: zone }}
            aria-hidden="true"
          >
            Контроль · пробел
          </span>
        )}

        {items.map((it) => {
          const caught = it.state === 'caught'
          const since = it.touchedAt === null ? Infinity : clock - it.touchedAt
          const shaking = since < 0.45
          const shake = shaking && !calm ? Math.sin(since * 55) * 7 * (1 - since / 0.45) : 0
          return (
            <div
              key={it.id}
              aria-hidden="true"
              data-id={it.id}
              data-slot={it.slot}
              data-kind={it.kind}
              data-state={it.state}
              className="pointer-events-none absolute left-0"
              style={{
                bottom: BELT_Y + BELT_H - 1,
                width: bottleW,
                height: bottleH + 36,
                paddingTop: 36,
                transform: `translate3d(${it.x + shake}px, ${caught ? -34 : 0}px, 0)`,
                opacity: caught ? 0 : 1,
                transition: caught ? 'transform 0.5s cubic-bezier(0.16,1,0.3,1), opacity 0.5s ease' : 'none',
                willChange: 'transform',
              }}
            >
              <Bottle kind={it.kind} subtle={it.subtle} tone={tone} className="size-full" />
              {since < 0.7 && <span className="pointer-events-none absolute -inset-x-2 top-7 bottom-[-6px] rounded-2xl ring-2 ring-brand" />}
            </div>
          )
        })}

        {/* Кольцо-вспышка на месте пойманного брака */}
        {items
          .filter((it) => it.state === 'caught')
          .map((it) => (
            <motion.span
              key={`ring-${it.id}`}
              initial={{ scale: 0.3, opacity: 1 }}
              animate={{ scale: 1.7, opacity: 0 }}
              transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
              className="pointer-events-none absolute rounded-full border-[3px] border-brand"
              style={{
                left: it.x + bottleW / 2 - bottleW * 0.65,
                bottom: BELT_Y + BELT_H + bottleH / 2 - bottleW * 0.65,
                width: bottleW * 1.3,
                height: bottleW * 1.3,
              }}
            />
          ))}

        {floats.map((f) => (
          <motion.div
            key={f.id}
            initial={{ y: calm ? 0 : 8, opacity: 0 }}
            animate={{ y: calm ? 0 : -18, opacity: [0, 1, 1, 0] }}
            transition={{ duration: 0.9, ease: 'easeOut', times: [0, 0.15, 0.7, 1] }}
            className="pointer-events-none absolute flex -translate-x-1/2 flex-col items-center whitespace-nowrap"
            style={{ left: clampCenter(f.x), bottom: BELT_Y + BELT_H + bottleH + 26 }}
          >
            <span className={`display text-[26px] md:text-[32px] ${f.tone === 'good' ? (dark ? 'text-white' : 'text-ink') : 'text-brand'}`}>{f.text}</span>
            {f.sub && (
              <span className={`text-[17px] font-semibold ${dark ? (f.tone === 'good' ? 'text-white' : 'text-white/75') : f.tone === 'good' ? 'text-brand' : 'text-mute'}`}>{f.sub}</span>
            )}
          </motion.div>
        ))}
      </div>

      {overlay}
    </div>
  )
}
