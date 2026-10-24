// Форма заявки по кейсу (w2-pc-c1): ФИО, дата рождения с 18 лет, контакт, вакансия, когда можно выйти, вуз или колледж.
// Проверка полей — та же, что на сервере и в боте (checkApplication); тексты и маска — src/components/candidate/applyText.ts.
// Поведение в браузере — scripts/e2e/pages-chat.ts. Запуск: pnpm test w2-pages-chat

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { caseFieldMessages, startReadyOptions } from '../../shared/applications'
import { birthDateMessages, mskToday } from '../../shared/birthDate'
import { birthDateForSend, caseFieldErrors, inviteOffer, serverBirthDateError, typeBirthDate, type CaseFields } from '../../src/components/candidate/applyText'

const apply = readFileSync(new URL('../../src/pages/Apply.tsx', import.meta.url), 'utf8')

/** Дата рождения ДД.ММ.ГГГГ: столько-то лет назад от текущего момента, плюс сдвиг в днях */
/** Дата рождения «years лет и days дней назад» по московскому календарю — тем же, по которому сервер считает возраст */
function bornAgo(years: number, days = 0, now = Date.now()) {
  const [y, m, day] = mskToday(now).split('-').map(Number)
  const d = new Date(Date.UTC(y - years, m - 1, day + days))
  return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`
}

/** Год рождения двадцатилетнего — от текущего момента, чтобы в проверках не было записанных дат */
const Y = String(new Date().getFullYear() - 20)

const ok: CaseFields = { lastName: 'Иванова', birthDate: bornAgo(20), school: 'МГУПП', notStudying: false, startReady: 'now', startMonth: null }

test('заполненные поля кейса — без ошибок', () => {
  assert.deepEqual(caseFieldErrors(ok), { errors: {}, underage: false })
})

test('обязательные: фамилия, дата рождения, вуз или колледж, когда можно выйти — тексты общие с сервером', () => {
  const { errors } = caseFieldErrors({ lastName: ' ', birthDate: '', school: '', notStudying: false, startReady: '', startMonth: null })
  assert.equal(errors.lastName, caseFieldMessages.lastName)
  assert.equal(errors.birthDate, birthDateMessages.required)
  assert.equal(errors.school, caseFieldMessages.school)
  assert.equal(errors.startReady, caseFieldMessages.startReady)
})

test('«Уже не учусь» снимает обязательность вуза; «С определённого месяца» требует месяц', () => {
  assert.equal(caseFieldErrors({ ...ok, school: '', notStudying: true }).errors.school, undefined)
  // Одна буква вместо названия — не «укажи вуз», а «название целиком»: человек уже что-то написал
  assert.equal(caseFieldErrors({ ...ok, school: 'М' }).errors.school, caseFieldMessages.schoolShort)
  assert.match(caseFieldMessages.school, /^Укажи /)
  assert.match(caseFieldMessages.schoolShort, /^Укажи /)
  assert.equal(caseFieldErrors({ ...ok, startReady: 'month' }).errors.startMonth, caseFieldMessages.startMonth)
  assert.equal(caseFieldErrors({ ...ok, startReady: 'month', startMonth: 7 }).errors.startMonth, undefined)
  assert.deepEqual(
    startReadyOptions.map((o) => o.label),
    ['Сразу', 'Через 1–2 недели', 'После сессии', 'С определённого месяца'],
  )
})

test('дата рождения: моложе 18 — «Берём с 18 лет», ровно 18 сегодня — можно, опечатки — понятным текстом', () => {
  const young = caseFieldErrors({ ...ok, birthDate: bornAgo(18, 1) })
  assert.equal(young.underage, true)
  assert.equal(young.errors.birthDate, birthDateMessages.underage)
  assert.match(young.errors.birthDate!, /^Берём с 18 лет/)
  assert.deepEqual(caseFieldErrors({ ...ok, birthDate: bornAgo(18) }).errors, {})
  assert.equal(caseFieldErrors({ ...ok, birthDate: `31.02.${Y}` }).errors.birthDate, birthDateMessages.impossible)
  assert.equal(caseFieldErrors({ ...ok, birthDate: '05.03' }).errors.birthDate, birthDateMessages.format)
  assert.equal(caseFieldErrors({ ...ok, birthDate: bornAgo(-1) }).errors.birthDate, birthDateMessages.future)
  assert.equal(caseFieldErrors({ ...ok, birthDate: bornAgo(80) }).errors.birthDate, birthDateMessages.tooOld)
})

test('маска даты: цифры раскладываются в ДД.ММ.ГГГГ, ГГГГ-ММ-ДД из автозаполнения переводится, лишнее отрезается', () => {
  assert.equal(typeBirthDate('0503'), '05.03')
  assert.equal(typeBirthDate(`0503${Y}`), `05.03.${Y}`)
  assert.equal(typeBirthDate(`0503${Y}1`), `05.03.${Y}`)
  assert.equal(typeBirthDate('5.3.'), '5.3.')
  assert.equal(typeBirthDate(`${Y}-03-05`), `05.03.${Y}`)
  assert.equal(typeBirthDate('05.0a3'), '05.03')
  assert.equal(birthDateForSend(`05.03.${Y}`), `${Y}-03-05`)
  assert.equal(birthDateForSend(`5.3.${Y}`), `${Y}-03-05`)
  // Нечитаемую дату отправляем как есть: сервер ответит тем же текстом ошибки, что и форма
  assert.equal(birthDateForSend(' 05.03 '), '05.03')
})

test('ответ сервера 422: underage — «Берём с 18 лет», иначе текст сервера', () => {
  assert.equal(serverBirthDateError('что угодно', 'underage'), birthDateMessages.underage)
  assert.equal(serverBirthDateError(birthDateMessages.impossible, 'bad_birth_date'), birthDateMessages.impossible)
  assert.equal(serverBirthDateError(undefined, 'bad_birth_date'), birthDateMessages.format)
  assert.equal(serverBirthDateError(undefined, undefined), undefined)
  assert.match(apply, /birthDate: serverBirthDateError\(err\.errors\.birthDate, err\.codes\.birthDate\),/)
  const api = readFileSync(new URL('../../src/lib/api.ts', import.meta.url), 'utf8')
  assert.match(api, /new ApiValidationError\(data\.errors \?\? \{\}, data\.message, data\.codes \?\? \{\}\)/)
})

test('форма: поля кейса на экране и в заявке, дата — цифровая клавиатура, маска и bday', () => {
  for (const id of ['apply-last-name', 'apply-name', 'apply-middle-name', 'apply-birth-date', 'apply-reach', 'apply-school', 'apply-study', 'apply-start-ready', 'apply-vacancy'])
    assert.ok(apply.includes(`id="${id}"`), `нет поля ${id}`)
  // «Учусь / Уже не учусь» — переключатель перед полем вуза: от него зависит, обязательно ли поле
  assert.match(apply, /optionIds=\{\{ studying: 'apply-studying', not: 'apply-not-studying' \}\}/)
  assert.ok(apply.indexOf('id="apply-study"') < apply.indexOf('id="apply-school"'), 'выбор «Уже не учусь» стоит после поля вуза')
  const birth = apply.slice(apply.indexOf('<TextInput\n                        id="apply-birth-date"'), apply.indexOf('/>', apply.indexOf('id="apply-birth-date"')))
  assert.match(birth, /inputMode="numeric"/)
  assert.match(birth, /autoComplete="bday"/)
  assert.match(birth, /typeBirthDate\(e\.target\.value\)/)
  assert.match(birth, /placeholder="ДД\.ММ\.ГГГГ"/)
  // Обязательные поля помечены для скринридера
  for (const id of ['apply-last-name', 'apply-name', 'apply-birth-date', 'apply-reach']) assert.match(apply, new RegExp(`id="${id}"\\s+aria-required="true"`), id)
  const sent = apply.slice(apply.indexOf('app = await submitApplication({'), apply.indexOf('} catch (err)'))
  for (const key of ['lastName:', 'middleName:', 'birthDate: birthDateForSend(form.birthDate)', 'startReady: form.startReady', 'startMonth:', 'notStudying: form.notStudying', 'school: form.school.trim()', 'vacancyId: form.vacancyId'])
    assert.ok(sent.includes(key), `в заявку не уходит ${key}`)
  // Вакансия и учёба — в основной части, не в свёрнутой «Рассказать подробнее»
  // Свёрнутый блок «Необязательно»: от <Disclosure с id="apply-more" до закрывающего тега
  const moreAt = apply.indexOf('id="apply-more"')
  assert.ok(moreAt > 0 && apply.lastIndexOf('<Disclosure', moreAt) > 0, 'нет блока apply-more')
  const more = apply.slice(apply.lastIndexOf('<Disclosure', moreAt), apply.indexOf('</Disclosure>', moreAt))
  for (const id of ['apply-vacancy', 'apply-school', 'apply-course', 'apply-birth-date']) assert.ok(!more.includes(`id="${id}"`), `${id} спрятано в «Рассказать подробнее»`)
})

test('сроки и приглашение: «2 минуты» вместо «минуты», сумма практики из shared', () => {
  assert.doesNotMatch(apply, /одна минута|за минуту/)
  assert.match(apply, /· 2 минуты ·/)
  const offer = inviteOffer().replace(/ /g, ' ')
  assert.equal(offer, 'Оплачиваемая практика в «Очаково»: от 56 000 ₽ до 70 000 ₽ в месяц до вычета налога, наставник у каждого новичка. Заявка занимает 2 минуты.')
  assert.doesNotMatch(offer, /!|бонус/i)
})

test('бесплатная практика и ?practice=1 ставят отметку «Практика от вуза»', () => {
  assert.match(apply, /practiceSchool: params\.get\('practice'\) === '1' \|\| wantsSchoolPractice\(preset\)/)
  assert.match(apply, /const wantsSchoolPractice = \(v: Vacancy \| undefined\) => v\?\.format === 'Бесплатная практика'/)
})

test('телефон или Telegram: переключатель меняет клавиатуру, поле и данные заявки — те же', () => {
  const reach = apply.slice(apply.indexOf('<Field id="apply-reach"'), apply.indexOf('</Field>', apply.indexOf('<Field id="apply-reach"')))
  assert.match(reach, /<Segmented\s+id="apply-reach-mode"/)
  assert.match(reach, /type: 'tel', inputMode: 'tel' as const, autoComplete: 'tel'/)
  assert.match(reach, /type: 'text', inputMode: 'text' as const, autoComplete: 'off'/)
  assert.match(apply, /\{ id: 'phone', label: 'Телефон' \},\s+\{ id: 'telegram', label: 'Telegram' \},/)
  // Контракт с сервером прежний: номер — в phone, ник — в contact
  assert.match(apply, /phone: isPhone\(reach\) \? reach : '',\s+contact: isPhone\(reach\) \? '' : cleanHandle\(reach\),/)
  // Ошибка — про выбранное: «Укажи телефон…» или «Укажи ник в Telegram…»
  assert.match(apply, /reach: \{ phone: 'Укажи телефон: от 10 цифр', telegram: 'Укажи ник в Telegram/)
})

test('задания с главной: карточка «В заявку уйдёт» — только когда что-то пройдено, без ссылки прочь из формы', () => {
  assert.match(apply, /В заявку уйдёт/)
  assert.match(apply, /\(shift > 0 \|\| sentGame\.length > 0 \|\| profile\.conveyorBest > 0\) && \(/)
  const aside = apply.slice(apply.indexOf('<aside'), apply.indexOf('</aside>'))
  assert.doesNotMatch(aside, /to="\/#game"/)
  assert.doesNotMatch(apply, /К заданиям/)
})

test('необязательное — одним свёрнутым блоком, приписка своей строкой; обязательная отметка согласия — со звёздочкой', () => {
  assert.equal(apply.split('<Disclosure').length - 1, 1, 'необязательных блоков больше одного')
  assert.match(apply, /title="Необязательно"/)
  const controls = readFileSync(new URL('../../src/components/candidate/FormControls.tsx', import.meta.url), 'utf8')
  assert.match(controls, /<span className="mt-1\.5 block font-sans[^"]*">\{note\}<\/span>/)
  const box = controls.slice(controls.indexOf('export function Checkbox'), controls.indexOf('type MonthProps'))
  assert.match(box, /\{required && \(/)
})
