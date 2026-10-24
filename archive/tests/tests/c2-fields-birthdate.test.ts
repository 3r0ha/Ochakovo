// c2-fields-1: дата рождения и 18+. Разбор ввода ДД.ММ.ГГГГ, Д.М.ГГГГ, ГГГГ-ММ-ДД, возраст от текущего момента по Москве,
// underage и bad_birth_date на сервере, adult из даты, старые заявки с adult без даты.
// Все даты считаются от текущего момента — в проверке нет ни одной записанной даты.
// Запуск: pnpm test c2-fields-birthdate (нужен PostgreSQL, база создаётся и удаляется сама)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CONSENT_VERSION, checkApplication, type ApplicationInput } from '../../shared/applications'
import { normalizeApplicationInput, UnderageError } from '../../shared/applicationInput'
import {
  adultSince,
  ageOn,
  ageWords,
  birthDateMessages,
  birthDateProblem,
  formatBirthDate,
  isAdultByBirthDate,
  maskBirthDate,
  MAX_AGE,
  MIN_AGE,
  mskToday,
  normalizeBirthDate,
  parseBirthDate,
} from '../../shared/birthDate'
import { createApp } from '../../server/app'
import type { Registry } from '../../server/channels/registry'
import { migrate, PostgresStorage } from '../../server/db'
import { WorkflowRepo } from '../../server/db/workflow'
import { serverSettled, withTestDb } from './_db'

const noBots: Registry = { get: () => undefined, active: () => [], failed: () => [], start: () => {} }
const pad = (n: number, len = 2) => String(n).padStart(len, '0')

/**
 * День по Москве в момент now минус years лет и плюс days дней: YYYY-MM-DD.
 * День месяца — не больше 28: без 29 февраля и концов месяцев, поэтому точные границы проверяем на 10-м числе (on10th)
 */
function shifted(years: number, days = 0, now: number = Date.now()) {
  const [y, m, d] = mskToday(now).split('-').map(Number)
  const base = new Date(Date.UTC(y - years, m - 1, Math.min(d, 28)))
  base.setUTCDate(base.getUTCDate() + days)
  return base.toISOString().slice(0, 10)
}
const dmy = (iso: string) => {
  const [y, m, d] = iso.split('-')
  return `${d}.${m}.${y}`
}
const thisYear = Number(mskToday().slice(0, 4))
/** Полдень по Москве 10-го числа текущего месяца: от него точные границы возраста не упираются в конец месяца */
const on10th = (() => {
  const [y, m] = mskToday().split('-').map(Number)
  return Date.UTC(y, m - 1, 10, 9)
})()
/** Ближайший прошедший високосный год, от которого прошло больше 20 лет */
const leapYear = (() => {
  let y = thisYear - 21
  while (!(y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0))) y--
  return y
})()

test('разбор ввода: ДД.ММ.ГГГГ, Д.М.ГГГГ, ГГГГ-ММ-ДД, другие разделители и «г.»', () => {
  const iso = shifted(20)
  const [y, m, d] = iso.split('-')
  for (const input of [dmy(iso), `${+d}.${+m}.${y}`, iso, ` ${dmy(iso)} `, `${d}/${m}/${y}`, `${d}-${m}-${y}`, `${d} ${m} ${y}`, `${dmy(iso)} г.`, `${d}. ${m}. ${y}`])
    assert.equal(parseBirthDate(input), iso, input)
  assert.equal(normalizeBirthDate(dmy(iso)), iso)
  // Для хранения: опечатку (будущее, старше 70) не храним, моложе 18 — храним, HR видит возраст
  assert.equal(normalizeBirthDate(dmy(shifted(-1))), '')
  assert.equal(normalizeBirthDate(dmy(shifted(MAX_AGE + 2))), '')
  assert.equal(normalizeBirthDate(dmy(shifted(16))), shifted(16))
  assert.equal(formatBirthDate(iso), dmy(iso))
  assert.equal(formatBirthDate(''), '')
  // Не дата: двузначный год, текст, лишние цифры, не строка
  for (const bad of [`${d}.${m}.${y.slice(2)}`, 'вчера', `${d}${m}${y}`, `${y}${m}${d}`, `${d}.${m}.${y}.${d}`, '', 42, null, undefined]) {
    assert.equal(parseBirthDate(bad), null, String(bad))
    assert.equal(normalizeBirthDate(bad), '', String(bad))
  }
})

