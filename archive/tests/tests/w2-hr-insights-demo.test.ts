// «Демо-данные» для новых разделов (w2-hi-3) и полей кейса: дата рождения (только 18+, от текущего момента), когда может
// выйти, вуз или «Уже не учусь»; у «К оформлению» — даты оформления и первой смены, у «На смене» — наставник, документы
// по практике, итог сезона и резерв; практика от вуза, «хочет остаться», источники согласия, пара по приглашению с сайта,
// самозапись, подписка «Напомнить о наборе». После «Демо-данных» новые срезы «Воронки» за 30 дней не пустые.
// Запуск: pnpm test w2-hr-insights (нужен PostgreSQL, база создаётся и удаляется сама)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ageOn, MIN_AGE } from '../../shared/birthDate'
import { demoApplications, demoBirthDate } from '../../shared/demo'
import { inReserve, pairIds } from '../../shared/hrFilter'
import { seedDemo } from '../../server/db/demo'
import { funnelReport } from '../../server/db/funnel'
import { WorkflowRepo } from '../../server/db/workflow'
import { withTestDb } from './_db'

const HOUR = 3600e3
const DAY = 24 * HOUR

test('дата рождения демо-кандидата: ровно выбранный возраст, только с 18 лет', () => {
  for (let i = 0; i < 300; i++) {
    const min = 18 + (i % 5)
    const birth = demoBirthDate(min, min + 3)
    const age = ageOn(birth)!
    assert.ok(age >= min && age <= min + 3, `${birth}: ${age}`)
    // Через две недели показа возраст не меняется — день рождения не выпадет на показ
    assert.equal(ageOn(birth, Date.now() + 14 * DAY), age)
  }
  for (const a of demoApplications(300)) {
    assert.ok(ageOn(a.birthDate!)! >= MIN_AGE, 'только 18+')
    assert.ok(a.startReady, 'когда может выйти')
    assert.ok(a.school || a.notStudying, 'вуз, колледж или «Уже не учусь»')
    if (a.startReady === 'month') assert.ok(a.startMonth! >= 3 && a.startMonth! <= 9)
    else assert.equal(a.startMonth, null)
    if (a.practiceSchool) assert.ok(!a.notStudying && /практика/i.test(a.format), 'практика от вуза — у студентов на практике')
  }
})

