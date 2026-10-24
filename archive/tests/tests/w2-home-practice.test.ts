// Главная по полному кейсу: блок оплачиваемой практики (w2-hm-c1), «Смена изнутри» (w2-hm-c3), контроль качества
// нарисованной линией (w2-hm-2), пиктограммы брендбука (w2-hm-c6), «Собери лето» без выдуманных ролей.
// Разметку в браузере проверяет scripts/e2e/w2-home.ts. Запуск: pnpm test w2-home

import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { test } from 'node:test'
import sharp from 'sharp'
import { perks } from '../../shared/content/content'
import { dorm } from '../../shared/content/handbook'
import { paidPracticeInfo } from '../../shared/content/practice'
import { paidPractice, vacancyById } from '../../shared/content/vacancies'
import { SHIFT_VIDEOS } from '../../src/components/ShiftVideo'

const read = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')
/** Без комментариев: проверяем то, что видит человек, а не пояснения к коду */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
const practice = read('src/home/Practice.tsx')
const shift = read('src/home/ShiftInside.tsx')
const pictogram = read('src/home/Pictogram.tsx')
const history = read('src/home/History.tsx')
const path = read('src/home/ProductionPath.tsx')
const qc = read('src/home/QcFragment.tsx')
const money = read('src/home/Money.tsx')
const manifest = JSON.parse(read('public/brand/pictograms/manifest.json')) as { pictograms: { id: string }[]; excluded: { id: string }[] }

test('заголовок блока практики — факт в две строки, без девиза «Сначала научим, потом доверим»', () => {
  const m = /export const PRACTICE_TITLE = \['([^']+)', '([^']+)'\] as const/.exec(practice)
  assert.ok(m, 'в Practice.tsx нет PRACTICE_TITLE')
  assert.deepEqual([m[1], m[2]], ['Практика', 'с наставником'])
  assert.match(practice, /\{PRACTICE_TITLE\[0\]\}\s*<br \/>\s*<span className="text-brand">\{PRACTICE_TITLE\[1\]\}<\/span>/)
  assert.doesNotMatch(code(practice), /Сначала научим|потом доверим/)
})

test('факты блока практики из официальных материалов: 4 отдела, 5 ролей, 56 000–70 000 ₽, общежитие, обед, медосмотр', () => {
  assert.equal(paidPracticeInfo.units.length, 4)
  assert.equal(paidPractice.length, 5)
  assert.equal(paidPracticeInfo.payFrom, 56000)
  assert.equal(paidPracticeInfo.payTo, 70000)
  assert.equal(dorm.priceStudent, 3400)
  // Суммы и отделы — из данных, а не цифрами в разметке
  assert.match(practice, /paidPracticeInfo\.payFrom/)
  assert.match(practice, /paidPracticeInfo\.payTo/)
  assert.match(practice, /dorm\.priceStudent/)
  assert.doesNotMatch(code(practice), /\b(56|60|70)\s?000\b/)
  // Тексты льгот — из perks: заголовки, на которые ссылается блок, есть, и в них нужные факты
  const titles = [...practice.matchAll(/perkText\('([^']+)'\)/g)].map((m) => m[1])
  assert.deepEqual(titles.sort(), ['Без испытательного срока', 'Наставник', 'Обед за полцены', 'Скидка на продукцию', 'Спецодежда и медосмотр'].sort())
  const text = (t: string) => perks.find((p) => p.title === t)?.text ?? ''
  for (const t of titles) assert.ok(text(t), `в perks нет «${t}»`)
  assert.match(text('Спецодежда и медосмотр'), /медосмотр оплачивает компания/)
  assert.match(text('Обед за полцены'), /Половину стоимости/)
  assert.match(text('Наставник'), /Учебном центре/)
  // Чего в материалах нет — не обещаем
  assert.doesNotMatch(code(practice), /ДМС|с первого дня|бесплатн\S* жиль|гарантир/i)
})

test('кадр «наставник и новичок у пульта»: свои файлы рядом с блоком, лёгкие, с подписью и описанием', async () => {
  for (const [file, width] of [
    ['mentor-panel-840.avif', 840],
    ['mentor-panel-840.webp', 840],
    ['mentor-panel-560.avif', 560],
    ['mentor-panel-560.webp', 560],
  ] as const) {
    const url = new URL(`../../src/home/media/${file}`, import.meta.url)
    assert.ok(statSync(url).size <= 40 * 1024, `${file}: больше 40 КБ`)
    const meta = await sharp(url.pathname).metadata()
    assert.equal(meta.width, width, `${file}: ширина`)
    assert.ok(Math.abs(meta.width! / meta.height! - 840 / 550) < 0.02, `${file}: пропорция`)
    assert.match(practice, new RegExp(`new URL\\('\\./media/${file.replace('.', '\\.')}', import\\.meta\\.url\\)`))
  }
  assert.match(practice, /width=\{840\}\s+height=\{550\}/)
  assert.match(practice, /alt="[^"]{20,}"/)
  assert.match(practice, /Кадр из ролика «Очаково»/)
})

test('«Смена изнутри»: три ролика из манифеста, ссылки на настоящие вакансии, без автозапуска', () => {
  const items = [...shift.matchAll(/\{ id: '([a-z-]+)'(?:, vacancy: '([a-z-]+)')? \}/g)].map((m) => ({ id: m[1], vacancy: m[2] }))
  assert.deepEqual(
    items.map((i) => i.id),
    ['bottling-operator', 'lab-assistant', 'machinist'],
  )
  for (const i of items) {
    assert.ok(SHIFT_VIDEOS.some((v) => v.id === i.id), `нет ролика ${i.id}`)
    if (i.vacancy) assert.ok(vacancyById(i.vacancy), `нет вакансии ${i.vacancy}`)
  }
  // Плеер — общий ShiftVideo с постером: preload="none", без звука, пауза вне экрана (проверяет c2-brand-media-shiftvideo)
  assert.match(shift, /<ShiftVideo id=\{item\.id\}/)
  assert.doesNotMatch(shift, /autoPlay|autoplay|preload=/)
  assert.doesNotMatch(shift, /variant=/, 'на главной — постер, не кнопка')
})

test('контроль качества в «Пути кваса» — нарисованная линия с бутылкой из игры и браком, кнопка в «Поймай брак»', () => {
  assert.match(path, /if \(stage\.id === 'qc'\) return <QcFragment className=\{className\} \/>/)
  assert.match(qc, /import \{ Bottle, type BottleKind \} from '\.\.\/game\/Bottle'/)
  const row = /const ROW: BottleKind\[\] = \[([^\]]+)\]/.exec(qc)?.[1] ?? ''
  const kinds = [...row.matchAll(/'([a-z]+)'/g)].map((m) => m[1])
  assert.equal(kinds.filter((k) => k !== 'ok').length, 1, 'брак на ленте — один')
  assert.ok(kinds.length >= 4)
  assert.match(qc, /role="img"/)
  assert.match(qc, /aria-label=/)
  assert.match(path, /Попробовать в «Поймай брак»/)
  assert.match(path, /scrollToTarget\('#play', HEADER_OFFSET\)/)
})

