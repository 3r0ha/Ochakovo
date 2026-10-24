import { checkApplication, type StartReady } from '@shared/applications'
import { birthDateMessages, maskBirthDate, parseBirthDate } from '@shared/birthDate'
import { responsePromise } from '@shared/candidateStatus'
import { paidPracticeInfo } from '@shared/content/practice'

// Тексты формы заявки, которые зависят от ответа сервера и от выбора человека.
// Без React и браузера — их проверяет scripts/tests/w1-pages-chat-apply.test.ts.

/** Русское число с существительным: 1 секунду, 2 секунды, 5 секунд */
export function plural(n: number, forms: [string, string, string]) {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return forms[0]
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1]
  return forms[2]
}

/** Сколько подождать: до двух минут — секундами, дальше — минутами с округлением вверх. «30 секунд», «4 минуты» */
export function waitText(seconds: number) {
  const s = Math.max(1, Math.ceil(Number.isFinite(seconds) ? seconds : 60))
  if (s < 120) return `${s} ${plural(s, ['секунду', 'секунды', 'секунд'])}`
  const m = Math.ceil(s / 60)
  return `${m} ${plural(m, ['минуту', 'минуты', 'минут'])}`
}

export type RejectReason = 'already_applied' | 'rate_limited' | 'phone_limit'

/**
 * Что сказать, если сервер не принял заявку, хотя поля верные. whatsapp — показать рядом ссылку на WhatsApp отдела персонала.
 * 409 — номер уже в заявке, 429 — много заявок с одной сети (ярмарка, общежитие) или с одного номера
 */
export function rejectedText(reason: RejectReason, retryAfter = 0): { text: string; whatsapp: boolean } {
  if (reason === 'already_applied') return { text: 'Заявка с этого номера уже принята, с тобой свяжутся.', whatsapp: false }
  if (reason === 'phone_limit') return { text: `С этого номера или ника за последний час пришло уже несколько заявок. Подожди ${waitText(retryAfter)} или напиши в WhatsApp.`, whatsapp: true }
  return { text: `С этой сети сейчас много заявок. Подожди ${waitText(retryAfter)} или напиши в WhatsApp.`, whatsapp: true }
}

/** Обещание срока ответа одной фразой с точкой: у кнопки отправки и на экране «Заявка отправлена». Ник без телефона — HR напишет */
export const promiseLine = (byMessage: boolean) => `${responsePromise(byMessage ? 'message' : 'call')}.`

/** Ошибка отметки согласия. Возраст отметкой больше не спрашиваем: 18+ проверяется по дате рождения */
export const consentMessages = {
  consent: 'Без согласия на обработку данных заявку не отправить',
}

// ── Поля кейса: ФИО, дата рождения, учёба, когда можно выйти (docs/case-delta.md, w2-pc-c1) ──────

/** Что из полей кейса заполнено в форме. birthDate — как набрано, ДД.ММ.ГГГГ */
export type CaseFields = {
  lastName: string
  birthDate: string
  school: string
  notStudying: boolean
  startReady: StartReady | ''
  startMonth: number | null
}

export type CaseFieldKey = 'lastName' | 'birthDate' | 'school' | 'startReady' | 'startMonth'
const caseKeys: CaseFieldKey[] = ['lastName', 'birthDate', 'school', 'startReady', 'startMonth']

/**
 * Ошибки полей кейса — та же проверка, что на сервере и в боте (checkApplication с candidate: true), только поля кейса.
 * underage — дата рождения есть, но 18 ещё нет: на работу, стажировку и практику берут с 18 лет
 */
export function caseFieldErrors(f: CaseFields, now: Date | number = Date.now()): { errors: Partial<Record<CaseFieldKey, string>>; underage: boolean } {
  const { errors, codes } = checkApplication({ ...f, startReady: f.startReady || undefined, startMonth: f.startMonth ?? undefined }, { candidate: true, now })
  const picked: Partial<Record<CaseFieldKey, string>> = {}
  for (const k of caseKeys) if (errors[k]) picked[k] = errors[k]
  return { errors: picked, underage: codes.birthDate === 'underage' }
}

/** Ввод даты рождения на лету: цифры раскладываются в ДД.ММ.ГГГГ, точки ставятся сами — на телефоне цифровая клавиатура без точки */
export const typeBirthDate = (typed: string) => maskBirthDate(typed).slice(0, 10)

/** Дата для заявки: ГГГГ-ММ-ДД, если её удалось прочитать, иначе как набрано — сервер ответит понятной ошибкой */
export const birthDateForSend = (typed: string) => parseBirthDate(typed.trim()) ?? typed.trim()

/** Текст ошибки даты рождения по ответу сервера: моложе 18 — всегда одна и та же фраза «Берём с 18 лет…» */
export const serverBirthDateError = (message: string | undefined, code: string | undefined) =>
  code === 'underage' ? birthDateMessages.underage : message || (code ? birthDateMessages.format : undefined)

/** Приглашение другу: главный факт практики первым, сумма — из shared/content/practice.ts */
export const inviteOffer = () =>
  `Оплачиваемая практика в «Очаково»: от ${rubles(paidPracticeInfo.payFrom)} до ${rubles(paidPracticeInfo.payTo)} в месяц до вычета налога, наставник у каждого новичка. Заявка занимает 2 минуты.`

const rubles = (n: number) => `${n.toLocaleString('ru-RU').replace(/\s/g, '\u00A0')}\u00A0₽`

/** Друг без имени: так же пишет бот (server/dialog/flows/apply.ts, FRIEND_NO_NAME) — HR видит «Идёт с другом» */
export const FRIEND_NO_NAME = 'имя не указано'

/** Что уходит в поле friend заявки: имя друга, «имя не указано» или пусто, если отметки «Иду с другом» нет */
export const friendField = (withFriend: boolean, name: string) => (withFriend ? name.trim().slice(0, 160) || FRIEND_NO_NAME : '')

/** Имя друга для текста на экране успеха: без заглушки «имя не указано» */
export const friendName = (friend: string | undefined) => {
  const f = (friend ?? '').trim()
  return f && f !== FRIEND_NO_NAME ? f : ''
}
