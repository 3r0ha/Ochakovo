import { useEffect, useRef, useState } from 'react'

/**
 * Бесконечные CSS-анимации (бегущая строка, лента на заставке игры) стоят, пока их не видно
 * или вкладка скрыта: иначе они всё время занимают процессор и садят батарею телефона.
 * ref — на элемент, по которому судим о видимости; paused — в animation-play-state
 */
export function useOffscreenPause<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [paused, setPaused] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    let visible = true
    const update = () => setPaused(!visible || document.hidden)
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting
      update()
    })
    io.observe(el)
    document.addEventListener('visibilitychange', update)
    return () => {
      io.disconnect()
      document.removeEventListener('visibilitychange', update)
    }
  }, [])
  return { ref, paused }
}
