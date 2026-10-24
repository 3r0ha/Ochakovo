// Яндекс Метрика и пиксель VK Рекламы — только когда сервер задал ID счётчиков и человек разрешил их в плашке.
//
// ID приходят метатегом <meta name="analytics" content='{"metrika":…,"vk":…}'> (его ставит сервер, w2-platform, только
// при заданных ID). Нет метатега — нет ни плашки, ни одного запроса к счётчикам. Выбор «Разрешить / Не надо» хранится
// в этом браузере (localStorage, ключ ochakovo.analytics); до согласия скрипты счётчиков не загружаются.
// В цели уходят только тип события, номер задания и метка источника — без имени, телефона и номера заявки.
// Вебвизор выключен.

export type AnalyticsIds = { metrika: string | null; vk: string | null }
export type AnalyticsChoice = 'yes' | 'no'

const KEY = 'ochakovo.analytics'
/** ID счётчика — только цифры: в адрес скрипта и вызовы ничего постороннего не попадёт */
const ID_RE = /^\d{4,12}$/

/** ID счётчиков из метатега; null — счётчиков нет */
export function analyticsIds(doc: Pick<Document, 'querySelector'> | undefined = typeof document === 'undefined' ? undefined : document): AnalyticsIds | null {
  const raw = doc?.querySelector('meta[name="analytics"]')?.getAttribute('content')
  if (!raw) return null
  try {
    const data = JSON.parse(raw) as Record<string, unknown>
    const id = (v: unknown) => (typeof v === 'number' || typeof v === 'string') && ID_RE.test(String(v)) ? String(v) : null
    const ids = { metrika: id(data.metrika), vk: id(data.vk) }
    return ids.metrika || ids.vk ? ids : null
  } catch {
    return null
  }
}

/** Что человек выбрал в плашке; null — ещё не выбирал или хранилище недоступно */
export function analyticsChoice(): AnalyticsChoice | null {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'yes' || v === 'no' ? v : null
  } catch {
    return null
  }
}

type Listener = () => void
const listeners = new Set<Listener>()
/** Подписка на смену выбора — для плашки и строки в подвале */
export function onAnalyticsChange(fn: Listener) {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

type Win = Window & {
  ym?: ((...args: unknown[]) => void) & { a?: unknown[]; l?: number }
  _tmr?: Record<string, unknown>[]
}

let started: AnalyticsIds | null = null

/** Сохранить выбор. «Разрешить» сразу включает счётчики; «Не надо» перестаёт передавать им просмотры и цели */
export function setAnalyticsChoice(choice: AnalyticsChoice) {
  try {
    localStorage.setItem(KEY, choice)
  } catch {
    // Хранилище закрыто (приватный режим): выбор действует до перезагрузки страницы
  }
  memory = choice
  if (choice === 'yes') startAnalytics()
  // «Не надо» после согласия: скрипты уже загружены, но ни просмотров, ни целей им больше не передаём
  else started = null
  for (const fn of listeners) fn()
}

/** Выбор на время визита, если localStorage недоступен */
let memory: AnalyticsChoice | null = null
export const currentChoice = () => analyticsChoice() ?? memory

function addScript(src: string, id: string) {
  if (document.getElementById(id)) return
  const s = document.createElement('script')
  s.async = true
  s.src = src
  s.id = id
  document.head.append(s)
}

/** Загрузить счётчики: только при ID и согласии. Повторный вызов ничего не делает */
export function startAnalytics() {
  if (started || typeof window === 'undefined') return
  const ids = analyticsIds()
  if (!ids || currentChoice() !== 'yes') return
  started = ids
  const w = window as Win
  if (ids.metrika) {
    // Очередь вызовов до загрузки tag.js — так устроен официальный код счётчика
    w.ym ??= Object.assign((...args: unknown[]) => void (w.ym!.a ??= []).push(args), { l: Date.now() })
    w.ym(Number(ids.metrika), 'init', { defer: true, clickmap: false, trackLinks: true, accurateTrackBounce: true, webvisor: false })
    addScript('https://mc.yandex.ru/metrika/tag.js', 'ochakovo-metrika')
  }
  if (ids.vk) {
    w._tmr ??= []
    addScript('https://top-fragment.mail.ru/js/code.js', 'ochakovo-vk-pixel')
  }
  trackPage(location.pathname + location.search)
}

/** Просмотр страницы: сайт одностраничный, поэтому переходы считаем сами */
export function trackPage(url: string) {
  if (!started) return
  const w = window as Win
  if (started.metrika) w.ym?.(Number(started.metrika), 'hit', url)
  if (started.vk) w._tmr?.push({ id: started.vk, type: 'pageView', url, start: Date.now() })
}

/** Цель: тип события и, если есть, задание, вид и метка источника. Ничего личного */
export function reachGoal(goal: string, params: { task?: string; kind?: string; src?: string } = {}) {
  if (!started) return
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => typeof v === 'string' && v))
  const w = window as Win
  if (started.metrika) w.ym?.(Number(started.metrika), 'reachGoal', goal, clean)
  if (started.vk) w._tmr?.push({ id: started.vk, type: 'reachGoal', goal, params: clean })
}
