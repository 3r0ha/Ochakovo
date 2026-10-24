// Страница вакансий по «Описанию практики» (w2-pc-c2): сначала оплачиваемая практика, затем бесплатная по договорённости,
// затем работа; у ролей с роликом компании — «Посмотреть смену». Поведение в браузере — scripts/e2e/pages-chat.ts.
// Запуск: pnpm test w2-pages-chat

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { freePractice, paidPractice, PRACTICE_PERIOD, vacancies, vacancyById } from '../../shared/content/vacancies'
import { glueChains, ownPeriod, ownRequirements, passesFilters, sectionFacts, usefulFilters, vacancyFilters } from '../../src/components/candidate/vacancyList'

const src = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const page = src('src/pages/Vacancies.tsx')
const row = src('src/components/candidate/VacancyRow.tsx')
const manifest = JSON.parse(src('public/video/manifest.json')) as { videos: { id: string; speech: boolean }[] }

test('порядок разделов: оплачиваемая практика → бесплатная практика → работа', () => {
  const paid = page.indexOf('id="paid"')
  const free = page.indexOf('id="free"')
  const work = page.indexOf('id="work"')
  assert.ok(paid > 0 && paid < free && free < work, 'разделы не в том порядке')
  // Списки разделов — те же роли, пропущенные через быстрые фильтры
  assert.match(page, /const paid = shown\(paidPractice\)/)
  assert.match(page, /const free = shown\(freePractice\)/)
  assert.match(page, /const jobs = shown\(work\)/)
  assert.match(page, /\{paid\.map\(\(v\) => \(\s+<VacancyRow /)
  assert.match(page, /\{free\.map\(\(v\) => \(\s+<FreePracticeRow /)
  assert.match(page, /\{jobs\.map\(\(v\) => \(\s+<VacancyRow /)
  // Каждая вакансия — ровно в одном разделе
  const work_ = vacancies.filter((v) => v.format !== 'Оплачиваемая практика' && v.format !== 'Бесплатная практика')
  assert.equal(paidPractice.length + freePractice.length + work_.length, vacancies.length)
})

test('оплачиваемая практика: «от» нижней границы по ролям, что даёт компания — из shared, над заголовком факты, а не слоган', () => {
  // Одна цифра «от 56 000 ₽»: вилка «56 000–70 000» спорила со строками ролей «от 70 000 ₽»
  assert.match(page, /const practiceFrom = \(\) => `от \$\{rub\(minPracticePay\)\}`/)
  assert.doesNotMatch(page, /paidPracticeInfo\.payTo/)
  assert.match(page, /paidPracticeInfo\.benefits\.map/)
  assert.match(page, /paidPracticeInfo\.period/)
  assert.match(page, /сумма зависит от роли/)
  assert.match(page, /в месяц до вычета налога/)
  // Слоган выбирают в анкете /focus — на странице вакансий он подсказывал бы ответ
  assert.doesNotMatch(page, /Сначала научим/)
})

test('общее для раздела — во вступлении, в строке только своё: срок и требования', () => {
  const paid = sectionFacts(paidPractice)
  assert.equal(paid.period, PRACTICE_PERIOD)
  assert.ok(paid.requirements.length === 1 && /без опыта/.test(paid.requirements[0]), String(paid.requirements))
  for (const v of paidPractice) assert.equal(ownPeriod(v, paid), null, v.id)
  // Оператор технологического цеха: общее убрано, своё осталось
  assert.equal(ownRequirements(vacancyById('fermentation-assistant')!, paid), 'Подходит будущим технологам пищевого производства')
  assert.equal(ownRequirements(vacancyById('bottling-operator')!, paid), '')
  // У лаборанта требования свои — печатаются целиком
  assert.equal(ownRequirements(vacancyById('lab-chemist')!, paid), vacancyById('lab-chemist')!.requirements)
  const free = sectionFacts(freePractice)
  assert.deepEqual(free.requirements, ['Практика от вуза или колледжа'])
  for (const v of freePractice) assert.doesNotMatch(ownRequirements(v, free), /Практика от вуза/, v.id)
  // Вступления печатают общее
  assert.match(page, /paidFacts\.requirements\.join\('\. '\)/)
  assert.match(page, /freeFacts\.requirements\.join\('\. '\)/)
  assert.match(row, /ownPeriod\(vacancy, facts\)/)
  assert.match(row, /ownRequirements\(vacancy, facts\)/)
})

test('быстрые фильтры: только по данным вакансий и только те, что что-то меняют', () => {
  const chips = usefulFilters(vacancies)
  assert.deepEqual(
    chips.map((c) => c.label),
    ['Только дневные', 'Без опыта', 'Практика от вуза', 'Круглый год'],
  )
  for (const c of chips) assert.ok(c.count > 0 && c.count < vacancies.length, c.label)
  const test_ = (id: string) => vacancyFilters.find((f) => f.id === id)!.test
  // Только дневные: где ночей нет или можно выбрать только дневные; ночной цех розлива и бесплатная практика «по договорённости» — нет
  assert.equal(test_('day')(vacancyById('lab-chemist')!), true)
  assert.equal(test_('day')(vacancyById('store-worker')!), true)
  assert.equal(test_('day')(vacancyById('bottling-operator')!), false)
  assert.equal(test_('day')(vacancyById('automation-intern')!), false)
  // Без опыта: опыт от года нужен только мерчандайзеру
  assert.deepEqual(vacancies.filter((v) => !test_('noexp')(v)).map((v) => v.id), ['merchandiser'])
  assert.deepEqual(vacancies.filter(test_('year')).map((v) => v.id).sort(), ['merchandiser', 'store-worker'])
  // Фильтры складываются: «Только дневные» и «Круглый год» — магазин и мерчандайзер
  assert.deepEqual(vacancies.filter((v) => passesFilters(v, ['day', 'year'])).map((v) => v.id).sort(), ['merchandiser', 'store-worker'])
  assert.match(page, /aria-pressed=\{on\}/)
  assert.match(page, /aria-live="polite"/)
})

test('строка роли на телефоне: «Подробнее» раскрывает подробности, ?open раскрывает сразу; цепочка «день — ночь — …» не рвётся', () => {
  assert.match(row, /aria-expanded=\{open\}/)
  assert.match(row, /aria-controls=\{controls\}/)
  assert.match(row, /const \[open, setOpen\] = useState\(highlight\)/)
  assert.match(row, /setOpen\(true\)/)
  assert.match(row, /open \? '' : 'hidden md:block'/)
  assert.equal(glueChains('2/2 по 12 часов, день — ночь — отсыпной — выходной'), '2/2 по 12 часов, день\u00A0—\u00A0ночь\u00A0—\u00A0отсыпной\u00A0—\u00A0выходной')
  // Срок «Март или апрель — июль…» — не цепочка из отдельных слов, переносится как обычно
  assert.equal(glueChains(PRACTICE_PERIOD), PRACTICE_PERIOD)
})

test('фото ролей — только по делу: у склада и мерчандайзера без фото, а не водитель фуры и банки на линии', () => {
  for (const id of ['warehouse-operator', 'storekeeper', 'merchandiser']) assert.match(row, new RegExp(`'?${id}'?: null,`), id)
  assert.doesNotMatch(row, /'driver'|'cans-line'|'line-kvass'/)
})

test('бесплатная практика: задачи, отклик с отметкой «Практика от вуза» — сказано один раз во вступлении, документы и кабинет', () => {
  assert.match(row, /to=\{`\/apply\?vacancy=\$\{vacancy\.id\}&practice=1`\}/)
  assert.match(page, /отклик отсюда ставит в заявке отметку «Практика от вуза»/)
  assert.doesNotMatch(row, /отметк\w* «Практика от вуза»/)
  assert.match(page, /practiceDocs\.map/)
  assert.match(page, /Учебный центр, кабинет\\u00A0\$\{TRAINING_CENTER_ROOM\}/)
})

test('«Посмотреть смену»: ролики компании у цеха розлива и лаборатории, id есть в манифесте, файл не грузится заранее', () => {
  const map = [...row.matchAll(/'([\w-]+)': '([\w-]+)',/g)].filter(([, role]) => vacancyById(role)).map(([, role, video]) => [role, video])
  const videos = map.filter(([, v]) => manifest.videos.some((m) => m.id === v))
  assert.deepEqual(Object.fromEntries(videos), { 'bottling-operator': 'bottling-operator', 'lab-chemist': 'lab-assistant' })
  assert.match(row, /<ShiftVideo id=\{video\}/)
  // preload="none" и подпись о звуке — внутри ShiftVideo (c2-brand-media); проверяем, что они там есть
  const player = src('src/components/ShiftVideo.tsx')
  assert.match(player, /preload="none"/)
  assert.match(player, /soundNote\(v\)/)
})

test('строка роли: сумма до вычета и на руки, график, задачи, кто подходит, «Откликнуться» ведёт в заявку на эту роль', () => {
  for (const part of ['payLabel(vacancy)', 'netPay(vacancy.pay.from)', 'vacancy.schedule', 'vacancy.hours', 'ownPeriod(vacancy, facts)', 'vacancy.tasks', 'ownRequirements(vacancy, facts)', 'to={`/apply?vacancy=${vacancy.id}`}'])
    assert.ok(row.includes(part), `в строке роли нет ${part}`)
  // Ссылка с главной ?open=<id> подсвечивает строку
  assert.match(page, /vacancyById\(params\.get\('open'\) \?\? ''\)/)
})

test('тексты страницы: без «!», дат, «высокой зарплаты» и ДМС', () => {
  for (const text of [page, row]) {
    assert.doesNotMatch(text, /[а-яё»]!(\s|'|`|<|$)/im)
    assert.doesNotMatch(text, /\b(19|20)\d{2}\b/)
    assert.doesNotMatch(text, /высок\w+ зарплат|ДМС|стажировк\w+ с оценочн/i)
  }
})
