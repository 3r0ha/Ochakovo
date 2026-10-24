// Факты о компании по источнику, вопросы FAQ и срок ответа HR из одного места.
// Источники — официальные материалы «Очаково» (archive/case-materials: «Справочник студента», «Описание практики»,
// каталог продукции), ochakovo.ru. Решения docs/case-delta.md: корпоративный автобус от м. «Озёрная» есть,
// общежитие 3 400 ₽ для студентов, медосмотр и спецодежда за счёт компании, ДМС не обещаем.
// Запуск: pnpm test w1-content-facts (без базы)

import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { RESPONSE_WORDS, RESPONSE_WORKDAYS, responsePromise } from '../../shared/candidateStatus'
import { contacts, myths, perks, RESPONSE_WORKDAYS as CONTENT_WORKDAYS, steps } from '../../shared/content/content'
import { faq, faqAnswer, type FaqId } from '../../shared/content/faq'
import { PLANT_BOTTLES_PER_HOUR, stages } from '../../shared/content/production'
import { vacancies } from '../../shared/content/vacancies'
import { toHhVacancy } from '../../shared/hhVacancy'

const root = join(import.meta.dirname, '..', '..')

/** Все текстовые файлы папки, рекурсивно */
function filesIn(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const rel = join(dir, name)
    return statSync(join(root, rel)).isDirectory() ? filesIn(rel) : /\.(ts|tsx|json|md)$/.test(name) ? [rel] : []
  })
}
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')

/** Предложения в тексте: точки после сокращений («ст. 80», «м. «Озёрная»», «ул. Рябиновая», «к. 2») концом не считаются */
const sentences = (text: string) =>
  text
    .replace(/(^|[\s(«])(ст|м|ул|д|доб|г|к|т\. ?е|т\. ?д)\.(?=\s)/gi, '$1$2')
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)

const CASE_IDS: FaqId[] = ['practice', 'after-season', 'first-shift', 'medbook', 'clothes', 'study', 'interview-bring', 'quit']

test('в контенте нет фактов без источника: ДМС за счёт компании, «дают общежитие», «первые в СССР», 107 000 и ориентиры', () => {
  const banned = [/ДМС[^.]{0,40}за\s+сч[её]т\s+компании/i, /за\s+сч[её]т\s+компании[^.]{0,40}ДМС/i, /дают\s+общежитие/i, /его\s+дают/i, /первые\s+в\s+СССР/i, /107\s?000/]
  const hits: string[] = []
  for (const file of filesIn('shared/content')) {
    const text = read(file)
    for (const re of banned) if (re.test(text)) hits.push(`${file}: ${re}`)
  }
  assert.deepEqual(hits, [])
  for (const v of vacancies) assert.ok(!v.pay?.estimate, `выдуманный ориентир у ${v.id}`)
})

test('дорога — корпоративный автобус от «Озёрной» по справочнику студента, городские маршруты и электричка', () => {
  const r = contacts.route
  assert.ok(r.startsWith('От м. «Озёрная» ходит корпоративный автобус'), r)
  for (const part of ['610', '807', '«Рябиновая, 65»', '«Кунцевская»', '275', '«Говорово»', '259', '221', '«Рабочий посёлок»', '«Пищекомбинат»', 'Мещерская', '15 минут пешком'])
    assert.ok(r.includes(part), `в маршруте нет «${part}»: ${r}`)
  assert.ok(!/622/.test(r + contacts.routeShort + contacts.shuttle))
  assert.equal(contacts.address, 'Москва, ул. Рябиновая, 44')
  assert.equal(contacts.routeShort, 'Корпоративный автобус от м. «Озёрная»')
  assert.equal(contacts.shuttle, 'От м. «Озёрная» до завода ходит корпоративный автобус.')
  // Без «расписание скажет HR» в самом факте и без ссылки на hh.ru вместо справочника
  assert.doesNotMatch(contacts.shuttle, /вакансиях|hh\.ru/)
})

