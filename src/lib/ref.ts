// Личный код приглашения этого браузера: «Позвать друга» на сайте и в веб-чате.
// Код — 6 символов того же алфавита, что у бота (server/dialog/flows/friend.ts): без 0, 1, i, l, o.
// Друг открывает ссылку ?src=ref_<код>, сайт превращает её в метку friend-<код>, код уходит с заявкой
// и связывает заявки пригласившего и приглашённого. Свою же ссылку сайт приглашением не считает.

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
const KEY = 'ochakovo.ref'
const valid = (v: string | null | undefined): v is string => typeof v === 'string' && v.length === 6 && [...v].every((ch) => ALPHABET.includes(ch))

let memo: string | null = null

function randomCode() {
  // Без перекоса: байты от 248 и выше пропускаем, 248 делится на 31 нацело
  const out: string[] = []
  while (out.length < 6) {
    for (const b of crypto.getRandomValues(new Uint8Array(12))) {
      if (b < 248 && out.length < 6) out.push(ALPHABET[b % ALPHABET.length])
    }
  }
  return out.join('')
}

/** Код этого браузера. Создаётся один раз и хранится в localStorage; без хранилища живёт до перезагрузки */
export function myRefCode(): string {
  if (memo) return memo
  try {
    const saved = localStorage.getItem(KEY)
    if (valid(saved)) return (memo = saved)
  } catch {
    // хранилище недоступно — код проживёт до перезагрузки страницы
  }
  memo = randomCode()
  try {
    localStorage.setItem(KEY, memo)
  } catch {
    // см. выше
  }
  return memo
}

/**
 * Ссылка-приглашение на страницу сайта: inviteUrl() → https://…/?src=ref_<код>,
 * inviteUrl('/#money') → https://…/?src=ref_<код>#money, inviteUrl('/game') → https://…/game?src=ref_<код>
 */
export function inviteUrl(pathAndHash = '/'): string {
  const url = new URL(pathAndHash, window.location.origin)
  url.searchParams.set('src', `ref_${myRefCode()}`)
  return url.toString()
}

/** Код из метки источника friend-<код>; другая метка или кривой код — null */
export function refCodeFromSource(source: string | null | undefined): string | null {
  const m = /^friend-([a-z0-9]{4,12})$/.exec(source ?? '')
  return m ? m[1] : null
}

/** Ссылка ведёт на свой же код: человек открыл собственное приглашение — это не приглашение */
export const isOwnRefCode = (code: string | null | undefined) => valid(code) && code === myRefCode()

/**
 * Код того, кто пригласил этот браузер, по метке источника. null — пришли не по приглашению
 * или по своей же ссылке: свой код не засчитывается
 */
export function invitedBy(source: string | null | undefined): string | null {
  const code = refCodeFromSource(source)
  return code && !isOwnRefCode(code) ? code : null
}