test('«Демо-данные»: поля кейса, оформление, итог сезона, согласие, самозапись, подписка; срезы «Воронки» не пустые', async () => {
  await withTestDb('w2hri_demo', async (sql) => {
    await sql`insert into hr_users (email, name, role, password_hash) values ('olga@ochakovo.local', 'Ольга Смирнова', 'admin', 'x')`
    await seedDemo(sql, 24)
    const apps = await new WorkflowRepo(sql).list()
    const now = Date.now()
    const live = apps.filter((a) => !a.duplicateOf)

    // Анкета кандидата с сайта и из ботов — с полями кейса
    for (const a of live.filter((x) => x.channel !== 'hr')) {
      assert.ok(a.lastName, `фамилия у ${a.id}`)
      assert.ok(a.birthDate && ageOn(a.birthDate)! >= 18 && ageOn(a.birthDate)! <= 26, `дата рождения ${a.birthDate}`)
      assert.equal(a.adult, true)
      assert.ok(a.startReady, 'когда может выйти')
      assert.ok(a.school || a.notStudying, 'учёба')
    }
    assert.ok(live.some((a) => a.notStudying), 'есть «Уже не учусь»')
    assert.ok(live.some((a) => a.startReady === 'month' && a.startMonth), 'есть «С определённого месяца»')
    // Добавленный по звонку — без даты рождения: её допишет HR
    const byPhone = live.find((a) => a.channel === 'hr' && a.source === 'phone')!
    assert.equal(byPhone.birthDate, '')
    assert.equal(byPhone.consentSource, 'hr_verbal')
    assert.ok(byPhone.consentBy, 'кто отметил согласие')

    // «К оформлению»: дата оформления в ближайшие будни, первая смена после неё — днём или ночью
    const hired = live.filter((a) => a.status === 'hired')
    assert.ok(hired.length >= 2)
    for (const a of hired) {
      assert.ok(a.onboardingAt, 'дата оформления')
      const day = new Date(new Date(a.onboardingAt).getTime() + 3 * HOUR).getUTCDay()
      assert.ok(day >= 1 && day <= 5, 'оформление в будний день')
      if (a.firstShiftAt) {
        assert.ok(a.firstShiftAt > a.onboardingAt, 'первая смена после оформления')
        const hour = new Date(new Date(a.firstShiftAt).getTime() + 3 * HOUR).getUTCHours()
        assert.equal(hour, a.shiftKind === 'night' ? 20 : 8, 'смена с 8:00 или с 20:00')
      }
    }

    // «На смене»: наставник, оформление до первой смены, первая смена до перехода в «На смене»
    const started = live.filter((a) => a.status === 'started')
    assert.ok(started.length >= 4)
    const history = await sql<{ application_id: string; to_status: string; kind: string; created_at: Date; comment: string }[]>`
      select application_id, to_status, kind, created_at, comment from application_history`
    for (const a of started) {
      assert.ok(a.mentorName, `наставник у ${a.id}`)
      assert.ok(a.onboardingAt && a.firstShiftAt && a.onboardingAt < a.firstShiftAt)
      const startedAt = history.find((h) => h.application_id === a.id && h.to_status === 'started' && h.kind === 'status')!.created_at.getTime()
      const hiredAt = history.find((h) => h.application_id === a.id && h.to_status === 'hired')!.created_at.getTime()
      assert.ok(new Date(a.firstShiftAt).getTime() < startedAt, 'первая смена — до перехода в «На смене»')
      assert.ok(new Date(a.onboardingAt).getTime() >= hiredAt, 'оформление — после решения взять')
      if (a.practiceSchool) assert.ok(a.practiceDocs.includes('contract') && a.practiceDocs.includes('order'), 'договор и приказ у практиканта')
    }
    // Итог сезона: доработали практиканты от вуза (все четыре документа), один ушёл с причиной, резерв есть
    const completed = started.filter((a) => a.seasonOutcome === 'completed')
    assert.equal(completed.length, 2)
    for (const a of completed) {
      assert.equal(a.practiceSchool, true)
      assert.equal(a.format, 'Бесплатная практика')
      assert.deepEqual(a.practiceDocs, ['contract', 'order', 'diary', 'reference'])
      const note = history.find((h) => h.application_id === a.id && h.kind === 'season')!
      assert.match(note.comment, /^Сезон отработан/)
      assert.ok(note.created_at.getTime() <= now && note.created_at.getTime() >= new Date(a.createdAt).getTime())
    }
    const left = started.filter((a) => a.seasonOutcome === 'left')
    assert.equal(left.length, 1)
    assert.ok(left[0].seasonLeaveReason)
    assert.ok(started.some((a) => a.reserve), 'отметка «Звать в штат / резерв»')
    assert.ok(live.some((a) => a.wantsToStay), '«хочет остаться»')
    assert.ok(live.filter((a) => a.practiceSchool).length >= 2, 'практика от вуза')
    assert.ok(live.filter(inReserve).length >= 1, 'вид «Резерв» не пустой')

    // Согласие: форма, чат на сайте, бот, отклик на работном сайте, устно
    const sources = new Set(live.map((a) => a.consentSource))
    for (const s of ['site_form', 'site_chat', 'job_board', 'hr_verbal']) assert.ok(sources.has(s as never), `согласие: ${s}`)
    assert.ok(sources.has('telegram') || sources.has('max'), 'согласие в боте')

    // Пара с сайта, самозапись, подписка «Напомнить о наборе»
    assert.ok(pairIds(apps).size >= 2, 'пара по приглашению с сайта')
    assert.equal(live.filter((a) => a.interview?.selfBooked).length, 2, 'самозапись у двух собеседований')
    const [{ n: reminders }] = await sql<{ n: number }[]>`select count(*)::int as n from bot_users where remind_at is not null`
    assert.ok(reminders >= 2, `подписчиков напоминаний ${reminders}`)
    const [{ n: off }] = await sql<{ n: number }[]>`select count(*)::int as n from bot_users where remind_off_at is not null`
    assert.ok(off <= reminders)

    // «Воронка» за 30 дней по умолчанию: новые срезы не пустые
    const report = await funnelReport(sql, new Date(now - 30 * DAY), new Date(now), apps, now, { costs: null })
    const sum = (k: 'completed' | 'stayed') => report.rows.reduce((n, r) => n + (r[k] ?? 0), 0)
    assert.equal(sum('completed'), 2, '«Отработали сезон»')
    assert.ok(sum('stayed') >= 1, '«В штате или резерве»')
    assert.equal(report.leaves.length, 1, 'причина ухода')
    assert.ok(report.attendance.marked >= 5 && report.attendance.unmarked === 3, `явка ${JSON.stringify(report.attendance)}`)
    assert.ok(report.invites.length >= 3 && report.invites.some((r) => r.inviter), 'приглашения с именами пригласивших')
    assert.ok(report.caseMetrics.hireRate !== null && report.caseMetrics.averageAge !== null && report.caseMetrics.dropout !== null, 'цифры кейса')
    assert.ok(report.caseMetrics.averageAge! >= 18 && report.caseMetrics.averageAge! <= 26)

    // Ни следа проверок
    const dump = JSON.stringify([live.map((a) => [a.name, a.lastName, a.mentorName, a.consentBy, a.school]), await sql`select * from bot_users`])
    for (const word of ['probe', 'test', 'jury']) assert.ok(!dump.toLowerCase().includes(word), `в демо нет «${word}»`)
  })
})
