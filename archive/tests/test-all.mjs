// Запускает все проверки проекта по очереди и падает, если упала хотя бы одна. Запуск: pnpm test
//
// 1. Каждый скрипт package.json вида "test:*" (сквозные test:e2e* — только по E2E=1 pnpm test).
// 2. Каждый файл scripts/tests/*.test.ts через tsx, по алфавиту. Файлы, имя которых начинается с «_» или «.», —
//    помощники (например, _db.ts с withTestDb), их не запускаем. Проверка считается упавшей при ненулевом коде выхода:
//    node:test и node:assert дают его сами.
//
// Выборочно: pnpm test core- hr — только проверки, в имени которых есть «core-» или «hr»

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
// Сквозные проверки в браузере идут минуту и больше — только по E2E=1 pnpm test
const e2e = process.env.E2E === '1'
const filters = process.argv.slice(2).filter(Boolean)
const wanted = (name) => !filters.length || filters.some((f) => name.includes(f))

const scripts = Object.keys(pkg.scripts).filter((n) => n.startsWith('test:') && (e2e || !n.startsWith('test:e2e')))
const testsDir = new URL('./tests/', import.meta.url)
const files = existsSync(testsDir)
  ? readdirSync(testsDir)
      .filter((f) => f.endsWith('.test.ts') && !f.startsWith('_') && !f.startsWith('.'))
      .sort()
  : []

const runs = [
  ...scripts.map((name) => ({ name, cmd: 'pnpm', args: ['-s', name] })),
  ...files.map((file) => ({ name: `tests/${file}`, cmd: process.execPath, args: ['--import', 'tsx', fileURLToPath(new URL(file, testsDir))] })),
].filter((r) => wanted(r.name))

const results = []
for (const r of runs) {
  console.log(`\n━━ ${r.name} ━━`)
  const started = Date.now()
  const run = spawnSync(r.cmd, r.args, { cwd: root, stdio: 'inherit', env: process.env })
  results.push({ name: r.name, ok: run.status === 0, sec: ((Date.now() - started) / 1000).toFixed(1) })
}

console.log('\nИтог:')
if (!e2e && pkg.scripts['test:e2e'] && !filters.length) console.log('  – test:e2e и test:e2e:webkit пропущены: запуск со сквозными проверками — E2E=1 pnpm test')
if (!runs.length) console.log(`  – по фильтру «${filters.join(' ')}» проверок нет`)
for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name} (${r.sec} с)`)
const failed = results.filter((r) => !r.ok)
if (failed.length) {
  console.log(`\nУпало: ${failed.map((r) => r.name).join(', ')}`)
  process.exit(1)
}
if (!runs.length) process.exit(1)
console.log('\nВсе проверки пройдены')
