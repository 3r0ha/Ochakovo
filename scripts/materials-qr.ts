// QR-коды для макетов docs/brand: листовки, ролл-ап и табличка на стол.
// Ссылки — как их строит вкладка HR «Источники» (sourceLinks из shared/sources.ts): сайт с меткой точки контакта ?src=.
// Адрес сайта ещё не утверждён, поэтому в макетах — демо-адрес из docs/deploy.md с демо-метками; в макетах это подписано.
// Перед тиражом QR с меткой своей точки скачивают в HR-панели («Источники» → метка → SVG) и ставят на место этого.
// Кодировщик — shared/qr.ts, тот же, что у HR-панели. Запуск: npx tsx scripts/materials-qr.ts

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { encodeQr, qrSvg } from '../shared/qr'
import { siteBase, sourceLinks } from '../shared/sources'

/** Демо-адрес сайта: тот же, что в примерах docs/deploy.md и server/app.ts */
export const DEMO_SITE = 'https://season.ochakovo.ru'

const root = join(import.meta.dirname, '..')
const site = { url: DEMO_SITE, bots: { telegram: null, max: null } }
const tagged = (code: string) => sourceLinks(code, site).site

/** Файл в docs/brand → ссылка. Метки — из демо-данных HR-панели (server/db/sources.ts) */
const codes: [string, string][] = [
  // Листовка A5 и ролл-ап — стенд на ярмарке вакансий
  ['print/qr/fair-mgupp.svg', tagged('fair-mgupp')],
  ['stand/qr/fair-mgupp.svg', tagged('fair-mgupp')],
  // Вкладыш для вузов — центр карьеры
  ['print/qr/edu-mgupp.svg', tagged('edu-mgupp')],
  // Табличка на стол — контрольные вопросы с меткой той же ярмарки
  ['stand/qr/quiz-fair-mgupp.svg', `${siteBase(DEMO_SITE)}/game?t=quiz&src=fair-mgupp`],
]

for (const [rel, link] of codes) {
  const file = join(root, 'docs/brand', rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, qrSvg(encodeQr(link), { title: `QR: ${link}` }) + '\n')
  console.log(`docs/brand/${rel}  ${link}`)
}
