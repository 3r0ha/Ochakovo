// Набор проверки офлайн-Квасыча: 80 вопросов из проверок, «Вопросов к Квасычу», сленга, опечаток, составных и мимо темы.
// Печатает долю верных ответов и падает, если по всему набору меньше 90 % или по отложенной части меньше 85 %.
// Запуск: pnpm test assistant-eval. При настройке правил — EVAL_SET=tune pnpm test assistant-eval: отложенную часть не смотрим.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createAssistant } from '../../server/assistant/assistant'
import type { AssistantTurn } from '../../server/assistant/types'
import { offlineProvider } from '../../server/llm/offline'
import { faqAnswer, type FaqId } from '../../shared/content/faq'
import { scheduleSummary, vacancies } from '../../shared/content/vacancies'

type Row = { set: 'tune' | 'hold'; kind: string; context: string[]; question: string; starts: string[]; has: string[]; forbid: string[] }

const split = (cell: string) => cell.split(' | ').map((s) => s.trim()).filter(Boolean)
const rows: Row[] = readFileSync(new URL('../fixtures/assistant-eval.tsv', import.meta.url), 'utf8')
  .split('\n')
  .filter((line) => line.trim() && !line.startsWith('#') && !line.startsWith('set\t'))
  .map((line) => {
    const [set, kind, context, question, starts, has, forbid] = line.split('\t')
    return { set: set as Row['set'], kind, context: context ? context.split(' >> ') : [], question, starts: split(starts ?? ''), has: split(has ?? ''), forbid: split(forbid ?? '') }
  })

/** Неразрывные пробелы → обычные, чтобы сравнивать с текстом из таблицы */
const plain = (t: string) => t.replace(/[  ]/g, ' ')
/** «faq:practice» — начало ответа из «Вопросов» на сайте, «schedule» — текст «Условий». «Да» в начале FAQ на вопрос не «да или нет» отрезается */
function expected(token: string): string[] {
  if (token === 'schedule') return [scheduleSummary.text.slice(0, 40)]
  if (token.startsWith('faq:')) {
    const a = plain(faqAnswer(token.slice(4) as FaqId))
    const noYes = a.replace(/^Да[.,]\s*/, '')
    return [a.slice(0, 40), noYes.charAt(0).toUpperCase() + noYes.slice(1, 40)]
  }
  return [token]
}

const vacancyId = new RegExp(`(?<![\\w-])(${vacancies.map((v) => v.id).join('|')})(?![\\w-])`)
const WORK_WORD = /работ|смен|ваканс|зарплат|завод|склад|магазин|общаг|общежит|практик|стажир|график|опыт|заявк/i
const YES_NO = (q: string) =>
  /^(а\s+)?(можно|могу|есть|нужен|нужна|нужно|обязательно)(?![а-яё])/i.test(q) ||
  /\s(есть|дают|выдают|бывает|бывают|платят|берут|возьмут|будет)\s*\??$/i.test(q) ||
  (q.includes('?') && !/(?<![а-яё])(сколько|скока|скок|где|как|когда|какой|какая|какие|что|чо|чем|кто|почему|зачем|куда)(?![а-яё])/i.test(q))
/** Предложения первого абзаца до списка; «м.», «ул.», «ст.», «доб.» — не конец фразы */
const sentences = (t: string) => t.replace(/(?<!(?:^|[\s(«])(?:м|ул|ст|доб|г|т|руб|тыс))([.?])\s+(?=[А-ЯЁA-Z«])/g, '$1\u0000').split('\u0000')

/** Пункт вакансии: «**Кладовщик** · от 56 000 ₽» (vacancyBrief); начало списка — он, «• …», «— …» или «1. …» */
const ITEM_HEAD = /^\*\*[^*\n]+\*\* [·—] /
const LIST_LINE = /^(• |— |\d+[.)]\s|\*\*[^*\n]+\*\* [·—] )/