test('условия — по «Описанию практики» и справочнику: без ДМС, общежитие с ценой, медосмотр и спецодежда за счёт компании', () => {
  const all = perks.map((p) => `${p.title} ${p.text}`).join(' ')
  assert.doesNotMatch(all, /ДМС/)
  const dorm = perks.find((p) => /общежит/i.test(p.title))!
  assert.match(dorm.text, /Койко-место для студентов стоит 3 400 ₽, половину оплачивает компания/)
  assert.match(dorm.text, /6 800 ₽/)
  assert.match(dorm.text, /Рябиновая, 36, к\. 2/)
  assert.ok(perks.some((p) => /медосмотр оплачивает компания/.test(p.text)))
  assert.ok(perks.some((p) => /Наставник/.test(p.title)))
  assert.ok(perks.some((p) => /Без испытательного срока/.test(p.title)))
  assert.ok(perks.some((p) => /12-го и 27-го/.test(p.title)))
  assert.ok(faqAnswer('dorm').startsWith('В общежитии компании: ул. Рябиновая, 36, к. 2, рядом с заводом'))
  const where = faqAnswer('where')
  assert.ok(where.startsWith(contacts.address) && where.includes(contacts.route), where)

  const pepsi = myths.find((m) => m.id === 'pepsi-fanta')!
  assert.ok(pepsi.explain.includes('По словам компании, больше такого не было нигде в мире'), pepsi.explain)
  const malt = stages.find((s) => s.id === 'malt')!
  assert.ok(!/ячмен/i.test(malt.text), 'ячмень на сайте «Очаково» — для пива, в квас его не пишем')
  assert.match(malt.text, /Рожь и пшеницу для кваса.*солодовне/)
  const bottling = stages.find((s) => s.id === 'bottling')!
  assert.ok(bottling.text.startsWith('Все линии завода вместе выпускают до 70 000 бутылок напитков в час'), bottling.text)
  assert.equal(PLANT_BOTTLES_PER_HOUR, 70_000)
  assert.notEqual(stages.find((s) => s.id === 'warehouse')!.photo, 'silos')
})

test('у автобуса, условий и истории — комментарий с источником', () => {
  const src = read('shared/content/content.ts')
  const near = (marker: string, source: RegExp) => {
    const i = src.indexOf(marker)
    assert.ok(i > 0, `нет «${marker}»`)
    assert.match(src.slice(Math.max(0, i - 1200), i), source, `перед «${marker}» нет комментария с источником`)
  }
  near("shuttle: '", /[Сс]правочник студента: «от м \.Озёрная ходит корпоративный автобус»/)
  near('route:', /ochakovo\.ru\/kontakty.*«610, 622, 807/s)
  near('export const perks', /«Описание практики»: «Официальное трудоустройство по ТК РФ.*50% оплаты за общежитие/s)
  near("explain: 'В 1979 году", /ochakovo\.ru\/istoriya.*«Это единственный в мире прецедент/s)
  assert.match(read('shared/content/production.ts'), /ochakovo\.ru\/istoriya\/: «Сейчас завод производит 70 000 бутылок напитков в час»/)
})

test('вакансия для hh.ru несёт маршрут с корпоративным автобусом', () => {
  for (const v of vacancies) {
    const d = toHhVacancy(v).payload.description
    assert.ok(d.includes('Как добраться: от м. «Озёрная» ходит корпоративный автобус'), d)
    assert.ok(d.includes('Мещерская') && d.includes('Рябиновая, 44'))
  }
})

