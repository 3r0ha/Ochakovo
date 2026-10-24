// Форма заявки: отметка согласия, ответы сервера 409 и 429, ловушка, код приглашения, практика,
// счёт игры по переключателю, срок ответа один раз у кнопки, друг без контакта, портфолио, вакансии.
// Тексты — из src/components/candidate/applyText.ts, форма — по исходнику Apply.tsx (он тянет браузерные модули).
// Поведение в браузере проверяет scripts/e2e/pages-chat.ts. Запуск: pnpm test w1-pages-chat

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { RESPONSE_WORDS, responsePromise } from '../../shared/candidateStatus'
import { vacancies, vacancyById } from '../../shared/content/vacancies'
import { FRIEND_NO_NAME, friendField, friendName, promiseLine, rejectedText, waitText } from '../../src/components/candidate/applyText'
import { asksPortfolio } from '../../src/components/candidate/questionnaire'

const src = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8')
const apply = src('pages/Apply.tsx')

test('ожидание: секунды до двух минут, дальше минуты, с правильными окончаниями', () => {
  assert.equal(waitText(1), '1 секунду')
  assert.equal(waitText(42), '42 секунды')
  assert.equal(waitText(5), '5 секунд')
  assert.equal(waitText(11), '11 секунд')
  assert.equal(waitText(21), '21 секунду')
  assert.equal(waitText(119), '119 секунд')
  assert.equal(waitText(120), '2 минуты')
  assert.equal(waitText(301), '6 минут')
  assert.equal(waitText(3600), '60 минут')
  assert.equal(waitText(Number.NaN), '60 секунд')
})

test('409 и 429 — человеческие тексты, у 429 срок и WhatsApp', () => {
  assert.deepEqual(rejectedText('already_applied'), { text: 'Заявка с этого номера уже принята, с тобой свяжутся.', whatsapp: false })
  assert.deepEqual(rejectedText('rate_limited', 42), { text: 'С этой сети сейчас много заявок. Подожди 42 секунды или напиши в WhatsApp.', whatsapp: true })
  const phone = rejectedText('phone_limit', 1800)
  assert.match(phone.text, /Подожди 30 минут или напиши в WhatsApp\.$/)
  for (const r of [rejectedText('already_applied'), rejectedText('rate_limited', 5), phone]) assert.doesNotMatch(r.text, /!/)
})

test('api.ts превращает 409 и 429 в ApplyRejected с причиной и сроком', () => {
  const api = src('lib/api.ts')
  assert.match(api, /e\.status === 409\) throw new ApplyRejected\('already_applied'\)/)
  assert.match(api, /e\.status === 429\) throw new ApplyRejected\(e\.data\.error === 'phone_limit' \? 'phone_limit' : 'rate_limited', e\.retryAfter/)
  assert.match(api, /res\.headers\.get\('retry-after'\)/)
})

test('срок ответа — из responsePromise, на форме один раз и у кнопки', () => {
  assert.equal(promiseLine(false), `${responsePromise('call')}.`)
  assert.equal(promiseLine(true), `${responsePromise('message')}.`)
  assert.ok(promiseLine(false).includes(RESPONSE_WORDS))
  // В форме promiseLine стоит один раз — сразу после кнопки отправки; второй — на экране «Заявка отправлена»
  const form = apply.slice(apply.indexOf('<form ref={formRef}'), apply.indexOf('</form>'))
  assert.equal(form.split('promiseLine(').length - 1, 1, 'в форме срок ответа повторяется')
  assert.ok(form.indexOf('promiseLine(') > form.indexOf('type="submit"'), 'срок ответа не у кнопки')
  // Ни в одном файле пакета срок не написан вручную
  for (const f of ['pages/Apply.tsx', 'components/candidate/NextSteps.tsx', 'components/chat/ChatPanel.tsx'])
    assert.doesNotMatch(src(f), /двух рабочих дней/, `${f}: срок ответа написан вручную`)
})

