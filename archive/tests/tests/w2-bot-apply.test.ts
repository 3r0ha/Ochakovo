// w2-bt-c1, w2-bt-c2: заявка в боте собирает поля кейса с проверкой 18+ по дате рождения и сохраняется через acceptApplication —
// с теми же повторами и лимитами, что форма на сайте. Настоящий PostgreSQL, даты рождения — от текущего момента.
// Запуск: pnpm test w2-bot-apply (база создаётся и удаляется сама)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CONSENT_VERSION, caseFieldMessages } from '../../shared/applications'
import { normalizeApplicationInput } from '../../shared/applicationInput'
import { mskToday } from '../../shared/birthDate'
import { createAssistant } from '../../server/assistant/assistant'
import { REPEAT_MINUTES } from '../../server/candidate/intake'
import { PostgresStorage } from '../../server/db'
import { createEngine } from '../../server/dialog/engine'
import type { DialogEvent, DialogReply, DialogUser } from '../../server/dialog/types'
import { offlineProvider } from '../../server/llm/offline'
import { withTestDb } from './_db'

const assistant = createAssistant({ provider: offlineProvider(), log: () => {} })
const plain = (r: DialogReply) => r.messages.map((m) => m.text).join('\n\n').replace(/\*\*/g, '').replace(/[  ]/g, ' ')

/** Дата рождения years лет назад от сегодняшнего дня по Москве: ДД.ММ.ГГГГ и YYYY-MM-DD */
function birth(years: number) {
  const [y, m, d] = mskToday().split('-')
  return { typed: `${d}.${m}.${Number(y) - years}`, iso: `${Number(y) - years}-${m}-${d}` }
}

type Row = { id: string; name: string; last_name: string; middle_name: string; birth_date: string | null; school: string; not_studying: boolean; start_ready: string; start_month: number | null; adult: boolean | null; channel: string }

