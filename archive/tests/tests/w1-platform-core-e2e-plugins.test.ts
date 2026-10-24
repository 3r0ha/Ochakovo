// Сценарии-плагины e2e: scripts/e2e.ts подхватывает scripts/e2e/<имя>.ts по алфавиту и отдаёт им общий E2eHarness.
// Здесь — загрузчик без браузера: порядок, пропуск «_» и «.», фильтр E2E_ONLY, сломанный плагин не роняет остальные.
// Запуск: pnpm test w1-platform-core-e2e

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pluginFiles, pluginScenarios, Scenario, type E2eHarness } from '../e2e/_harness'

/** Папка с плагинами-образцами: каждый пишет, что получил, в общий журнал h */
function fixtures() {
  const dir = mkdtempSync(join(tmpdir(), 'ochakovo-core-e2e-'))
  const plugin = (body: string) => `export default async (h) => {\n${body}\n}\n`
  writeFileSync(
    join(dir, 'b-second.ts'),
    plugin(`h.seen.push('b:' + h.baseUrl)
  const s = new h.Scenario('b: сценарий')
  await s.step('шаг', async () => {})
  return [s]`),
  )
  writeFileSync(
    join(dir, 'a-first.ts'),
    plugin(`h.seen.push('a:' + h.dbUrl)
  const one = new h.Scenario('a: первый')
  const two = new h.Scenario('a: второй', true)
  await one.step('проходит', async () => {})
  await two.step('падает', async () => { throw new Error('ожидаемая ошибка') })
  await two.step('независимый идёт дальше', async () => {})
  return [one, two]`),
  )
  writeFileSync(join(dir, '_helper.ts'), `throw new Error('помощник не должен загружаться')\n`)
  writeFileSync(join(dir, '.hidden.ts'), `throw new Error('скрытый файл не должен загружаться')\n`)
  writeFileSync(join(dir, 'c-no-default.ts'), `export const x = 1\n`)
  writeFileSync(join(dir, 'd-not-scenarios.ts'), plugin(`return [{ name: 'подделка' }]`))
  writeFileSync(join(dir, 'e-throws.ts'), plugin(`throw new Error('плагин упал при запуске')`))
  writeFileSync(join(dir, 'notes.md'), '# не плагин\n')
  return dir
}

const harness = () => ({ Scenario, baseUrl: 'http://localhost:1', dbUrl: 'postgres://x/ochakovo_e2e_1', seen: [] as string[] }) as unknown as E2eHarness & { seen: string[] }

test('плагины по алфавиту, без «_» и «.»; все получают один и тот же сервер и базу', async () => {
  const dir = fixtures()
  try {
    assert.deepEqual(
      pluginFiles(dir).map((f) => f.name),
      ['a-first', 'b-second', 'c-no-default', 'd-not-scenarios', 'e-throws'],
    )
    const h = harness()
    const list = await pluginScenarios(h, dir)
    assert.deepEqual(h.seen, ['a:postgres://x/ochakovo_e2e_1', 'b:http://localhost:1'])
    assert.deepEqual(
      list.map((s) => [s.name, s.ok]),
      [
        ['a: первый', true],
        ['a: второй', false],
        ['b: сценарий', true],
        ['c-no-default: плагин', false],
        ['d-not-scenarios: плагин', false],
        ['e-throws: плагин', false],
      ],
    )
    // Независимый сценарий проверяет все шаги, даже после упавшего
    assert.equal(list[1].lines.length, 2)
    assert.match(list[1].lines[0], /✗ падает/)
    assert.match(list[1].lines[1], /✓ независимый идёт дальше/)
    // Сломанные плагины объясняют, что не так
    assert.match(list[3].lines.join('\n'), /нет export default/)
    assert.match(list[4].lines.join('\n'), /не массив Scenario/)
    assert.match(list[5].lines.join('\n'), /плагин упал при запуске/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('фильтр E2E_ONLY: только названные плагины; пустая или несуществующая папка — ничего', async () => {
  const dir = fixtures()
  try {
    const h = harness()
    const only = new Set(['b-second'])
    const list = await pluginScenarios(h, dir, (name) => only.has(name))
    assert.deepEqual(
      list.map((s) => s.name),
      ['b: сценарий'],
    )
    assert.deepEqual(h.seen, ['b:http://localhost:1'])
    assert.deepEqual(await pluginScenarios(h, join(dir, 'нет-такой')), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
