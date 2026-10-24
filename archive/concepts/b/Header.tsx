import { Link } from 'react-router'
import { scrollToTarget } from '../../lib/motion'

/** Шапка плаката: белый логотип на красном, три ссылки и прямоугольная кнопка */
export function Header() {
  return (
    <header className="absolute inset-x-0 top-0 z-30 text-white">
      <div className="flex h-16 items-center justify-between gap-6 px-5 md:h-20 md:px-10">
        <Link to="/concept/b" aria-label="Очаково — на главную" className="shrink-0">
          <img src="/brand/logo-wordmark-white.svg" alt="" width={195} height={24} className="h-[17px] w-auto md:h-[22px]" />
        </Link>
        <nav className="hidden items-center gap-9 font-display text-[22px] font-bold tracking-[0.04em] uppercase md:flex">
          <button onClick={() => scrollToTarget('#salary')} className="uppercase hover:underline hover:decoration-2 hover:underline-offset-6">
            Зарплата
          </button>
          <Link to="/vacancies" className="hover:underline hover:decoration-2 hover:underline-offset-6">
            Вакансии
          </Link>
          <Link to="/game" className="hover:underline hover:decoration-2 hover:underline-offset-6">
            Поймай брак
          </Link>
        </nav>
        <Link
          to="/apply"
          className="flex h-11 items-center bg-white px-5 font-display text-[19px] font-black tracking-[0.04em] text-brand uppercase transition-colors hover:bg-ink hover:text-white md:h-12 md:px-7 md:text-[21px]"
        >
          Откликнуться
        </Link>
      </div>
    </header>
  )
}
