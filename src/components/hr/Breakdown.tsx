import { motion } from 'motion/react'
import type { ReactNode } from 'react'

type Props = {
  title: string
  note?: ReactNode
  rows: [string, number][]
  total: number
}

/** Список долей с тонкими красными полосками на тёмном фоне */
export function Breakdown({ title, note, rows, total }: Props) {
  return (
    <div>
      <h2 className="font-display text-[clamp(30px,3vw,40px)] leading-none font-black uppercase">{title}</h2>
      {note && <p className="mt-4 max-w-md text-[15px] leading-snug text-white/55">{note}</p>}
      <ul className="mt-8 border-t border-white/15">
        {rows.map(([label, count], i) => {
          const share = total ? count / total : 0
          return (
            <li key={label} className="border-b border-white/10 py-3">
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-white/85">{label}</span>
                <span className="flex items-baseline gap-3 tabular-nums">
                  <span className="font-display text-[26px] leading-none font-extrabold">{count}</span>
                  <span className="w-10 text-right text-[15px] text-white/55">{Math.round(share * 100)}%</span>
                </span>
              </div>
              <div className="mt-3 h-[2px] bg-white/10">
                <motion.div
                  initial={{ scaleX: 0 }}
                  animate={{ scaleX: share }}
                  transition={{ duration: 0.9, delay: i * 0.05, ease: [0.16, 1, 0.3, 1] }}
                  className="h-full origin-left bg-brand"
                />
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
