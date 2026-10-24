import { SEASON } from '@shared/content/handbook'
import { stages } from '@shared/content/production'
import { vacancyById } from '@shared/content/vacancies'
import { reply, withImage, type Ctx } from '../context'
import { photoJpeg } from '../images'
import { btn, menuRow, msg, plural } from '../ui'
import type { Button } from '../types'
import { payText } from './vacancies'
import { applyOrStatus } from './status'

// «Путь кваса» — от зерна до полки и кто работает на каждом этапе. То же название, что на сайте

export const TOUR_TITLE = 'Путь кваса'

const stageVacancies = (i: number) => stages[i].vacancies.map((id) => vacancyById(id)).filter((v) => v !== undefined)

export async function stage(ctx: Ctx, index: number) {
  if (index >= stages.length) {
    return reply(
      msg(
        `**${TOUR_TITLE} пройден**\n\nОт зерна до полки квас проходит ${stages.length} ${plural(stages.length, 'этап', 'этапа', 'этапов')}. ` +
          `В сезон, ${SEASON.text}, людей больше всего нужно в цехах, на складе и в лаборатории, туда и берут на оплачиваемую практику.`,
        { buttons: [[btn('Вакансии и зарплаты', 'v:list:0'), applyOrStatus(ctx)], menuRow()] },
      ),
    )
  }
  const i = Math.max(index, 0)
  const s = stages[i]
  const people = stageVacancies(i)
    .map((v) => `• ${v.title}: ${payText(v)}`)
    .join('\n')
  const nav: Button[] = []
  if (i > 0) nav.push(btn('Назад', `t:${i - 1}`))
  nav.push(btn(i + 1 < stages.length ? 'Дальше' : 'Закончить', `t:${i + 1}`))
  return reply(
    msg(`**${TOUR_TITLE} · ${i + 1} из ${stages.length}**\n**${s.title}**\n\n${s.text}\n\nЗдесь работают:\n${people}`, {
      ...withImage(await photoJpeg(s.photo)),
      buttons: [nav, [btn('Вакансии этапа', `t:v:${i}`)], menuRow()],
    }),
  )
}

function stageVacancyList(i: number) {
  const index = stages[i] ? i : 0
  const s = stages[index]
  return reply(
    msg(`**${s.title}: вакансии**\n\nНажми, чтобы открыть подробности.`, {
      buttons: [...stageVacancies(index).map((v) => [btn(v.title, `v:open:${v.id}`)]), [btn('Вернуться к пути кваса', `t:${index}`)], menuRow()],
    }),
  )
}

export function route(ctx: Ctx, parts: string[]) {
  if (parts[1] === 'v') return stageVacancyList(Number(parts[2]) || 0)
  return stage(ctx, Number(parts[1]) || 0)
}
