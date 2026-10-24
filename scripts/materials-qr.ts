// QR-коды для макетов docs/brand: листовки, ролл-ап и табличка на стол.
// Ссылки — как их строит вкладка HR «Источники» (sourceLinks из shared/sources.ts): сайт с меткой точки контакта ?src=.
// В макетах — рабочий стенд antihype.best с демо-метками, сканируется и открывает живой сайт. Адрес компании появится при запуске.
// Перед тиражом QR с меткой своей точки скачивают в HR-панели («Источники» → метка → SVG) и ставят на место этого.
// Кодировщик — shared/qr.ts, тот же, что у HR-панели. Запуск: npx tsx scripts/materials-qr.ts

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { encodeQr, qrSvg } from '../shared/qr'
import { siteBase, sourceLinks } from '../shared/sources'

/** Рабочий стенд команды (docs/deploy.md, «Домен antihype.best») */
export const DEMO_SITE = 'https://antihype.best'

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
  // Финальный слайд презентации: сайт с меткой «презентация», игры и материалы кейса
  ['deck/qr/site.svg', tagged('deck')],
  ['deck/qr/play.svg', `${siteBase(DEMO_SITE)}/play?src=deck`],
  ['deck/qr/materials.svg', `${siteBase(DEMO_SITE)}/materials`],
  // Финал короткой презентации: подробная презентация для жюри
  ['deck/qr/deck.svg', `${siteBase(DEMO_SITE)}/materials/deck/index.html`],
]

for (const [rel, link] of codes) {
  const file = join(root, 'docs/brand', rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, qrSvg(encodeQr(link), { title: `QR: ${link}` }) + '\n')
  console.log(`docs/brand/${rel}  ${link}`)
}
