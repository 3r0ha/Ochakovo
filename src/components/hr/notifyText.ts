import type { NotifyPlan } from '../../lib/api'

/** Что будет с сообщением кандидату — строкой для всплывающего сообщения */
export function planText(plan: NotifyPlan | null | undefined): string | undefined {
  if (!plan) return undefined
  if (plan.notify === 'queued') {
    const secs = Math.max(1, Math.round((new Date(plan.sendAt).getTime() - Date.now()) / 1000))
    return `Сообщение кандидату ${plan.detail} через ${secs} с, до отправки его можно отменить`
  }
  if (plan.notify === 'call') return `Бот не напишет: ${plan.detail}. Текст для звонка есть в карточке`
  return `Сообщение не отправится: ${plan.detail}`
}
