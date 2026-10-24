// Разбор текста внутри заявки в боте: вопрос или ответ шага, имя, отказ от телефона, 18+, «хочу откликнуться».
// Запуск: pnpm test w1-bot-intent

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { asName, looksLikeQuestion, parseAdult, refusesPhone, stripNameIntro, wantsToApply } from '../../server/dialog/intent'

test('вопросы на шаге имени — не имена', () => {
  for (const q of [
    'а сколько платят?',
    'а сколько платят',
    'сколько платят',
    'где завод',
    'можно без опыта',
    'зарплата какая',
    'зп белая',
    'есть общежитие',
    'когда позвонят',
    'хочу на склад',
    'я учусь на технолога и хочу работать летом',
    'подскажи график',
    'График',
  ]) {
    assert.equal(looksLikeQuestion(q), true, q)
  }
})

test('имена — не вопросы и сохраняются как имена', () => {
  for (const [typed, name] of [
    ['Анна-Мария', 'Анна-Мария'],
    ['Иванов Иван Иванович', 'Иванов Иван Иванович'],
    ['меня зовут Аня', 'Аня'],
    ['Меня зовут Аня.', 'Аня'],
    ['я Даня', 'Даня'],
    ['это Оля', 'Оля'],
    ['аня', 'Аня'],
    ['анна-мария', 'Анна-Мария'],
    ['Платон', 'Платон'],
    ['Вера', 'Вера'],
    ["Д'Артаньян", "Д'Артаньян"],
    ['John Smith', 'John Smith'],
  ] as const) {
    assert.equal(looksLikeQuestion(typed), false, `вопрос: ${typed}`)
    assert.equal(asName(typed), name, typed)
  }
  assert.equal(stripNameIntro('меня зовут Аня'), 'Аня')
})

test('не имя: цифры, ник, ссылка, один знак', () => {
  for (const bad of ['89161234567', '@anya', 'https://vk.com/anya', 'А', '', 'Аня 19 лет']) assert.equal(asName(bad), null, bad)
})

test('строгий режим для свободного текста: только «?» и вопросительное слово в начале', () => {
  assert.equal(looksLikeQuestion('мои работы в телеграме', true), false)
  assert.equal(looksLikeQuestion('а зачем портфолио', true), true)
  assert.equal(looksLikeQuestion('портфолио обязательно?', true), true)
})

test('«хочу откликнуться» и похожие открывают заявку, «моя заявка» и вопросы — нет', () => {
  for (const t of ['хочу откликнуться', 'Хочу откликнуться!', 'оставить заявку', 'где заявку оставить', 'как оставить заявку', 'запиши меня', 'хочу подать заявку']) {
    assert.equal(wantsToApply(t), true, t)
  }
  for (const t of ['моя заявка', 'что с моей заявкой', 'я оставил заявку', 'сколько платят', 'откликнулся вчера']) assert.equal(wantsToApply(t), false, t)
})

test('отказ от телефона', () => {
  for (const t of ['можно без телефона?', 'без номера можно', 'не хочу давать номер', 'не хочу телефон', 'номер не дам', 'нет телефона']) assert.equal(refusesPhone(t), true, t)
  for (const t of ['+7 916 123-45-67', '@kvas_fan', 'телефон рабочий']) assert.equal(refusesPhone(t), false, t)
})

test('ответ на «Тебе есть 18?»', () => {
  for (const t of ['да', 'Да', 'да, есть', 'есть', 'конечно', 'мне 19', '18', 'мне уже 20 лет', '25 лет']) assert.equal(parseAdult(t), 'yes', t)
  for (const t of ['нет', 'нету', 'ещё нет', 'пока нет', 'мне 17', '16', '17 лет']) assert.equal(parseAdult(t), 'no', t)
  for (const t of ['Даня', 'сколько платят?', 'а что если 17?']) assert.equal(parseAdult(t), null, t)
})
