/**
 * Сайт как мини-приложение Telegram: бот открывает игры кнопкой web_app, и страница живёт внутри мессенджера.
 *
 * Telegram добавляет к адресу #tgWebAppData=…&tgWebAppPlatform=… Внутри данные о пользователе, поэтому хэш стираем
 * сразу, до первой отрисовки: в историю браузера, аналитику и журналы он не попадёт. Сами данные сайту не нужны.
 *
 * Скрипт telegram-web-app.js с telegram.org не подключаем: сайт отдаёт все файлы сам (docs/deploy.md), а нужны
 * только четыре события. Их отправка повторяет официальный скрипт: мобильные приложения и десктоп принимают
 * TelegramWebviewProxy.postEvent, Telegram Web открывает приложение во фрейме и слушает postMessage.
 */

const KEY = 'ochakovo.tg'

/** Цвет шапки и фона Telegram вокруг страницы: тот же, что у сайта (--color-night) */
const NIGHT = '#0c0c0c'

type Bridge = { TelegramWebviewProxy?: { postEvent(type: string, data: string): void }; external?: { notify?(data: string): void } }

function post(eventType: string, eventData: Record<string, unknown> = {}) {
  const w = window as unknown as Bridge
  try {
    if (w.TelegramWebviewProxy) w.TelegramWebviewProxy.postEvent(eventType, JSON.stringify(eventData))
    else if (w.external?.notify) w.external.notify(JSON.stringify({ eventType, eventData }))
    else if (window.parent !== window) window.parent.postMessage(JSON.stringify({ eventType, eventData }), '*')
  } catch {
    // Старый клиент не знает события: страница работает и без него
  }
}

function detect(): boolean {
  const fromHash = /[#&]tgWebApp(Data|Platform|Version)=/.test(window.location.hash)
  if (fromHash) history.replaceState(history.state, '', window.location.pathname + window.location.search)
  try {
    if (fromHash) sessionStorage.setItem(KEY, '1')
    return fromHash || sessionStorage.getItem(KEY) === '1'
  } catch {
    return fromHash
  }
}

/** Страница открыта внутри Telegram. Флаг живёт до закрытия мини-приложения: переходы по сайту хэш не несут */
export const inTelegram = typeof window !== 'undefined' && detect()

/**
 * Подготовить окно Telegram: развернуть на всю высоту, покрасить шапку и фон в цвет сайта, выключить закрытие
 * свайпом вниз (в «Поймай брак» и «Правде или мифе» палец двигается по экрану) и сообщить, что страница готова
 */
export function initTelegram() {
  if (!inTelegram) return
  document.documentElement.dataset.telegram = ''
  post('web_app_set_header_color', { color: NIGHT })
  post('web_app_set_background_color', { color: NIGHT })
  post('web_app_set_bottom_bar_color', { color: NIGHT })
  post('web_app_setup_swipe_behavior', { allow_vertical_swipe: false })
  post('web_app_expand')
  post('web_app_ready')
}