test('бот: поля кейса в базе, 18+ по дате, повтор и лимит — как у формы на сайте', async () => {
  await withTestDb('w2-bot-apply', async (sql) => {
    const storage = new PostgresStorage(sql)
    const engine = createEngine(storage, { siteUrl: 'https://ochakovo.test', assistant })
    const run = async (user: DialogUser, ...steps: (string | DialogEvent)[]) => {
      let last: DialogReply | undefined
      for (const step of steps) {
        const event: DialogEvent = typeof step === 'string' ? (/^[a-z]{1,2}:\S*$/.test(step) ? { type: 'action', action: step } : { type: 'text', text: step }) : step
        last = await engine.handle(user, event)
      }
      return last!
    }
    const rows = () => sql<Row[]>`
      select id, name, last_name, middle_name, birth_date::text as birth_date, school, not_studying, start_ready, start_month, adult, channel
      from applications order by created_at`
    const adult = birth(20)

    // Полная заявка: ФИО одной строкой, вуз, «С определённого месяца» → июль
    const tg: DialogUser = { channel: 'telegram', id: '7001', firstName: 'Анна' }
    const done = await run(tg, 'a:start', adult.typed, 'Смирнова Анна Сергеевна', '8 916 700-00-01', 'РХТУ им. Менделеева', 'a:m:7', 'a:mdone', 'a:sr:month', 'a:sm:7', 'a:v:lab-chemist', 'a:ok')
    assert.match(plain(done), /Заявка № \w+ отправлена/, plain(done))
    const [first] = await rows()
    assert.deepEqual(
      { ...first, id: undefined },
      { id: undefined, name: 'Анна', last_name: 'Смирнова', middle_name: 'Сергеевна', birth_date: adult.iso, school: 'РХТУ им. Менделеева', not_studying: false, start_ready: 'month', start_month: 7, adult: true, channel: 'telegram' },
    )

    // Моложе 18: заявка не начинается, ни строки в базе, ни данных в сессии
    const kid: DialogUser = { channel: 'telegram', id: '7002' }
    const no = await run(kid, 'a:start', birth(17).typed)
    assert.ok(plain(no).startsWith('Берём с 18 лет'), plain(no))
    const [kidSession] = await sql<{ data: { flow: string | null; data: Record<string, unknown> } }[]>`select data from sessions where channel = 'telegram' and user_id = '7002'`
    assert.equal(kidSession.data.flow, null)
    assert.equal(kidSession.data.data.apply, undefined, 'дата рождения несовершеннолетнего в сессии не осталась')
    assert.equal((await rows()).length, 1)

    // Тот же телефон с сайта минуту назад — бот отвечает «уже пришла» и не создаёт вторую заявку (повтор по человеку, а не по каналу)
    await storage.saveApplication(
      normalizeApplicationInput({ name: 'Олег', lastName: 'Сидоров', phone: '+7 916 700-00-02', birthDate: adult.iso, school: 'МГУПП', startReady: 'now', consent: true, consentVersion: CONSENT_VERSION, consentSource: 'site_form', game: { quizResult: null, conveyorBest: 0 } }),
    )
    const dupUser: DialogUser = { channel: 'max', id: '7003' }
    const dup = await run(dupUser, 'a:start', adult.typed, 'Сидоров Олег', '+7 916 700-00-02', 'a:nostudy', 'a:mnone', 'a:sr:now', 'a:v:any', 'a:ok')
    assert.ok(plain(dup).startsWith('Заявка с этим номером уже пришла'), plain(dup))
    assert.ok(!plain(dup).includes('Олег') && !plain(dup).includes('700'), 'ответ о повторе без чужих данных')
    assert.equal((await rows()).length, 2)

    // Три заявки с одного номера за час (старше 10 минут) — четвёртая из бота упирается в лимит и остаётся на проверке
    const phone = '+79167000004'
    for (let i = 0; i < 3; i++) {
      const app = await storage.saveApplication(
        normalizeApplicationInput({ name: 'Вера', lastName: 'Лимитова', phone, birthDate: adult.iso, school: 'МГУПП', startReady: 'now', consent: true, consentVersion: CONSENT_VERSION, consentSource: 'site_form', game: { quizResult: null, conveyorBest: 0 } }),
      )
      await sql`update applications set created_at = now() - make_interval(mins => ${REPEAT_MINUTES + 5 + i}) where id = ${app.id}`
    }
    const limitUser: DialogUser = { channel: 'telegram', id: '7004' }
    const limit = await run(limitUser, 'a:start', adult.typed, 'Лимитова Вера', phone, 'МГУПП', 'a:mnone', 'a:sr:two_weeks', 'a:v:any', 'a:ok')
    assert.match(plain(limit), /за час уже пришло 3 заявки\. Следующую можно отправить через \d+ минут/, plain(limit))
    const [limitSession] = await sql<{ data: { flow: string | null; data: { apply?: { step: string } } } }[]>`select data from sessions where channel = 'telegram' and user_id = '7004'`
    assert.equal(limitSession.data.data.apply?.step, 'confirm', 'заявка ждёт на экране проверки')
    assert.equal((await rows()).length, 5)

    // Сессия из старой версии бота: на проверке нет вуза и когда выйти — бот не сохраняет, а спрашивает недостающее
    const legacy: DialogUser = { channel: 'telegram', id: '7005' }
    await run(legacy, 'm')
    await sql`
      update sessions set data = ${sql.json({
        flow: 'apply',
        data: { apply: { step: 'confirm', birthDate: adult.iso, birthTyped: adult.typed, name: 'Ира', lastName: 'Старая', phone: '+79167000005', contact: '', months: [], vacancyId: '' } },
        progress: {},
        source: null,
      })}
      where channel = 'telegram' and user_id = '7005'`
    const missing = await run(legacy, 'a:ok')
    assert.ok(plain(missing).startsWith(caseFieldMessages.school), plain(missing))
    assert.equal((await rows()).length, 5, 'без полей кейса заявка не сохраняется')
    const fixed = await run(legacy, 'Колледж № 1')
    assert.ok(plain(fixed).startsWith('Проверь заявку'), 'после исправления — снова проверка')
    const stillMissing = await run(legacy, 'a:ok')
    assert.ok(plain(stillMissing).startsWith('Выбери, когда сможешь выйти на работу'), plain(stillMissing))
    await run(legacy, 'a:sr:after_session')
    const saved = await run(legacy, 'a:ok')
    assert.match(plain(saved), /Заявка № \w+ отправлена/, plain(saved))
    const last = (await rows()).at(-1)!
    assert.equal(last.school, 'Колледж № 1')
    assert.equal(last.start_ready, 'after_session')
  })
})
