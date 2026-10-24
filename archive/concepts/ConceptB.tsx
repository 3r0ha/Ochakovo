import { useEffect } from 'react'
import { scrollToTop, startSmoothScroll } from '../lib/motion'
import { Header } from './b/Header'
import { Hero } from './b/Hero'
import { Salary } from './b/Salary'

/** Концепт B «Плакат»: красный, огромный шрифт во всю ширину, двухцветные фото */
export function ConceptB() {
  useEffect(() => {
    scrollToTop()
    return startSmoothScroll()
  }, [])

  return (
    <div className="min-h-dvh bg-brand">
      <Header />
      <main>
        <Hero />
        <Salary />
      </main>
    </div>
  )
}
