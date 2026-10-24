import { departmentList, departments, type DepartmentId } from '@shared/content/departments'
import { reply, type Ctx } from '../context'
import { btn, menuRow, msg, rows } from '../ui'
import type { Button } from '../types'

// «Напомнить о наборе»: подписка в Telegram и MAX для тех, кто пока не готов откликнуться — например, в межсезонье.
// Человек выбирает направление, бот хранит время подписки (согласие на такие сообщения), метку источника и направление
// в bot_users (миграция 018). Рассылку отправляет пакет рассылок. «Не присылать» — одной кнопкой, без вопросов.
// Чат на сайте напоминаний не шлёт: там подписки нет.
//
// Кнопки: m:remind — выбор направления, rm:<направление|any> — подписаться, rm:off — «Не присылать»

export const REMIND_TITLE = 'Напомнить о наборе'
const OFF_LABEL = 'Не присылать'

const WHAT = `Напишу, когда откроется набор на сезон и когда до конца приёма останется неделя. Чтобы отписаться, нажми «${OFF_LABEL}».`

/** Подписка доступна: мессенджер, а не сайт, и хранилище её умеет */
export const remindAvailable = (ctx: Ctx) => ctx.user.channel !== 'web' && Boolean(ctx.storage.setRemind)

/**
 * Кнопка подписки после заданий и в меню — только если заявки нет и человек ещё не подписан.
 * Подписанному в меню — «Не присылать о наборе»
 */
export function remindRows(ctx: Ctx, inMenu = false): Button[][] {
  if (!remindAvailable(ctx)) return []
  if (ctx.session.remind) return inMenu ? [[btn(`${OFF_LABEL} о наборе`, 'rm:off')]] : []
  return ctx.hasApplication ? [] : [[btn(REMIND_TITLE, 'm:remind')]]
}

export function offer(ctx: Ctx) {
  if (!remindAvailable(ctx)) return reply(msg('Напоминания о наборе приходят в боте Квасыча в Telegram или MAX.', { buttons: [menuRow()] }))
  const current = ctx.session.remind
  const now = current ? `\n\nСейчас подписка включена${current.dept !== 'any' && departments[current.dept as DepartmentId] ? ` на направление «${departments[current.dept as DepartmentId].name}»` : ''}.` : ''
  return reply(
    msg(`**${REMIND_TITLE}**\n\n${WHAT}${now}\n\nКакое направление интересно?`, {
      buttons: [
        ...rows(departmentList.map((d) => btn(d.name, `rm:${d.id}`)), 2),
        [btn('Любое', 'rm:any')],
        ...(current ? [[btn(OFF_LABEL, 'rm:off')]] : []),
        menuRow(),
      ],
    }),
  )
}

export async function route(ctx: Ctx, parts: string[]) {
  const arg = parts[1] ?? ''
  if (!remindAvailable(ctx)) return offer(ctx)
  if (arg === 'off') {
    await ctx.storage.setRemind!(ctx.user, null)
    ctx.session.remind = null
    return reply(msg(`Больше не напоминаю о наборе. Включить снова можно кнопкой «${REMIND_TITLE}» в меню.`, { buttons: [menuRow()] }), 'Напоминания выключены')
  }
  const dept = arg === 'any' ? 'any' : departments[arg as DepartmentId] ? arg : null
  if (!dept) return offer(ctx)
  await ctx.storage.setRemind!(ctx.user, { dept, source: ctx.session.source })
  ctx.session.remind = { dept }
  const where = dept === 'any' ? 'на любое направление' : `на направление «${departments[dept as DepartmentId].name}»`
  return reply(msg(`Готово, напомню о наборе ${where}. Чтобы отписаться, нажми «${OFF_LABEL}».`, { buttons: [[btn(OFF_LABEL, 'rm:off')], menuRow()] }), 'Напоминание включено')
}