test('согласие — отдельная обязательная отметка с версией текста; возраст — по дате рождения, без отметки «18 лет»', () => {
  assert.doesNotMatch(apply, /id="apply-adult"/, 'отметка «Мне есть 18 лет» вернулась: возраст проверяется по дате рождения')
  assert.doesNotMatch(apply, /adult: true/)
  assert.match(apply, /<Checkbox id="apply-consent" required/)
  assert.match(apply, /if \(!f\.consent\) e\.consent = /)
  assert.match(apply, /consent: true,\s+consentVersion: CONSENT_VERSION,/)
  assert.match(apply, /href="\/consent"/)
  // Политика — отдельной строкой после отметки согласия, не внутри неё
  const consentBox = apply.slice(apply.indexOf('<Checkbox id="apply-consent"'), apply.indexOf('</Checkbox>', apply.indexOf('<Checkbox id="apply-consent"')))
  assert.match(consentBox, /href="\/consent"/)
  assert.doesNotMatch(consentBox, /href="\/privacy"/)
  assert.match(apply, /<\/Checkbox>\s+\{\/\*[^*]+\*\/\}\s+<p[^>]*>\s+\{nb\('Кто видит заявку[^']*'\)\}\s+<a href="\/privacy"/)
  // Ошибка согласия от сервера (текст обновился) показывается у отметки
  assert.match(apply, /consent: err\.errors\.consent \|\| undefined/)
})

test('ловушка website: скрыта от людей и скринридера, вне Tab, уходит с заявкой', () => {
  assert.match(apply, /<div aria-hidden="true" className="pointer-events-none absolute -left-\[9999px\]/)
  assert.match(apply, /id="apply-website"[\s\S]{0,80}name="website"[\s\S]{0,80}tabIndex=\{-1\}/)
  assert.match(apply, /website: form\.website,/)
})

test('приглашение: код браузера уходит с заявкой, своя метка не отправляется, «Иду с другом» отмечено по ссылке', () => {
  assert.match(apply, /refCode: myRefCode\(\),/)
  assert.match(apply, /source: ownLink \? null : profile\.source,/)
  assert.match(apply, /withFriend: invited \|\| params\.get\('friend'\) === '1',/)
  assert.match(apply, /по приглашению/)
  assert.match(apply, /inviteUrl\('\/'\)/)
  assert.doesNotMatch(apply, /src=friend`/, 'старая ссылка ?src=friend без кода')
  assert.doesNotMatch(apply, /бонус/i)
})

test('друг: только имя, без контакта; без имени — «имя не указано», как в боте', () => {
  assert.match(apply, /label="Имя друга"/)
  assert.doesNotMatch(apply, /телефон или ник друга|@anya/i)
  assert.equal(friendField(false, 'Аня'), '')
  assert.equal(friendField(true, '  Аня '), 'Аня')
  assert.equal(friendField(true, ''), FRIEND_NO_NAME)
  assert.equal(FRIEND_NO_NAME, 'имя не указано')
  assert.equal(friendName(FRIEND_NO_NAME), '')
  assert.equal(friendName('Аня'), 'Аня')
  // Так же пишет бот
  const bot = readFileSync(new URL('../../server/dialog/flows/apply.ts', import.meta.url), 'utf8')
  assert.match(bot, new RegExp(`FRIEND_NO_NAME = '${FRIEND_NO_NAME}'`))
})

test('практика от вуза — рядом с учёбой, «остаться после сезона» — в свёрнутом «Необязательно», счёт игры по переключателю', () => {
  assert.match(apply, /Практика от вуза или колледжа: нужны договор, дневник и характеристика\. HR скажет, получится ли/)
  assert.match(apply, /Хочу остаться после сезона/)
  assert.match(apply, /practiceSchool: !form\.notStudying && form\.practiceSchool,\s+wantsToStay: form\.wantsToStay,/)
  // Практика — в основной части формы, сразу после учёбы; «остаться» — свёрнуто в «Необязательно»
  // Свёрнутый блок «Необязательно»: от <Disclosure с id="apply-more" до закрывающего тега
  const moreAt = apply.indexOf('id="apply-more"')
  assert.ok(moreAt > 0 && apply.lastIndexOf('<Disclosure', moreAt) > 0, 'нет блока apply-more')
  const more = apply.slice(apply.lastIndexOf('<Disclosure', moreAt), apply.indexOf('</Disclosure>', moreAt))
  assert.ok(more.includes('id="apply-stay"'), '«остаться» не в «Необязательно»')
  assert.ok(!more.includes('id="apply-practice"') && !more.includes('id="apply-school"'), 'учёба и практика спрятаны в «Необязательно»')
  assert.ok(apply.indexOf('id="apply-practice"') > apply.indexOf('id="apply-school"'), 'практика не рядом с учёбой')
  assert.match(apply, /Показать результат игры/)
  assert.match(apply, /conveyorBest: profile\.attachScore \? profile\.conveyorBest : 0,/)
})

test('портфолио: только у практики в офисе — правило общее с ботом', () => {
  // Без портфолио — практика на линии розлива; с портфолио — только офис (маскоты, ролики, курс)
  assert.equal(asksPortfolio('production', 'bottling-operator'), false)
  const office = vacancies.filter((x) => x.department === 'office')
  assert.ok(office.length > 0, 'нет вакансий в офисе')
  for (const v of vacancies) assert.equal(asksPortfolio(v.department, v.id), v.department === 'office', v.id)
  assert.equal(asksPortfolio('office', ''), true)
  assert.equal(asksPortfolio('production', ''), false)
  assert.ok(vacancyById('marketing-intern'))
})

test('вакансии: сноска — estimateNote, «Срочный набор» только у суммы с hh.ru, маршрут — из contacts', () => {
  const page = src('pages/Vacancies.tsx')
  const row = src('components/candidate/VacancyRow.tsx')
  assert.match(page, /\{nb\(estimateNote\)\}/)
  assert.match(page, /contacts\.routeShort/)
  assert.match(row, /const hot = Boolean\(vacancy\.hot && vacancy\.pay && !vacancy\.pay\.estimate\)/)
  assert.doesNotMatch(row, /vacancy\.hot &&\s*</)
})
