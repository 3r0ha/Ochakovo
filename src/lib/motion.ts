import Lenis from 'lenis'
import { useLayoutEffect, useRef, type RefObject } from 'react'

export const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

let lenis: Lenis | null = null
let frame = 0
let idle = 0

/**
 * Свой цикл кадров для Lenis: он крутится, только пока идёт плавная прокрутка, и сам встаёт через пару пустых кадров.
 * В покое страница не тратит ни одного кадра
 */
function loop(time: number) {
  if (!lenis) {
    frame = 0
    return
  }
  lenis.raf(time)
  idle = lenis.isSmooth ? 0 : idle + 1
  frame = idle > 2 ? 0 : requestAnimationFrame(loop)
}

/** Разбудить цикл: колесо, касание, клавиша, прокрутка или переход к якорю */
function wake() {
  if (!lenis || frame) return
  idle = 0
  // Часы Lenis стоят с прошлой прокрутки: без сброса первый кадр посчитал бы весь простой и прыгнул к цели
  lenis.time = 0
  frame = requestAnimationFrame(loop)
}

const WAKE_EVENTS = ['wheel', 'touchstart', 'keydown', 'scroll'] as const

/**
 * Плавная прокрутка колесом на компьютере. На касаниях (pointer: coarse) и при «уменьшить движение» её нет —
 * там прокрутка родная. Возвращает функцию очистки
 */
export function startSmoothScroll() {
  if (prefersReducedMotion() || window.matchMedia('(pointer: coarse)').matches) return () => {}
  const own = new Lenis({ lerp: 0.12, autoRaf: false })
  lenis = own
  for (const e of WAKE_EVENTS) window.addEventListener(e, wake, { passive: true, capture: true })
  return () => {
    for (const e of WAKE_EVENTS) window.removeEventListener(e, wake, { capture: true })
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    own.destroy()
    if (lenis === own) lenis = null
  }
}

/**
 * Плавно прокрутить к элементу (через Lenis, если он запущен). Цель считается в начале прокрутки: если за это время
 * выше догрузилась секция или картинка, раздел встал бы не на место — поэтому в конце сверяемся и докручиваем, до двух раз
 */
export function scrollToTarget(target: string | HTMLElement, offset = 0) {
  const el = typeof target === 'string' ? document.querySelector<HTMLElement>(target) : target
  if (!el) return
  /** Насколько раздел не доехал до места: верх раздела должен встать на -offset от края окна */
  const miss = () => el.getBoundingClientRect().top + offset
  if (lenis) {
    // Lenis сам вычитает scroll-padding-top страницы — возвращаем его, чтобы раздел встал там же, где без Lenis
    const padding = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0
    const go = (duration: number, left: number) => {
      if (!lenis) return
      const opts = { offset: offset + padding, duration, onComplete: () => left > 0 && Math.abs(miss()) > 8 && go(0.4, left - 1) }
      lenis.scrollTo(el, opts)
      wake()
    }
    go(1.4, 2)
    return
  }
  const behavior: ScrollBehavior = prefersReducedMotion() ? 'auto' : 'smooth'
  window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY + offset, behavior })
  // Родная плавная прокрутка: после её конца — та же сверка, один раз
  if (behavior === 'smooth' && 'onscrollend' in window)
    window.addEventListener('scrollend', () => Math.abs(miss()) > 8 && window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY + offset, behavior }), { once: true })
}

export function lockScroll(locked: boolean) {
  if (locked) lenis?.stop()
  else lenis?.start()
  document.documentElement.style.overflow = locked ? 'hidden' : ''
}

export function scrollToTop() {
  if (lenis) lenis.scrollTo(0, { immediate: true })
  else window.scrollTo(0, 0)
}

/**
 * Появление заголовка секции при прокрутке: const ref = useReveal<HTMLHeadingElement>(); <h2 ref={ref}>.
 * Один раз, через IntersectionObserver: текст выезжает снизу из-под маски за 0,9 с, двигается только transform.
 * Сдвиг и маска считаются по самому тексту, а не по блоку: заголовок, растянутый сеткой в высоту, выезжает так же.
 * Класс ставит JS, поэтому без JS всё видно; при уменьшении движения заголовок сразу на месте.
 * После появления классы снимаются — в покое у заголовка нет ни маски, ни сдвига
 */
export function useReveal<T extends HTMLElement = HTMLElement>(): RefObject<T | null> {
  const ref = useRef<T>(null)
  // До первой отрисовки: иначе заголовок мелькнул бы на месте и спрятался
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined' || prefersReducedMotion()) return
    const box = el.getBoundingClientRect()
    // Заголовок уже выше экрана (пришли по якорю ниже него) — показывать нечего, оставляем как есть
    if (box.bottom < 0) return
    const range = document.createRange()
    range.selectNodeContents(el)
    const text = range.getBoundingClientRect()
    if (!text.height) return
    // Сдвиг — от верха блока до низа текста: в начале текст целиком под маской. Маска — по низу текста
    const shift = Math.ceil(text.bottom - box.top)
    const reset = () => {
      el.classList.remove('reveal', 'reveal-mask', 'reveal-in')
      el.style.removeProperty('--reveal-shift')
      el.style.removeProperty('--reveal-cut')
    }
    el.style.setProperty('--reveal-shift', `${shift}px`)
    el.style.setProperty('--reveal-cut', `${Math.max(0, Math.floor(box.bottom - text.bottom))}px`)
    el.classList.add('reveal')
    const done = (e: TransitionEvent) => {
      if (e.target !== el || e.propertyName !== 'transform') return
      el.removeEventListener('transitionend', done)
      reset()
    }
    // Наблюдатель видит сдвинутый блок, поэтому окно продлено вниз на сдвиг: срабатывает, когда на экран
    // выходит место, где заголовок стоит, а не его сдвинутая копия. Пока ждём, заголовок прозрачный, без маски:
    // элемент под маской наблюдатель считает невидимым и не сработал бы никогда
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return
        io.disconnect()
        el.classList.add('reveal-mask')
        // Начальная маска должна попасть в стили до перехода, иначе переходу не от чего двигаться
        void el.offsetWidth
        el.addEventListener('transitionend', done)
        el.classList.add('reveal-in')
      },
      { rootMargin: `0px 0px ${Math.round(shift - window.innerHeight * 0.08)}px 0px` },
    )
    io.observe(el)
    return () => {
      io.disconnect()
      el.removeEventListener('transitionend', done)
      reset()
    }
  }, [])
  return ref
}
