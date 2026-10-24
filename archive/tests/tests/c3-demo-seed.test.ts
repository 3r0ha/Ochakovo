// «Демо-данные» в HR-панели: день найма с записями по его ссылке, ответы новичков «Как дела на смене», демо-ответы
// фокус-группы с меткой demo. Кнопку можно нажать второй раз без «Очистить базу» — засев не падает, день найма один.
// Запуск: pnpm test c3-demo-seed (нужен PostgreSQL, база создаётся и удаляется сама)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bookingDeps, listHiringDays } from '../../server/booking'
import type { Registry } from '../../server/channels/registry'
import { clearAll, seedDemo } from '../../server/db/demo'
import { withTestDb } from './_db'

const noBots: Registry = { get: () => undefined, active: () => [], failed: () => [], start: () => {} }

test('демо-данные: день найма, первые недели и фокус-группа; повторное нажатие не падает', async () => {
  await withTestDb('c3-demo-seed', async (sql) => {
    await sql`insert into hr_users (email, name, role, password_hash) values ('hr@demo.test', 'Анна', 'hr', 'x')`
    await seedDemo(sql, 30)
    const days = await listHiringDays(bookingDeps(sql, noBots, {}))
    assert.equal(days.length, 1)
    assert.equal(days[0].label, 'hiringday')
    assert.equal(days[0].offers, 2, 'двое записались по ссылке дня')
    assert.ok(Object.values(days[0].booked).reduce((a, b) => a + b, 0) >= 2)
    const [{ n: guests }] = await sql<{ n: number }[]>`select count(*)::int as n from applications where source = 'hiringday'`
    assert.equal(guests, 2)
    const [{ n: checkins }] = await sql<{ n: number }[]>`select count(*)::int as n from application_checkins where answer = 'hard'`
    assert.ok(checkins >= 1, 'есть ответ «Тяжело»')
    const [{ n: focus }] = await sql<{ n: number }[]>`select count(*)::int as n from focus_responses where tag = 'demo'`
    assert.equal(focus, 24)

    // Второй раз без очистки: заявки добавляются, второй открытый день найма не создаётся
    await seedDemo(sql, 30)
    assert.equal((await listHiringDays(bookingDeps(sql, noBots, {}))).length, 1)

    // «Очистить базу» убирает и день найма, и ответы фокус-группы
    await clearAll(sql)
    assert.equal((await listHiringDays(bookingDeps(sql, noBots, {}))).length, 0)
    const [{ n: left }] = await sql<{ n: number }[]>`select count(*)::int as n from focus_responses`
    assert.equal(left, 0)
  })
})