test('пиктограммы — только официальные из брендбука, без пивных, одна группа одного масштаба', () => {
  const used = [...pictogram.matchAll(/^\s+'?([a-z-]+)'?: '[^']+',$/gm)].map((m) => m[1])
  assert.ok(used.length >= 8, `пиктограмм в списке: ${used.length}`)
  const known = new Set(manifest.pictograms.map((p) => p.id))
  const excluded = new Set(manifest.excluded.map((p) => p.id))
  for (const id of used) {
    assert.ok(known.has(id), `${id}: нет в манифесте брендбука`)
    assert.ok(!excluded.has(id), `${id}: исключена`)
  }
  // Отделы практики и годы истории — каждые своей пиктограммой, без повторов на странице
  const units = /const unitPictogram: Record<string, PictogramId> = \{([\s\S]+?)\n\}/.exec(practice)?.[1] ?? ''
  const stops = /const stopPictogram: Record<string, PictogramId> = \{([\s\S]+?)\n\}/.exec(history)?.[1] ?? ''
  const ids = [...`${units}\n${stops}`.matchAll(/: '([a-z-]+)'/g)].map((m) => m[1])
  assert.equal(new Set(ids).size, ids.length, `повтор пиктограмм: ${ids}`)
  for (const unit of paidPracticeInfo.units) assert.match(units, new RegExp(`'?${unit}'?: '`), `у отдела «${unit}» нет пиктограммы`)
  // Квадрат без растяжения, цвет — currentColor
  assert.match(pictogram, /aspect-square/)
  assert.match(pictogram, /bg-current/)
})

test('«Собери лето»: только живые вакансии 2/2, у практики нет сентября', () => {
  const ids = [...money.slice(money.indexOf('const roles'), money.indexOf('const SUMMER')).matchAll(/id: '([a-z-]+)'/g)].map((m) => m[1])
  for (const id of ids) assert.ok(vacancyById(id), `нет вакансии ${id}`)
  assert.match(money, /const PRACTICE_MONTHS = \[3, 4, 5, 6, 7, 8\]/)
  assert.match(money, /disabled=\{off\}/)
  assert.match(money, /В сентябре практики нет/)
})