test('невозможные даты: 31 апреля, 30 февраля, 29 февраля в невисокосный год, месяц 13', () => {
  const y = thisYear - 20
  const nonLeap = y % 4 === 0 ? y - 1 : y
  for (const s of [`31.04.${y}`, `30.02.${y}`, `29.02.${nonLeap}`, `15.13.${y}`, `00.05.${y}`, `${y}-02-30`]) {
    assert.equal(parseBirthDate(s), null, s)
    assert.deepEqual(birthDateProblem(s), { code: 'bad_birth_date', message: birthDateMessages.impossible }, s)
  }
  assert.equal(parseBirthDate(`29.02.${leapYear}`), `${leapYear}-02-29`, 'в високосный год 29 февраля есть')
})

test('возраст от момента проверки: исполнилось 18 сегодня — можно, завтра — ещё нет; больше 70 и будущее — опечатка', () => {
  const now = on10th
  const today18 = shifted(18, 0, now)
  assert.equal(ageOn(today18, now), 18)
  assert.equal(birthDateProblem(dmy(today18), now), null, 'день рождения сегодня — 18 исполнилось')
  const tomorrow18 = shifted(18, 1, now)
  assert.equal(ageOn(tomorrow18, now), 17)
  assert.deepEqual(birthDateProblem(dmy(tomorrow18), now), { code: 'underage', message: birthDateMessages.underage })
  assert.equal(adultSince(tomorrow18), shifted(0, 1, now), '18 исполнится завтра')
  assert.equal(isAdultByBirthDate(tomorrow18, now), false)
  assert.equal(isAdultByBirthDate(today18, now), true)
  assert.equal(isAdultByBirthDate(''), null)

  assert.equal(birthDateProblem(dmy(shifted(MAX_AGE, 0, now)), now), null, 'ровно 70 — можно')
  assert.deepEqual(birthDateProblem(dmy(shifted(MAX_AGE + 1, 0, now)), now), { code: 'bad_birth_date', message: birthDateMessages.tooOld })
  assert.deepEqual(birthDateProblem(dmy(shifted(0, 1, now)), now), { code: 'bad_birth_date', message: birthDateMessages.future })
  assert.deepEqual(birthDateProblem(dmy(shifted(-1))), { code: 'bad_birth_date', message: birthDateMessages.future })
  // Без now — от текущего момента
  assert.equal(birthDateProblem(dmy(shifted(17)))?.code, 'underage')
  assert.equal(birthDateProblem(dmy(shifted(20))), null)
  assert.deepEqual(birthDateProblem(''), { code: 'bad_birth_date', message: birthDateMessages.required })
  assert.deepEqual(birthDateProblem('вчера'), { code: 'bad_birth_date', message: birthDateMessages.format })
  assert.equal(MIN_AGE, 18)
  // Текст ошибки — человеческий: прямой ответ первым, без «!», нейтральный род
  for (const text of Object.values(birthDateMessages)) assert.ok(!/!|\.\.\.|…/.test(text), text)
  assert.match(birthDateMessages.underage, /^Берём с 18 лет/)
})

test('возраст считается по Москве: в 23:30 по Москве — ещё вчера, в 00:30 — уже день рождения', () => {
  const [y, m] = mskToday().split('-').map(Number)
  // 10-е число этого месяца, 21:30 и 20:30 UTC — это 00:30 11-го и 23:30 10-го по Москве
  const mskAfterMidnight = Date.UTC(y, m - 1, 10, 21, 30)
  const mskBeforeMidnight = Date.UTC(y, m - 1, 10, 20, 30)
  const birth = `${pad(y - 18, 4)}-${pad(m)}-11`
  assert.equal(mskToday(mskAfterMidnight), `${pad(y, 4)}-${pad(m)}-11`)
  assert.equal(ageOn(birth, mskAfterMidnight), 18)
  assert.equal(ageOn(birth, mskBeforeMidnight), 17, 'по UTC уже 10-е, по Москве — ещё не 11-е')
  assert.equal(birthDateProblem(birth, mskAfterMidnight), null)
  assert.equal(birthDateProblem(birth, mskBeforeMidnight)?.code, 'underage')
})

