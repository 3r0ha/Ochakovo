import { useId } from 'react'

type Props = {
  className?: string
}

/** Круглая печать, как на этикетке: текст по кругу медленно вращается, в центре — год */
export function Seal({ className = '' }: Props) {
  const id = useId()
  const ring = 'СЕЗОН 2027 · МОСКВА · ОЧАКОВО · '

  return (
    <div className={className} aria-hidden="true">
      <div className="relative aspect-square [container-type:inline-size]">
      <svg viewBox="0 0 200 200" className="absolute inset-0 size-full">
        <defs>
          <path id={id} d="M100,100 m-74,0 a74,74 0 1,1 148,0 a74,74 0 1,1 -148,0" />
        </defs>
        <circle cx="100" cy="100" r="98" fill="#E8A70B" />
        <circle cx="100" cy="100" r="92" fill="none" stroke="#3A2313" strokeWidth="1.2" />
        <circle cx="100" cy="100" r="56" fill="none" stroke="#3A2313" strokeWidth="1.2" />
        <g className="a-seal-ring" style={{ transformBox: 'view-box' }}>
          <text fill="#3A2313" fontSize="17" fontWeight="700" letterSpacing="2.6" className="font-display uppercase">
            <textPath href={`#${id}`} textLength="462" lengthAdjust="spacing">
              {ring}
            </textPath>
          </text>
        </g>
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center text-[#3A2313]">
        <span>
          <span className="block font-display text-[7.5cqw] font-semibold tracking-[0.2em] uppercase">с</span>
          <span className="block text-[19cqw] leading-none" style={{ fontFamily: '"Yeseva One", Georgia, serif' }}>
            1978
          </span>
        </span>
      </div>
      </div>
    </div>
  )
}
