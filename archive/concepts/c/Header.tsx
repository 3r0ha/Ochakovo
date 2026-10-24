import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { scrollToTarget } from '../../lib/motion'

const links = [
  { label: 'Зарплата', href: '#salary' },
  { label: 'Вакансии', to: '/vacancies' },
  { label: 'Поймай брак', to: '/game' },
]

export function Header() {
  const [solid, setSolid] = useState(false)

  useEffect(() => {
    const onScroll = () => setSolid(window.scrollY > 40)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <header
      className={`fixed inset-x-0 top-0 z-40 text-(--c-fg) transition-[background-color,backdrop-filter] duration-500 ${
        solid ? 'bg-(--c-bg)/70 backdrop-blur-md' : 'bg-transparent'
      }`}
    >
      <div className="container-x flex h-[72px] items-center justify-between gap-6">
        <Link to="/concept/c" aria-label="Очаково — на главную">
          <img src="/brand/logo-wordmark-white.svg" alt="" width={195} height={24} className="h-[18px] w-auto md:h-5" />
        </Link>
        <nav className="hidden items-center gap-9 md:flex">
          {links.map((l) =>
            l.href ? (
              <button key={l.label} onClick={() => scrollToTarget(l.href)} className="text-[15px] text-(--c-fg)/80 transition-colors hover:text-(--c-fg)">
                {l.label}
              </button>
            ) : (
              <Link key={l.label} to={l.to!} className="text-[15px] text-(--c-fg)/80 transition-colors hover:text-(--c-fg)">
                {l.label}
              </Link>
            ),
          )}
        </nav>
        <div className="flex items-center gap-5">
          <Link to="/game" className="text-[15px] text-(--c-fg)/80 md:hidden">
            Игра
          </Link>
          <Link
            to="/apply"
            className="inline-flex h-10 items-center bg-brand px-4 font-display text-[17px] font-bold tracking-[0.06em] text-white uppercase transition-colors hover:bg-brand-deep md:h-11 md:px-5"
          >
            Откликнуться
          </Link>
        </div>
      </div>
    </header>
  )
}