test('29 февраля: в невисокосный год 18 исполняется 28 февраля (ст. 192 ГК РФ)', () => {
  const birth = `${leapYear}-02-29`
  // Год, когда исполняется 18, и он невисокосный — проверяем на своей «сегодняшней» дате
  const y18 = leapYear + 18
  const isLeap = (v: number) => v % 4 === 0 && (v % 100 !== 0 || v % 400 === 0)
  assert.ok(!isLeap(y18))
  assert.equal(adultSince(birth), `${y18}-02-28`)
  const mskNoon = (month: number, day: number) => Date.UTC(y18, month - 1, day, 9)
  assert.equal(ageOn(birth, mskNoon(2, 27)), 17)
  assert.equal(ageOn(birth, mskNoon(2, 28)), 18)
  assert.equal(ageOn(birth, mskNoon(3, 1)), 18)
})

test('маска ввода на телефоне: точки сами, ручные точки уважает, Backspace не застревает', () => {
  const iso = shifted(20)
  const [y, m, d] = iso.split('-')
  const digits = `${d}${m}${y}`
  // Ввод по одной цифре
  const steps = [...digits].map((_, i) => maskBirthDate(digits.slice(0, i + 1)))
  assert.deepEqual(steps, [d[0], d, `${d}.${m[0]}`, `${d}.${m}`, `${d}.${m}.${y[0]}`, `${d}.${m}.${y.slice(0, 2)}`, `${d}.${m}.${y.slice(0, 3)}`, dmy(iso)])
  // Поле уже с точкой маски — следующая цифра уходит в месяц и год
  assert.equal(maskBirthDate(`${d}.${m}${y[0]}`), `${d}.${m}.${y[0]}`)
  // Свои точки: «5.3.» остаётся, однозначные день и месяц читаются
  assert.equal(maskBirthDate('5.3.'), '5.3.')
  assert.equal(maskBirthDate(`5.3.${y}`), `5.3.${y}`)
  assert.equal(parseBirthDate(maskBirthDate(`5.3.${y}`)), `${y}-03-05`)
  // Backspace после точки: «05.» → «05»
  assert.equal(maskBirthDate(d), d)
  assert.equal(maskBirthDate(`${d}.`), `${d}.`)
  // Лишние цифры и буквы отбрасываются, ГГГГ-ММ-ДД из автозаполнения переводится
  assert.equal(maskBirthDate(`${digits}99`), dmy(iso))
  assert.equal(maskBirthDate(`д${d}р${m}${y}`), dmy(iso))
  assert.equal(maskBirthDate(iso), dmy(iso))
  assert.equal(maskBirthDate(''), '')
})

test('возраст словами', () => {
  assert.deepEqual([18, 19, 21, 22, 25, 31, 44, 111, 52].map(ageWords), ['18 лет', '19 лет', '21 год', '22 года', '25 лет', '31 год', '44 года', '111 лет', '52 года'])
})

test('adult выводится из даты рождения; без даты — как прислали', () => {
  const adult = normalizeApplicationInput({ birthDate: dmy(shifted(19)), adult: false })
  assert.equal(adult.birthDate, shifted(19))
  assert.equal(adult.adult, true, 'дата рождения важнее отметки')
  assert.equal(normalizeApplicationInput({ birthDate: dmy(shifted(17)), adult: true }).adult, false)
  assert.equal(normalizeApplicationInput({ adult: true }).adult, true, 'старый ввод без даты: отметка как есть')
  assert.equal(normalizeApplicationInput({}).adult, null)
  assert.equal(normalizeApplicationInput({ birthDate: 'не дата', adult: true }).birthDate, '')
  assert.equal(normalizeApplicationInput({ birthDate: 'не дата', adult: true }).adult, true)
})

test('checkApplication: underage только для заявки кандидата, опечатка — везде', () => {
  const young = { name: 'Аня', phone: '+79161234567', birthDate: dmy(shifted(17)) }
  assert.equal(checkApplication(young, { candidate: true }).codes.birthDate, 'underage')
  assert.equal(checkApplication(young, { candidate: true }).errors.birthDate, birthDateMessages.underage)
  // HR добавляет кандидата вручную: возраст видит в карточке и решает сам
  assert.equal(checkApplication(young).errors.birthDate, undefined)
  const typo = { ...young, birthDate: `31.02.${thisYear - 20}` }
  assert.equal(checkApplication(typo).codes.birthDate, 'bad_birth_date')
  assert.equal(checkApplication(typo, { candidate: true }).codes.birthDate, 'bad_birth_date')
  assert.equal(checkApplication({ ...young, birthDate: '' }, { candidate: true }).codes.birthDate, 'required')
  assert.equal(checkApplication({ ...young, birthDate: '' }).codes.birthDate, undefined)
})

