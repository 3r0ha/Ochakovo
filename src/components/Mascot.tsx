import { useState, type ReactNode } from 'react'
import drawn from 'virtual:mascot-poses'

export type MascotPose =
  | 'hello'
  | 'money'
  | 'think'
  | 'wow'
  | 'inspector'
  | 'oops'
  | 'meh'
  | 'thumbs'
  | 'phone'
  | 'clock'
  | 'point'
  | 'peek'
  | 'lost'
  | 'face'
  | 'mentor'

const poseLabel: Record<MascotPose, string> = {
  hello: 'машет',
  money: 'с зарплатой',
  think: 'думает',
  wow: 'восторг',
  inspector: 'в каске, с лупой',
  oops: 'хватается за голову',
  meh: 'разводит руками',
  thumbs: 'палец вверх',
  phone: 'с телефоном',
  clock: 'смотрит на часы',
  point: 'показывает',
  peek: 'выглядывает',
  lost: 'растерян',
  face: 'лицо',
  mentor: 'у пульта',
}

// Заглушки на месте будущих картинок показываем только по ссылке с ?kvasych —
// чтобы видеть, где будет Квасыч, но не портить страницу пустыми рамками
const showPlaceholders = (() => {
  try {
    if (new URLSearchParams(window.location.search).has('kvasych')) sessionStorage.setItem('kvasych', '1')
    return sessionStorage.getItem('kvasych') === '1'
  } catch {
    return false
  }
})()

type Props = {
  pose: MascotPose
  className?: string
  /** На тёмном фоне заглушка рисуется светлой */
  dark?: boolean
}

/**
 * Квасыч. Картинки лежат в public/mascot/kvasych-<pose>.webp, фон убирает scripts/mascot-cutout.py (бриф — docs/kvasych.md).
 * Пока файла нет, на его месте аккуратная заглушка с названием позы.
 */
export function Mascot({ pose, className = '', dark = false }: Props) {
  const [broken, setBroken] = useState(false)
  // Картинки, которой ещё нет в public/mascot, не запрашиваем вовсе
  const missing = broken || !drawn.includes(pose)

  if (missing && !showPlaceholders) return null

  if (missing)
    return (
      <div
        className={`grid place-items-center rounded-[28px] border-2 border-dashed text-center ${
          dark ? 'border-white/30 text-white/60' : 'border-ink/20 text-mute'
        } ${className}`}
        role="img"
        aria-label={`Квасыч (${poseLabel[pose]})`}
      >
        <span className="px-3 text-[13px] leading-tight">
          Квасыч
          <br />
          <span className="opacity-70">{poseLabel[pose]}</span>
        </span>
      </div>
    )

  return (
    <img
      src={`/mascot/kvasych-${pose}.webp`}
      alt=""
      aria-hidden="true"
      onError={() => setBroken(true)}
      draggable={false}
      className={`object-contain object-bottom ${className}`}
    />
  )
}

/** Реплика Квасыча — облачко с текстом */
export function Bubble({ children, className = '', tail = 'left' }: { children: ReactNode; className?: string; tail?: 'left' | 'right' | 'bottom' }) {
  const tails = {
    left: 'before:-left-2 before:bottom-5',
    right: 'before:-right-2 before:bottom-5',
    bottom: 'before:-bottom-2 before:left-8',
  }
  return (
    <div
      className={`relative rounded-[22px] bg-white px-5 py-4 text-[17px] leading-snug text-ink shadow-[0_10px_30px_-12px_rgba(20,20,20,0.25)] before:absolute before:size-4 before:rotate-45 before:bg-white ${tails[tail]} ${className}`}
    >
      {children}
    </div>
  )
}