/** Правила формы, общие для всех ответов */
function formProblems(row: Row, text: string): string[] {
  const out: string[] = []
  if (/!|…|undefined|null|NaN/.test(text)) out.push('запрещённые знаки')
  if (vacancyId.test(text)) out.push('технический id')
  if (text.length > 900) out.push('длиннее 900 знаков')
  const [first, ...rest] = text.split('\n\n')
  const lines = first.split('\n')
  const listAt = lines.findIndex((l) => LIST_LINE.test(l))
  const head = listAt < 0 ? lines : lines.slice(0, listAt)
  if (sentences(head.join(' ')).length > 2) out.push('в первом абзаце больше двух предложений')
  // Пункт списка — строка «• …» или «**Вакансия** · …» со строками графика и срока под ней (без точки в конце)
  let run = 0
  let inItem = false
  for (const line of text.split('\n')) {
    if (LIST_LINE.test(line)) {
      run++
      inItem = ITEM_HEAD.test(line)
    } else if (!(inItem && line.trim() && !/[.:]$/.test(line.trim()))) {
      run = 0
      inItem = false
    }
    if (run > 3) {
      out.push('в списке больше трёх пунктов')
      break
    }
  }
  const paragraphs = [first, ...rest].map((p) => p.trim())
  if (new Set(paragraphs).size !== paragraphs.length) out.push('абзац повторяется')
  if (/^Да(?![а-яё])/.test(text) && !YES_NO(row.question)) out.push('«Да» на вопрос не «да или нет»')
  if (row.kind !== 'offtopic' && WORK_WORD.test(row.question) && text.includes('Тут не подскажу')) out.push('рабочий вопрос получил «Тут не подскажу»')
  return out
}

const only = process.env.EVAL_SET
const assistant = createAssistant({ provider: offlineProvider(), log: () => {} })

test('офлайн-Квасыч проходит набор проверки', async () => {
  const picked = rows.filter((r) => !only || r.set === only)
  assert.ok(rows.length >= 60 && rows.length <= 80, `в наборе ${rows.length} вопросов, нужно 60–80`)
  const hold = rows.filter((r) => r.set === 'hold').length
  assert.ok(hold / rows.length >= 0.15 && hold / rows.length <= 0.25, `отложено ${hold} из ${rows.length}`)

  const results: { row: Row; ok: boolean; why: string[]; text: string }[] = []
  for (const row of picked) {
    const history: AssistantTurn[] = []
    for (const q of row.context) {
      const r = await assistant.answer({ question: q, history: [...history], sessionId: 'eval', channel: 'web' })
      history.push({ role: 'user', text: q }, { role: 'assistant', text: r.text })
    }
    const r = await assistant.answer({ question: row.question, history, sessionId: 'eval', channel: 'web' })
    const text = plain(r.text)
    const why: string[] = []
    const starts = row.starts.flatMap(expected)
    if (starts.length && !starts.some((s) => text.startsWith(s))) why.push(`начало не «${starts[0]}»`)
    for (const h of row.has) if (!text.includes(h)) why.push(`нет «${h}»`)
    for (const f of row.forbid) if (text.includes(f)) why.push(`есть «${f}»`)
    why.push(...formProblems(row, r.text))
    results.push({ row, ok: !why.length, why, text: r.text })
  }

  const share = (list: typeof results) => (list.length ? list.filter((x) => x.ok).length / list.length : 1)
  const all = share(results)
  const held = share(results.filter((x) => x.row.set === 'hold'))
  const tuned = share(results.filter((x) => x.row.set === 'tune'))
  for (const x of results.filter((y) => !y.ok)) {
    console.log(`\n✗ [${x.row.set}/${x.row.kind}] ${x.row.context.length ? `${x.row.context.join(' » ')} » ` : ''}${x.row.question}\n  ${x.why.join('; ')}\n  ${x.text.replace(/\n/g, '\n  ')}`)
  }
  const pct = (n: number) => `${Math.round(n * 1000) / 10} %`
  console.log(`\nНабор проверки: ${pct(all)} (${results.filter((x) => x.ok).length} из ${results.length}); настройка — ${pct(tuned)}, отложенная часть — ${pct(held)}`)
  assert.ok(all >= 0.9, `весь набор: ${pct(all)} < 90 %`)
  if (!only || only === 'hold') assert.ok(held >= 0.85, `отложенная часть: ${pct(held)} < 85 %`)
})
