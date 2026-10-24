import { hrContactsLine } from '@shared/candidateStatus'
import { contacts } from '@shared/content/content'
import { reply, siteBase, state, type Ctx } from '../context'
import { btn, link, menuRow, msg } from '../ui'
import { bookingRows } from './booking'
import { checkinRows } from './checkin'
import type { Button } from '../types'

// «Что с моей заявкой»: статус глазами кандидата из shared/candidateStatus — та же логика, что на странице «Моя заявка».
// Заявку находим по мессенджеру и id пользователя, в чате на сайте — по номеру и токену из браузера.

export const APPLIED_KEY = 'applied'

/** «Моя заявка» вместо «Откликнуться», если заявка уже есть: не зовём откликаться второй раз */
export const applyOrStatus = (ctx: Ctx, label = 'Откликнуться', action = 'm:apply'): Button =>
  ctx.hasApplication ? btn('Моя заявка', 'm:status') : btn(label, action)

const when = (iso: string) => {
  const d = new Date(iso)
  const day = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' }).format(d)
  const time = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }).format(d)
  return `${day}, ${time} по Москве`
}

export async function show(ctx: Ctx) {
  const st = await ctx.candidate()
  const sentHere = state<string>(ctx, APPLIED_KEY)
  // Заявка этого браузера известна сессии, но браузер не прислал номер и токен — статус покажет страница «Моя заявка»
  if (!st && typeof sentHere === 'string' && sentHere && ctx.user.channel === 'web') {
    return reply(
      msg(`Заявка № ${sentHere} у отдела персонала. Что с ней сейчас, видно на странице «Моя заявка».`, {
        buttons: [[link('Моя заявка', `${siteBase(ctx)}/apply`)], [btn('Позвать друга', 'm:friend'), btn('Вакансии', 'm:vac')], menuRow()],
      }),
    )
  }
  if (!st) {
    const where = ctx.user.channel === 'web' ? 'из этого браузера' : 'из этого чата'
    return reply(
      msg(
        `Заявки ${where} я не вижу. Если она отправлена с сайта или из другого мессенджера, статус подскажут в отделе персонала: ${hrContactsLine}. Назови телефон из заявки. ` +
          'Новую заявку можно оставить здесь же.',
        { buttons: [[btn('Откликнуться', 'm:apply'), btn('Вакансии', 'm:vac')], menuRow()] },
      ),
    )
  }
  // Первой строкой — номер заявки, как на странице «Моя заявка»; дальше что с ней и что делать
  const head = `**Заявка № ${st.id}**${st.vacancyTitle ? ` · ${st.vacancyTitle}` : ''}\n${st.title}.`
  const interview = st.interview
    ? `\n\nСобеседование: ${when(st.interview.startsAt)}\nАдрес: ${st.interview.address}${st.interview.bring ? `\nВзять с собой: ${st.interview.bring}` : ''}`
    : ''
  // Первая смена — с собеседования и дальше или если HR уже назначил дату; «Как подготовиться» — при собеседовании и оформлении.
  // Пустое не показываем
  const shift = st.firstShift && (st.firstShift.at || ['interview', 'offer', 'started'].includes(st.stage)) ? `\n\nПервая смена: ${st.firstShift.text}` : ''
  const prepare = st.prepare?.items.length ? `\n\n**${st.prepare.title}**\n${st.prepare.items.map((i) => `• ${i}`).join('\n')}` : ''
  // Самозапись: HR предложил выбрать время — «Выбрать время собеседования»; уже записан — «Другое время» и «Отменить запись»
  // Новичку — «Как дела на смене»: вопрос, который ждёт ответа, и «Пусть HR позвонит»
  const buttons: Button[][] = [
    ...(st.stage === 'closed' ? [] : await bookingRows(ctx)),
    ...(st.stage === 'offer' || st.stage === 'started' ? await checkinRows(ctx) : []),
    [btn('Позвать друга', 'm:friend'), btn('Вакансии', 'm:vac')],
  ]
  // Связаться самому: WhatsApp — везде; «Позвонить» — только на сайте (Telegram и MAX не открывают tel: из кнопок)
  const contact: Button[] = [link('Написать в WhatsApp', `https://wa.me/${contacts.whatsapp}`)]
  if (ctx.user.channel === 'web') contact.unshift(link('Позвонить', `tel:${contacts.phone.replace(/[^+\d]/g, '')}`))
  if (st.stage !== 'started') buttons.unshift(contact)
  // Заявка закрыта — честно предлагаем другую вакансию
  if (st.stage === 'closed') buttons.unshift([btn('Откликнуться', 'm:apply')])
  // Удалить свои данные можно в мессенджере; на сайте — на странице «Моя заявка»
  if (ctx.user.channel !== 'web' && ctx.storage.eraseUser) buttons.push([btn('Удалить мои данные', 'del:ask')])
  return reply(msg(`${head} ${st.text}${interview}${shift}${prepare}`, { buttons: [...buttons, menuRow()] }))
}

/**
 * «Что с моей заявкой» — personal: человек говорит о своей заявке, отвечаем статусом даже без заявки.
 * generic: «когда позвонят» — статус, только если заявка есть; иначе это вопрос о порядке, его отвечает помощник
 */
export function statusIntent(text: string): 'personal' | 'generic' | null {
  const t = text.toLowerCase().replace(/ё/g, 'е')
  if (
    /(мо[яюейи]|сво[юейя])\s+заявк|заявк[аеиуой]*\s+(уже\s+)?(кидал|скидывал|отправлял|отправил|подавал|подал|оставлял|оставил|слал|отсылал)|(кидал|скидывал|отправлял|отправил|подавал|подал|оставлял|оставил)[а-я]*\s+(уже\s+)?заявк|(что|чо|че|чего|как)\s+(там\s+)?(с|по)\s+(мо[ейя]+\s+)?заявк|статус|номер\s+(мо[ейя]+\s+)?заявк|мо[яю]\s+заявк/.test(
      t,
    )
  )
    return 'personal'
  if (/когда\s+(мне\s+)?(позвон|перезвон|свяж|ответ|напиш)|(не|никто не)\s+(позвонил|перезвонил|звонил|ответил)|собеседовани[ея]\s+когда|когда\s+(мое\s+|у меня\s+)?собеседовани/.test(t)) return 'generic'
  return null
}
