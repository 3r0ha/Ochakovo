import { randomBytes } from 'node:crypto'
import { REF_CODE_RE } from '@shared/applicationInput'
import { formatRub, maxEntryPay, minMonthlyPay } from '@shared/content/vacancies'
import { reply, siteBase, state, setState, type Ctx } from '../context'
import { link, menuRow, msg } from '../ui'
import type { Button } from '../types'
import { applyOrStatus } from './status'

// «Позвать друга»: личная ссылка на бота или сайт с меткой ref_<код>.
// Друг, пришедший по ссылке, получает источник friend-<код> — HR видит, кто кого привёл.
// Код хранится в сессии пригласившего и уходит в его заявку (refCode). В чате на сайте код свой у браузера:
// его присылает сайт (HandleMeta.refCode), тогда ссылка из чата и ссылка со страницы одинаковые.

export const REF_KEY = 'ref'

/** Код из 6 символов: строчные латинские буквы без похожих на цифры и цифры 2–9 */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

function newCode() {
  const bytes = randomBytes(6)
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('')
}

export function refCode(ctx: Ctx) {
  // Чат на сайте: код браузера, чтобы приглашение из чата и со страницы засчитывалось одному человеку
  const browser = ctx.user.channel === 'web' ? ctx.meta.refCode : undefined
  if (browser && REF_CODE_RE.test(browser)) {
    if (state<string>(ctx, REF_KEY) !== browser) setState(ctx, REF_KEY, browser)
    return browser
  }
  let code = state<string>(ctx, REF_KEY)
  if (!code) {
    code = newCode()
    setState(ctx, REF_KEY, code)
  }
  return code
}

/** Код из start-параметра: ref_<код> → <код>, иначе null */
export function codeFromPayload(payload: string | null | undefined) {
  const m = /^ref_([a-z0-9]{4,12})$/.exec(payload ?? '')
  return m ? m[1] : null
}

/** Ссылка для друга: в своём мессенджере — на бота, если известно его имя, иначе на сайт */
export function inviteLink(ctx: Ctx) {
  const code = refCode(ctx)
  const tg = process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, '')
  const max = process.env.MAX_BOT_NICK?.trim().replace(/^@/, '')
  if (ctx.user.channel === 'telegram' && tg) return `https://t.me/${tg}?start=ref_${code}`
  if (ctx.user.channel === 'max' && max) return `https://max.ru/${max}?start=ref_${code}`
  return `${siteBase(ctx)}/?src=ref_${code}`
}

export function invite(ctx: Ctx) {
  const url = inviteLink(ctx)
  const base =
    `Зову на оплачиваемую практику на завод «Очаково» в Москве: от ${minMonthlyPay.toLocaleString('ru-RU')} до ${formatRub(maxEntryPay)} в месяц до вычета налога, ` +
    'официально, с наставником. Можно без опыта и без резюме.'
  const forward = `${base} Вакансии и заявка: ${url}`
  const buttons: Button[][] = []
  // В Telegram есть готовое окно «поделиться»: ссылку оно подставляет само, поэтому текст без неё
  if (ctx.user.channel === 'telegram') {
    const text = `${base} Вакансии и заявка по ссылке.`
    buttons.push([link('Поделиться', `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`)])
  }
  buttons.push([applyOrStatus(ctx)], menuRow())
  const how = ctx.user.channel === 'web' ? 'Скопируй сообщение ниже и отправь другу.' : 'Перешли сообщение ниже другу.'
  return reply([
    msg(`**Позвать друга**\n\n${how} Заявка нужна от каждого. Если хотите работать вместе, в заявке нажми «Иду с другом», и HR это увидит.`),
    msg(forward, { buttons }),
  ])
}
