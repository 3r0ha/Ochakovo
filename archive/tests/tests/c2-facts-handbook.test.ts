// Условия и быт по «Справочнику студента» «Очаково» (archive/case-materials/handbook-text.txt):
// дорога с корпоративным автобусом, общежитие, столовая, спецодежда и прачечная, зарплата, экзамены, наставник,
// документы по практике, пропуск, здравпункт, телефоны с добавочными. Тексты FAQ — короткие и прямые.
// Запуск: pnpm test c2-facts-handbook (без базы)

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { contacts, phonebook, phoneLine } from '../../shared/content/content'
import { faq, faqAnswer, type FaqId } from '../../shared/content/faq'
import { canteen, dorm, handbook, handbookText, PASS_FINE, PAY_DAYS, practiceDocs, SEASON, TRAINING_CENTER_ROOM, workPrinciples } from '../../shared/content/handbook'

const root = join(import.meta.dirname, '..', '..')
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')
const handbookSource = read('archive/case-materials/handbook-text.txt')
const handbookTs = read('shared/content/handbook.ts')

/** Справочник после сжатия пробелов — для проверки, что цифры взяты оттуда */
const hb = handbookSource.replace(/\s+/g, ' ')

test('цифры справочника совпадают с документом', () => {
  assert.equal(dorm.priceStudent, 3400)
  assert.equal(dorm.priceOther, 6800)
  assert.match(hb, /Для студентов стоимость 3400 за койко-место\. Для остальных - 6800/)
  assert.equal(dorm.address, 'Москва, ул. Рябиновая, 36, к. 2')
  assert.match(hb, /Рябиновая, 36, к 2/)
  assert.deepEqual([...PAY_DAYS], [12, 27])
  assert.match(hb, /\(12 и 27 числа\)/)
  assert.equal(PASS_FINE, 500)
  assert.match(hb, /штраф 500р/)
  assert.equal(TRAINING_CENTER_ROOM, 525)
  assert.match(hb, /Учебный Центр \(525\)/)
  assert.equal(canteen.lunch, 'по будням с 11:30 до 14:30')
  assert.match(hb, /в будние дни с 11:30 до 14:30/)
  assert.equal(canteen.dinner, 'каждый день с 20:30 до 22:00')
  assert.match(hb, /каждый день с 20:30 до 22:00/)
  assert.deepEqual({ from: SEASON.from, to: SEASON.to }, { from: 3, to: 9 })
  assert.match(hb, /сезона \(март-сентябрь\)/)
  assert.deepEqual([...workPrinciples], ['добросовестность', 'честность', 'ориентация на результат'])
  assert.deepEqual(practiceDocs.map((d) => d.id), ['contract', 'order', 'diary', 'reference'])
})

test('справочник покрывает темы кейса, тексты короткие, без «!» и мужского рода', () => {
  const ids = handbook.map((h) => h.id)
  for (const id of ['mentor', 'probation', 'contract', 'practice-docs', 'dorm', 'canteen', 'clothes', 'payday', 'exams', 'schedule', 'pass', 'health', 'safety', 'season'])
    assert.ok(ids.includes(id as never), id)
  assert.equal(new Set(ids).size, ids.length)
  for (const h of handbook) {
    assert.ok(h.text.length > 30 && h.text.length < 420, `${h.id}: ${h.text.length} символов`)
    assert.ok(!h.text.includes('!'), h.id)
    assert.ok(!/\b(потерял|заболел|готов|согласен|свободен|должен)\b/i.test(`${h.title} ${h.text}`), `род в ${h.id}`)
    assert.equal(handbookText(h.id), h.text)
  }
  const t = (id: Parameters<typeof handbookText>[0]) => handbookText(id)
  assert.match(t('mentor'), /К каждому новичку прикрепляют наставника.*Учебном центре/)
  assert.match(t('probation'), /У студентов испытательного срока нет, вместо него идёт производственная практика/)
  assert.match(t('contract'), /срочный трудовой договор.*трудовая книжка электронная.*перевестись на постоянную работу/s)
  assert.match(t('practice-docs'), /Договор от вуза или колледжа.*приказ.*дневник или отчёт.*характеристику.*кабинет 525/s)
  assert.match(t('dorm'), /Койко-место для студентов стоит 3 400 ₽, половину оплачивает компания.*6 800 ₽.*от 4 до 6 человек.*с 23:00 до 6:00/s)
  assert.match(t('canteen'), /Половину стоимости компенсирует компания/)
  assert.match(t('clothes'), /Спецодежду и обувь выдают.*медосмотр оплачивает компания.*с 8:30 до 16:30.*1–2 дня/s)
  assert.match(t('payday'), /12-го и 27-го.*сверх нормы отдельно.*ночные смены по повышенному коэффициенту/s)
  assert.match(t('exams'), /смены на это время не поставят.*на территории предприятия.*за две недели/s)
  assert.match(t('schedule'), /График составляет руководитель/)
  assert.match(t('pass'), /отдел кадров.*штраф 500 ₽/s)
  assert.match(t('health'), /здравпункт.*круглосуточно.*1370 или 1303/s)
})

