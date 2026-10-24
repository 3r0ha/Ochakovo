// Миграция 012: новые поля заявок и собеседований, перенос согласия у старых строк, ограничения и перевод в HrApplication.
// Запуск: pnpm test core-migration (нужен PostgreSQL, база создаётся и удаляется сама)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { migrate } from '../../server/db'
import { WorkflowRepo } from '../../server/db/workflow'
import { withTestDb } from './_db'

const hours = (h: number) => new Date(Date.now() - h * 3600e3)

test('012 на базе со старыми заявками: согласие по каналу, поля по умолчанию, перевод в HrApplication', async () => {
  await withTestDb(
    'core-m012',
    async (sql) => {
      // Заявки до 012: с сайта, из ботов и добавленная HR
      const old = [
        { id: 'T012WEB', channel: 'web', created: hours(30) },
        { id: 'T012TG', channel: 'telegram', created: hours(20) },
        { id: 'T012MAX', channel: 'max', created: hours(10) },
        { id: 'T012HR', channel: 'hr', created: hours(5) },
      ]
      for (const a of old) await sql`insert into applications (id, channel, name, created_at) values (${a.id}, ${a.channel}, ${'Проверка'}, ${a.created})`
      await sql`insert into interviews (application_id, starts_at) values ('T012WEB', ${hours(-24)})`

      await migrate(sql, { quiet: true })

      const rows = await sql<{ id: string; created_at: Date; consent_at: Date | null; consent_version: string; consent_source: string }[]>`
        select id, created_at, consent_at, consent_version, consent_source from applications order by id`
      const by = new Map(rows.map((r) => [r.id, r]))
      for (const [id, source] of [['T012WEB', 'site_form'], ['T012TG', 'telegram'], ['T012MAX', 'max'], ['T012HR', 'none']] as const) {
        const r = by.get(id)!
        assert.equal(r.consent_version, '0', `${id}: версия согласия старой строки`)
        assert.equal(r.consent_source, source, `${id}: источник согласия по каналу`)
        if (source === 'none') assert.equal(r.consent_at, null, `${id}: у добавленной HR согласия нет`)
        else assert.equal(r.consent_at?.getTime(), r.created_at.getTime(), `${id}: время согласия — время заявки`)
      }

      // Перевод в HrApplication: новые поля с пустыми значениями, явка и самозапись у собеседования
      const app = await new WorkflowRepo(sql).get('T012WEB')
      assert.ok(app)
      assert.equal(app.consentSource, 'site_form')
      assert.equal(app.consentVersion, '0')
      assert.equal(app.refCode, null)
      assert.equal(app.practiceSchool, false)
      assert.equal(app.wantsToStay, false)
      assert.equal(app.suspectedSpam, false)
      assert.equal(app.onboardingAt, null)
      assert.equal(app.firstShiftAt, null)
      assert.equal(app.shiftKind, '')
      assert.equal(app.onboardingNote, '')
      assert.equal(app.seasonOutcome, '')
      assert.equal(app.seasonLeaveReason, '')
      assert.equal(app.reserve, false)
      assert.equal(app.botChannel, null)
      assert.equal(app.botUserId, null)
      assert.equal(app.interview?.attended, '')
      assert.equal(app.interview?.attendedAt, null)
      assert.equal(app.interview?.selfBooked, false)
      assert.ok(!('botLinkHash' in app), 'хеш ссылки на бота не выходит из базы')

      // Заполненные поля HR доходят до HrApplication
      await sql`
        update applications set onboarding_at = now(), first_shift_at = now() + interval '3 days', shift_kind = 'night', onboarding_note = 'медкомиссия',
          season_outcome = 'left', season_leave_reason = 'study', reserve = true, suspected_spam = true, bot_channel = 'telegram', bot_user_id = '42',
          practice_school = true, wants_to_stay = true, ref_code = 'abc234'
        where id = 'T012WEB'`
      await sql`update interviews set attended = 'yes', attended_at = now(), self_booked = true where application_id = 'T012WEB'`
      const filled = (await new WorkflowRepo(sql).get('T012WEB'))!
      assert.equal(filled.shiftKind, 'night')
      assert.equal(filled.onboardingNote, 'медкомиссия')
      assert.equal(filled.seasonOutcome, 'left')
      assert.equal(filled.seasonLeaveReason, 'study')
      assert.equal(filled.reserve, true)
      assert.equal(filled.suspectedSpam, true)
      assert.equal(filled.botChannel, 'telegram')
      assert.equal(filled.botUserId, '42')
      assert.equal(filled.practiceSchool, true)
      assert.equal(filled.wantsToStay, true)
      assert.equal(filled.refCode, 'abc234')
      assert.ok(filled.onboardingAt && filled.firstShiftAt)
      assert.equal(filled.interview?.attended, 'yes')
      assert.equal(filled.interview?.selfBooked, true)
      assert.ok(filled.interview?.attendedAt)
    },
    { migrate: 11 },
  )
})

test('012: код приглашения уникален, пустых может быть сколько угодно; неизвестные значения отклоняются', async () => {
  await withTestDb('core-m012-rules', async (sql) => {
    const add = (id: string, extra: Record<string, unknown> = {}) => sql`insert into applications ${sql({ id, name: 'Проверка', ...extra })}`
    await add('T012A', { ref_code: 'abc234' })
    await add('T012B')
    await add('T012C')
    await assert.rejects(add('T012D', { ref_code: 'abc234' }), (e: { code?: string }) => e.code === '23505', 'второй такой же код')
    await assert.rejects(add('T012E', { consent_source: 'email' }), (e: { code?: string }) => e.code === '23514', 'неизвестный источник согласия')
    await assert.rejects(add('T012F', { shift_kind: 'evening' }), (e: { code?: string }) => e.code === '23514', 'неизвестный вид смены')
    await assert.rejects(add('T012G', { season_outcome: 'fired' }), (e: { code?: string }) => e.code === '23514', 'неизвестный итог сезона')
    await assert.rejects(add('T012H', { season_leave_reason: 'health' }), (e: { code?: string }) => e.code === '23514', 'неизвестная причина ухода')
    await assert.rejects(add('T012I', { bot_channel: 'whatsapp' }), (e: { code?: string }) => e.code === '23514', 'неизвестный мессенджер')
    await assert.rejects(
      sql`insert into interviews (application_id, starts_at, attended) values ('T012A', now(), 'maybe')`,
      (e: { code?: string }) => e.code === '23514',
      'неизвестная отметка явки',
    )
    // Новая заявка без согласия: источник none, время пустое
    const [row] = await sql<{ consent_source: string; consent_at: Date | null }[]>`select consent_source, consent_at from applications where id = 'T012B'`
    assert.equal(row.consent_source, 'none')
    assert.equal(row.consent_at, null)
  })
})