test('сервер: моложе 18 — 422 underage, опечатка — 422 bad_birth_date, ничего не записано; PostgreSQL отклоняет моложе 18', async () => {
  await withTestDb('c2-birth', async (sql) => {
    const storage = new PostgresStorage(sql)
    const app = await createApp({ storage, engine: null, bots: noBots, hrToken: '', env: { NODE_ENV: 'test' } })
    await serverSettled(sql)
    let n = 0
    const post = (birthDate: string) =>
      app.request('/api/applications', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${++n}` },
        body: JSON.stringify({
          name: 'Аня',
          lastName: 'Иванова',
          phone: `+7 900 100-20-${pad(n)}`,
          school: 'МГУПП',
          startReady: 'now',
          birthDate,
          consent: true,
          consentVersion: CONSENT_VERSION,
        }),
      })
    for (const [birthDate, code] of [
      [dmy(shifted(17)), 'underage'],
      [dmy(shifted(10)), 'underage'],
      [`31.04.${thisYear - 20}`, 'bad_birth_date'],
      [dmy(shifted(MAX_AGE + 2)), 'bad_birth_date'],
      [dmy(shifted(-1)), 'bad_birth_date'],
      ['двадцать лет', 'bad_birth_date'],
      ['', 'required'],
    ] as const) {
      const res = await post(birthDate)
      const body = (await res.json()) as { error: string; errors: Record<string, string>; codes: Record<string, string> }
      assert.equal(res.status, 422, birthDate)
      assert.equal(body.error, 'validation')
      assert.equal(body.codes.birthDate, code, birthDate)
      assert.ok(body.errors.birthDate, birthDate)
      assert.deepEqual(Object.keys(body.errors), ['birthDate'], `${birthDate}: остальные поля в порядке`)
    }
    const [{ count }] = await sql<{ count: number }[]>`select count(*)::int as count from applications`
    assert.equal(count, 0, 'ни одна заявка с плохой датой не записана')

    // 18 лет, ввод Д.М.ГГГГ — принимается, в базе YYYY-MM-DD и adult
    const ok = await post(`${Number(shifted(18).slice(8))}.${Number(shifted(18).slice(5, 7))}.${shifted(18).slice(0, 4)}`)
    assert.equal(ok.status, 201, await ok.clone().text())
    const created = (await ok.json()) as { id: string; birthDate: string; adult: boolean }
    assert.equal(created.birthDate, shifted(18))
    assert.equal(created.adult, true)
    const [row] = await sql<{ birth_date: Date; adult: boolean }[]>`select birth_date, adult from applications where id = ${created.id}`
    assert.equal(row.birth_date.toISOString().slice(0, 10), shifted(18))
    assert.equal(row.adult, true)

    // Страховка в PostgreSQL: бот, который забыл проверку, не сохранит заявку моложе 18
    const bot = { name: 'Бот', phone: '+79001112233', channel: 'telegram', channelUserId: '9', birthDate: shifted(17), consent: true, consentVersion: CONSENT_VERSION } as ApplicationInput
    await assert.rejects(storage.saveApplication(bot), UnderageError)
    const saved = await storage.saveApplication({ ...bot, birthDate: dmy(shifted(19)) })
    assert.equal(saved.birthDate, shifted(19))
    assert.equal(saved.adult, true)
  })
})

test('старые заявки: adult без даты не ломается, после 021 читается как было', async () => {
  await withTestDb(
    'c2-birth-old',
    async (sql) => {
      await sql`insert into applications (id, channel, name, adult) values ('C2OLDY', 'web', 'Старая', true), ('C2OLDN', 'telegram', 'Старая', false), ('C2OLD0', 'hr', 'Старая', null)`
      await migrate(sql, { quiet: true })
      const repo = new WorkflowRepo(sql)
      for (const [id, adult] of [['C2OLDY', true], ['C2OLDN', false], ['C2OLD0', null]] as const) {
        const a = (await repo.get(id))!
        assert.equal(a.adult, adult, id)
        assert.equal(a.birthDate, '', id)
      }
      // Дата появилась позже (HR дополнил анкету) — 18+ считается по ней на сегодня, а не по старой отметке
      await sql`update applications set birth_date = ${shifted(25)} where id = 'C2OLDN'`
      assert.equal((await repo.get('C2OLDN'))!.adult, true)
      // Кандидату было 17 при записи, отметка в базе false — со временем по дате он взрослый
      await sql`update applications set birth_date = ${shifted(18)}, adult = false where id = 'C2OLD0'`
      assert.equal((await repo.get('C2OLD0'))!.adult, true)
    },
    { migrate: 12 },
  )
})
