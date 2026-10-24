// Страницы и чат пакета pages-chat: /consent, политика называет все поля заявки, подвал, строка приглашения,
// чат (подсказка поля, таймаут, код приглашения, заявка из чата, без опроса по таймеру), честные слова во всех файлах пакета.
// Запуск: pnpm test w1-pages-chat

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { CONSENT_VERSION } from '../../shared/applications'
import { contacts } from '../../shared/content/content'

const src = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8')

/** Поля, которые форма отправляет в заявке: ключи объекта в submitApplication({...}) */
function sentFields() {
  const apply = src('pages/Apply.tsx')
  const start = apply.indexOf('app = await submitApplication({')
  const end = apply.indexOf('} catch (err)', start)
  assert.ok(start > 0 && end > start, 'в Apply.tsx не найден вызов submitApplication')
  return new Set([...apply.slice(start, end).matchAll(/(?:^\s+|\{\s)(\w+):/gm)].map((m) => m[1]))
}

/**
 * Какими словами каждое поле заявки названо в политике и в тексте согласия. Новое поле в форме без строки здесь
 * роняет проверку: сначала его нужно описать в /privacy и /consent. null — не персональные данные (ловушка для ботов)
 */
const described: Record<string, string | null> = {
  name: 'имя',
  lastName: 'фамилия',
  middleName: 'отчество',
  birthDate: 'дата рождения',
  startReady: 'когда можешь выйти',
  startMonth: 'когда можешь выйти',
  notStudying: 'уже не учусь',
  phone: 'телефон',
  contact: 'ник в telegram',
  consent: 'согласие',
  consentVersion: 'верси',
  citizenship: 'гражданство',
  medBook: 'медкнижка',
  shifts: 'смены',
  portfolio: 'портфолио',
  school: 'вуз или колледж',
  course: 'курс',
  department: 'направление',
  vacancyId: 'вакансия',
  format: 'формат',
  months: 'месяцы',
  comment: 'комментарий',
  friend: 'друг',
  practiceSchool: 'практика от вуза',
  wantsToStay: 'остаться после сезона',
  game: 'результаты заданий',
  quizResult: 'подбор',
  conveyorBest: 'поймай брак',
  activities: 'сколько заданий',
  companyQuiz: 'контрольных вопросов',
  source: 'метка',
  refCode: 'код приглашения',
  website: null,
}

test('политика и текст согласия называют каждое поле, которое отправляет форма', () => {
  const privacy = src('pages/Privacy.tsx').toLowerCase()
  const consent = src('pages/Consent.tsx').toLowerCase()
  const fields = sentFields()
  for (const key of ['name', 'lastName', 'birthDate', 'startReady', 'notStudying', 'citizenship', 'refCode', 'practiceSchool', 'website']) assert.ok(fields.has(key), `разбор формы не нашёл поле ${key}`)
  for (const field of fields) {
    assert.ok(field in described, `поле ${field} уходит в заявке, но не описано в политике — добавь его в /privacy, /consent и в этот тест`)
    const word = described[field]
    if (!word) continue
    assert.ok(privacy.includes(word), `в политике нет «${word}» (поле ${field})`)
    assert.ok(consent.includes(word), `в тексте согласия нет «${word}» (поле ${field})`)
  }
})

test('политика: источники данных, переписка в Telegram и MAX, ссылка на текст согласия с версией', () => {
  const privacy = src('pages/Privacy.tsx')
  for (const part of ['Откуда данные', 'hh.ru', 'ярмарк', 'боты в Telegram и MAX', 'серверы Telegram и MAX', 'to="/consent"', 'CONSENT_VERSION', 'Контакт друга не спрашиваем'])
    assert.ok(privacy.includes(part), `в политике нет «${part}»`)
})

test('/consent: оператор, цели, перечень, действия, поручения при подключении, срок, отзыв, версия', () => {
  const consent = src('pages/Consent.tsx')
  const legal = src('components/candidate/legal.ts')
  for (const part of ["title: 'Кому'", "title: 'Зачем'", "title: 'Какие данные'", "title: 'Что с ними делаем'", "title: 'Сколько действует'", "title: 'Как отозвать'", "title: 'Версия'"])
    assert.ok(consent.includes(part), `на /consent нет раздела ${part}`)
  assert.match(consent, /Сезон и ещё 12 месяцев/)
  assert.match(consent, /Версия текста: \$\{CONSENT_VERSION\}/)
  assert.match(consent, /operator\.name.*operator\.address/)
  assert.match(consent, /operator\.inn/)
  // Поручения — только подключённые: по ответу /api/privacy
  assert.match(consent, /\.\.\.\(processors\.yandex360 \|\| processors\.sms/)
  assert.match(legal, /fetch\('\/api\/privacy'/)
  assert.match(legal, /inn: '7729101200'/)
  assert.equal(CONSENT_VERSION.length > 0, true)
})

// Адрес и маршрут подвал берёт из shared/content (contacts): что писать о дороге, решает справочник студента
// и docs/case-delta.md (корпоративный автобус от м. «Озёрная» есть), а не вёрстка подвала
test('подвал: адрес и маршрут из contacts, строка о команде, без «Прототип»', () => {
  const layout = src('components/Layout.tsx')
  const footer = layout.slice(layout.indexOf('function Footer('))
  assert.match(footer, /\{contacts\.address\}\. \{contacts\.routeShort\}\./)
  assert.ok(contacts.address.length > 0 && contacts.routeShort.length > 0)
  const line = footer.replace(/\\u00A0/g, ' ')
  assert.ok(line.includes('Решение команды на кейс «Открой#Моспром» для АО МПБК «Очаково». Неофициальный сайт компании · фото с ochakovo.ru'))
  assert.match(footer, /to="\/consent"/)
})

test('строка приглашения под шапкой: только по чужому коду, до своей заявки, страницы сдвигаются на её высоту', () => {
  const layout = src('components/Layout.tsx')
  assert.match(layout, /const visible = !closed && !sent && !pathname\.startsWith\('\/game'\) && Boolean\(invitedBy\(source\)\)/)
  assert.match(layout, /setProperty\('--invite-h'/)
  assert.match(layout, /'\/consent': 'Согласие на обработку данных'/)
  for (const page of ['Apply', 'Vacancies', 'Privacy', 'Consent', 'NotFound'])
    assert.match(src(`pages/${page}.tsx`), /pt-\[calc\(72px\+var\(--invite-h,0px\)\)\]/, `${page}: страница уходит под строку приглашения`)
})

test('чат: код приглашения в запросе, таймаут 30 с с «Повторить», заявка из чата запоминается', () => {
  const chat = src('components/chat/useChat.ts')
  assert.match(chat, /export const CHAT_TIMEOUT_MS = 30_000/)
  assert.match(chat, /refCode: myRefCode\(\)/)
  assert.match(chat, /if \(timedOut\) setFailed\(\{ event, failure: \{ reason: 'timeout' \} \}\)/)
  assert.match(chat, /useSentApplication\.getState\(\)\.remember\(reply\.application\)/)
  assert.match(chat, /input: m\.input/)
  const sent = src('components/candidate/sent.ts')
  assert.match(sent, /token: app\.statusToken \?\? app\.token/)
})

test('чат: подсказка поля по шагу бота, inputmode=tel на телефоне, панель без <header>', () => {
  const panel = src('components/chat/ChatPanel.tsx')
  assert.match(panel, /phone: \{ label: 'Телефон для заявки', placeholder: '[^']+', inputMode: 'tel', autoComplete: 'tel' \}/)
  assert.match(panel, /name: \{ label: 'Имя для заявки', placeholder: 'Имя'/)
  assert.match(panel, /free: \{ label: 'Вопрос Квасычу', placeholder: 'Напиши вопрос'/)
  // Бот на шаге телефона принимает и ник: на цифровой клавиатуре букв нет — есть переключатель
  assert.match(panel, /handle: \{ label: '[^']+', placeholder: '@ник в Telegram или MAX', inputMode: 'text'/)
  assert.match(panel, /'Ввести номер телефона' : 'Ник вместо номера'/)
  assert.match(panel, /chat\.expect === 'phone' && touch &&/)
  assert.match(panel, /placeholder: 'Телефон или @ник'/)
  assert.match(panel, /inputMode=\{field\.inputMode\}/)
  assert.match(panel, /Квасыч не ответил за \$\{CHAT_TIMEOUT_MS \/ 1000\} секунд\./)
  assert.doesNotMatch(panel, /<header|<\/header>/)
  assert.match(panel, /RESPONSE_WORDS/)
})

test('кнопка чата: точка мигает три раза, страница не опрашивается по таймеру', () => {
  const launcher = src('components/chat/Chat.tsx')
  assert.doesNotMatch(launcher, /setInterval/)
  assert.match(launcher, /motion-safe:animate-ping" style=\{\{ animationIterationCount: 3 \}\}/)
})

/** Файлы пакета, где есть тексты для людей */
const files = [
  'pages/Apply.tsx',
  'pages/Vacancies.tsx',
  'pages/Privacy.tsx',
  'pages/Consent.tsx',
  'pages/NotFound.tsx',
  'components/Layout.tsx',
  'components/candidate/ApplicationStatus.tsx',
  'components/candidate/NextSteps.tsx',
  'components/candidate/VacancyRow.tsx',
  'components/candidate/applyText.ts',
  'components/chat/ChatPanel.tsx',
  'components/chat/Chat.tsx',
  'components/chat/Message.tsx',
]

test('честные слова: без «Прототип», «бонус», восклицаний и дат', () => {
  for (const f of files) {
    const text = src(f)
    assert.doesNotMatch(text, /Прототип/, f)
    assert.doesNotMatch(text, /бонус/i, f)
    assert.doesNotMatch(text, /[а-яё»]!(\s|'|`|<|$)/im, `${f}: восклицательный знак в тексте`)
    assert.doesNotMatch(text, /\b(19|20)\d{2}\b/, `${f}: похоже на год`)
  }
})
