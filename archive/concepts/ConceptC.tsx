import '@fontsource-variable/cormorant-garamond/wght-italic.css'
import { useEffect } from 'react'
import { scrollToTop, startSmoothScroll } from '../lib/motion'
import { Header } from './c/Header'
import { cinema, CinemaStyles } from './c/kit'
import { Salary } from './c/Salary'
import { Story } from './c/Story'

/**
 * Концепт C «Кино»: тёмная сцена с янтарным светом линии, история в три кадра на скролле,
 * затем предложение и зарплаты. Ориентир — промо-лендинг Borjomi.
 */
export function ConceptC() {
  useEffect(() => {
    scrollToTop()
    return startSmoothScroll()
  }, [])

  return (
    <div style={cinema} className="min-h-svh bg-(--c-bg) text-(--c-fg)">
      <CinemaStyles />
      <Header />
      <main>
        <Story />
        <Salary />
      </main>
      <footer className="container-x flex flex-col gap-3 border-t border-(--c-fg)/10 py-8 text-[13px] text-(--c-fg)/45 md:flex-row md:justify-between">
        <img src="/brand/logo-wordmark-white.svg" alt="Очаково" width={195} height={24} className="h-4 w-auto opacity-60" />
        <p>Москва, ул. Рябиновая, 44 · rabota@ochakovo.ru · +7 495 785-39-30</p>
      </footer>
      {/* Плёночное зерно поверх всего */}
      <div className="pointer-events-none fixed -inset-[10%] z-50 opacity-[0.09] mix-blend-overlay">
        <div className="c-grain size-full" />
      </div>
    </div>
  )
}