test('у каждой темы справочника — цитата документа в комментарии', () => {
  for (const quote of [
    '«Ко всем новым сотрудникам прикрепляется наставник',
    '«Существует ли испытательный срок для студентов? НЕТ',
    '«Для студентов стоимость 3400 за койко-место',
    '«Половину стоимости питания компенсирует компания',
    '«Прачечная работает в будни с 8:30 до 16:30',
    '(12 и 27 числа)',
    '«Графики работы составляет руководитель',
    'штраф 500р',
    '«Здравпункт работает круглосуточно»',
    '«Все сотрудники Очаково проходят инструктаж по охране труда',
  ])
    assert.ok(handbookTs.includes(quote), `нет цитаты: ${quote}`)
})

test('телефоны и добавочные — как в справочнике', () => {
  const byId = Object.fromEntries(phonebook.map((p) => [p.id, p]))
  assert.equal(byId.recruiting.ext, 'доб. 1155, 3105, 2107')
  assert.equal(byId.recruiting.mobile, '8 903 591-00-13')
  assert.equal(byId.training.ext, 'доб. 1244 или 3105')
  assert.match(byId.training.note ?? '', /525/)
  assert.equal(byId.personnel.ext, 'доб. 1234')
  assert.equal(byId.medical.ext, 'доб. 1370 или 1303')
  assert.equal(byId.medical.note, 'круглосуточно')
  assert.equal(byId.security.ext, 'доб. 1490')
  assert.equal(byId.dorm.phone, '8 495 446-42-55')
  for (const p of phonebook) if (p.phone === contacts.phone) assert.equal(p.phone, '8 800 100-77-77')
  assert.match(hb, /8 800 100 77 77 \(доб 1155, 3105, 2107\)/)
  assert.match(hb, /\(доб 1244 ИЛИ 3105\)/)
  assert.match(hb, /84954464255/)
  assert.equal(phoneLine(byId.training), 'Учебный центр: 8 800 100-77-77, доб. 1244 или 3105, или 8 903 591-00-13')
})

test('FAQ: прямые ответы по справочнику на новые вопросы', () => {
  const NEW: FaqId[] = ['free-practice', 'mentor', 'probation', 'practice-docs', 'payday', 'canteen', 'schedule', 'pass', 'health']
  for (const id of NEW) assert.ok(faqAnswer(id).length > 20, `пустой ответ: ${id}`)
  assert.ok(faqAnswer('probation').startsWith('У студентов испытательного срока нет'))
  assert.ok(faqAnswer('payday').startsWith('Зарплату платят два раза в месяц, 12-го и 27-го'))
  assert.ok(faqAnswer('canteen').startsWith('Обед в столовой по будням с 11:30 до 14:30'))
  assert.ok(faqAnswer('practice-docs').includes('кабинет 525'))
  assert.ok(faqAnswer('mentor').startsWith('К каждому новичку прикрепляют наставника'))
  assert.match(faqAnswer('free-practice'), /^Практика без оплаты в разных отделах по договорённости/)
  assert.match(faqAnswer('study'), /^Да, о зачёте или экзамене предупреди руководителя заранее/)
  assert.match(faqAnswer('clothes'), /^Нет, спецодежду и обувь выдают/)
  assert.match(faqAnswer('contacts'), /^До приезда позвони в отдел подбора: 8 800 100-77-77, доб\. 1155, 3105, 2107, или 8 903 591-00-13/)
  assert.match(faqAnswer('contacts'), /Учебный центр: 8 800 100-77-77, доб\. 1244 или 3105/)
  assert.match(faqAnswer('experience'), /наставник/)
  // Вопросы без мужского рода: «пропуск потерялся», «плохо себя чувствуешь»
  for (const f of faq) assert.doesNotMatch(f.q, /потерял(?!ся)|заболел/, f.q)
})
