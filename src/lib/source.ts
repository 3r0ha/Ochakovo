import { useProfile } from '../store/profile'
import { trackEvent } from './api'
import { isOwnRefCode } from './ref'

/**
 * Метка источника из QR-кода на ярмарке, рекламной ссылки или приглашения друга.
 * Пример: https://…/?src=fair-mgupp — HR потом видит, какая площадка привела кандидата.
 * Приглашение ?src=ref_<код> превращается в friend-<код>, как в ботах; своя же ссылка не засчитывается.
 * Запоминается первая метка. Заодно отмечаем визит в анонимной воронке — раз за сессию браузера.
 */
export function captureSource() {
  const params = new URLSearchParams(window.location.search)
  const raw = (params.get('src') ?? params.get('utm_source') ?? '').trim()
  const ref = /^ref_([a-z0-9]{4,12})$/.exec(raw)
  const src = ref ? (isOwnRefCode(ref[1]) ? '' : `friend-${ref[1]}`) : raw.replace(/[^\p{L}\p{N}_.:-]/gu, '').slice(0, 64)
  if (src) useProfile.getState().setSource(src)

  // Панель HR — не посетитель сайта
  if (window.location.pathname.startsWith('/hr')) return
  try {
    if (sessionStorage.getItem('ochakovo.visit') === '1') return
    sessionStorage.setItem('ochakovo.visit', '1')
  } catch {
    // без sessionStorage дубли визитов отсеет сервер
  }
  trackEvent('visit')
}