test('вопросы кейса: ответ по id, не длиннее двух предложений, без «!», дат и мужского рода', () => {
  for (const id of CASE_IDS) {
    const a = faqAnswer(id)
    assert.ok(a.length > 20, `пустой ответ у ${id}`)
    assert.equal(a, faq.find((f) => f.id === id)?.a)
    assert.ok(sentences(a).length <= 2, `${id}: ${sentences(a).length} предложения — ${a}`)
  }
  assert.equal(new Set(faq.map((f) => f.id)).size, faq.length, 'id вопросов не повторяются')

  for (const f of faq) {
    const all = `${f.q} ${f.a}`
    assert.ok(f.a.trim(), `пустой ответ: ${f.id}`)
    assert.ok(!all.includes('!'), `«!» в ${f.id}`)
    assert.ok(!all.includes('...') && !all.includes('…'), `многоточие в ${f.id}`)
    assert.ok(!/\b(19|20)\d{2}\b|\d{1,2}\.\d{1,2}\.\d{2,4}/.test(all), `дата в ${f.id}`)
    // Маршрут — список дорог, ему можно больше
    if (f.id !== 'where') assert.ok(sentences(f.a).length <= 3, `${f.id}: длиннее трёх предложений`)
    // Нейтральный род к собеседнику
    assert.ok(!/\b(готов|согласен|поймал|прош[её]л|устал|потерял|заболел|свободен)\b/i.test(all), `род в ${f.id}: ${all}`)
  }
})

test('ответы кейса: практика по отделам, переход на постоянную работу, первая смена, увольнение по ТК одним предложением', () => {
  const practice = faqAnswer('practice')
  for (const unit of ['цехе розлива', 'технологическом цехе', 'лаборатории', 'складе']) assert.ok(practice.includes(unit), unit)
  assert.ok(practice.startsWith('Да. Оплачиваемая практика'), practice)
  assert.match(practice, /от 56 000 до 70 000 ₽/)
  assert.match(practice, /бесплатная практика по договорённости/)

  const stay = faqAnswer('after-season')
  assert.match(stay, /можно перевестись на постоянную работу/)
  assert.ok(!/гарантир|обязательно возьм|точно возьм/i.test(stay))

  const first = faqAnswer('first-shift')
  for (const part of ['медосмотр за счёт компании', 'договор', 'инструктаж по охране труда', 'наставник', 'столовой', 'половину стоимости'])
    assert.ok(first.includes(part), part)

  const quit = faqAnswer('quit')
  assert.equal(sentences(quit).length, 1, quit)
  // У практики срочный трудовой договор: ст. 80 — две недели, ст. 292 — до двух месяцев; сезонной работы (ст. 296) в материалах нет
  for (const part of ['ст. 80', 'ст. 292']) assert.ok(quit.includes(part), part)
  assert.doesNotMatch(quit, /296|сезонн/)
  assert.doesNotMatch(quit, /испытательн/, 'у студентов испытательного срока нет')
})

test('первые восемь вопросов — то, что нужно до заявки', () => {
  const first8 = faq.slice(0, 8).map((f) => f.id)
  assert.equal(first8[0], 'pay')
  for (const id of ['experience', 'where', 'practice', 'first-shift', 'age', 'dorm'] as FaqId[]) assert.ok(first8.includes(id), id)
  // Старые тексты вопросов на месте: по ним ищут ответы помощник и бот
  const q = (id: FaqId) => faq.find((f) => f.id === id)?.q
  assert.equal(q('where'), 'Где завод')
  assert.equal(q('age'), 'Со скольки лет')
  assert.equal(q('friend'), 'Можно устроиться вместе с другом')
  assert.equal(q('practice'), 'Можно пройти практику от вуза')
})

test('срок ответа HR — из одного места', () => {
  assert.equal(RESPONSE_WORKDAYS, CONTENT_WORKDAYS)
  assert.equal(RESPONSE_WORDS, 'двух рабочих дней')
  assert.equal(responsePromise('call'), 'HR позвонит в течение двух рабочих дней')
  assert.equal(responsePromise('message'), 'HR напишет в мессенджер в течение двух рабочих дней')
  assert.equal(steps[1].time, `до ${RESPONSE_WORKDAYS} рабочих дней`)

  // Фраза «двух рабочих» живёт только в candidateStatus.ts — среди файлов контента и документов
  const own = [...filesIn('shared'), 'README.md', ...readdirSync(join(root, 'docs')).filter((f) => f.endsWith('.md') && !['plan.md', 'case-delta.md'].includes(f)).map((f) => `docs/${f}`)]
  const hits = own.filter((f) => /двух\s+рабочих/.test(read(f)))
  assert.deepEqual(hits, ['shared/candidateStatus.ts'])
})
