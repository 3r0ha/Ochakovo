// Развёртывание: docker-compose.yml (порты на 127.0.0.1, APP_DATABASE_URL, профиль local-db, пароль без значения
// по умолчанию), CI с заданиями check, e2e и docker, docs/deploy.md по факту. Контейнеры не запускаются:
// docker compose config только читает файл. Без Docker эта часть пропускается.
// Запуск: pnpm test ops-deploy

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const compose = readFileSync('docker-compose.yml', 'utf8')
const ci = readFileSync('.github/workflows/ci.yml', 'utf8')
const deploy = readFileSync('docs/deploy.md', 'utf8')

test('docker-compose.yml: порты только на 127.0.0.1, база по профилю, пароль без значения по умолчанию', () => {
  assert.match(compose, /- "127\.0\.0\.1:\$\{APP_PORT:-8787\}:8787"/)
  assert.match(compose, /- "127\.0\.0\.1:\$\{POSTGRES_PORT:-5432\}:5432"/)
  assert.doesNotMatch(compose, /^\s+- "\$\{?[A-Z_]*:?-?\d*\}?:\d+"/m, 'нет портов на всех адресах')
  assert.match(compose, /DATABASE_URL: \$\{APP_DATABASE_URL:-/)
  assert.match(compose, /profiles: \[local-db\]/)
  assert.match(compose, /required: false/)
  assert.doesNotMatch(compose, /POSTGRES_PASSWORD:-[^}]/, 'у пароля базы нет значения по умолчанию')
  assert.match(compose, /POSTGRES_PASSWORD:\?/)
})

function composeConfig(env: Record<string, string>, args: string[] = []) {
  // Пустой файл вместо .env: локальные настройки разработчика не влияют на проверку
  const dir = mkdtempSync(join(tmpdir(), 'ops-compose-'))
  const envFile = join(dir, 'empty.env')
  writeFileSync(envFile, '')
  try {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(APP_|POSTGRES_)/.test(k)))
    const run = spawnSync('docker', ['compose', '--env-file', envFile, ...args, 'config', '--format', 'json'], { env: { ...clean, ...env }, encoding: 'utf8' })
    return { code: run.status, out: run.stdout, err: run.stderr }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const hasCompose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0

test('docker compose config: APP_DATABASE_URL у app, db не нужна; без пароля — сообщение', { skip: !hasCompose && 'нет docker compose' }, () => {
  const url = 'postgres://ochakovo:secret@pg.example.ru:6432/ochakovo'
  const ext = composeConfig({ APP_DATABASE_URL: url })
  assert.equal(ext.code, 0, ext.err)
  const cfg = JSON.parse(ext.out) as { services: Record<string, { environment: Record<string, string>; ports: { host_ip: string; published: string }[] }> }
  assert.deepEqual(Object.keys(cfg.services), ['app'], 'без профиля local-db сервиса db нет')
  assert.equal(cfg.services.app.environment.DATABASE_URL, url)
  assert.deepEqual(cfg.services.app.ports.map((p) => [p.host_ip, p.published]), [['127.0.0.1', '8787']])

  const local = composeConfig({ POSTGRES_PASSWORD: 'local-pass' }, ['--profile', 'local-db'])
  assert.equal(local.code, 0, local.err)
  const lc = JSON.parse(local.out) as typeof cfg
  assert.deepEqual(Object.keys(lc.services).sort(), ['app', 'db'])
  assert.equal(lc.services.app.environment.DATABASE_URL, 'postgres://ochakovo:local-pass@db:5432/ochakovo')
  assert.ok(lc.services.db.ports.every((p) => p.host_ip === '127.0.0.1'), 'база тоже только на этой машине')

  for (const args of [[], ['--profile', 'local-db']]) {
    const none = composeConfig({}, args)
    assert.notEqual(none.code, 0, `без APP_DATABASE_URL и POSTGRES_PASSWORD compose ${args.join(' ')} не собирает конфиг`)
    assert.match(none.err, /задайте в \.env APP_DATABASE_URL .* или POSTGRES_PASSWORD/)
  }
})

test('CI: задания check, e2e и docker; e2e — PostgreSQL, Chromium, E2E_PG_URL, отчёт артефактом', () => {
  const jobs = [...ci.slice(ci.indexOf('\njobs:')).matchAll(/^ {2}([a-z0-9-]+):$/gm)].map((m) => m[1])
  assert.deepEqual(jobs, ['check', 'e2e', 'docker'])
  const e2e = ci.slice(ci.indexOf('\n  e2e:'), ci.indexOf('\n  docker:'))
  assert.match(e2e, /image: postgres:16/)
  assert.match(e2e, /E2E_PG_URL: postgres:\/\//)
  assert.match(e2e, /playwright install --with-deps chromium/)
  assert.match(e2e, /run: pnpm test:e2e/, 'та же команда, что в README')
  assert.match(e2e, /actions\/upload-artifact@v4/)
  assert.match(e2e, /if: always\(\)/)
  assert.match(e2e, /ochakovo-e2e-\*/, 'снимки упавших шагов')
  const readme = readFileSync('README.md', 'utf8')
  assert.match(readme, /pnpm test:e2e/)
})

test('docs/deploy.md по факту: compose, срок хранения и журнал удаления', () => {
  assert.doesNotMatch(deploy, /[Аа]втоматического удаления/, 'строки «автоматического удаления пока нет» больше нет')
  for (const s of ['APP_DATABASE_URL', 'POSTGRES_PASSWORD', '--profile local-db', 'RETENTION_MONTHS', 'журнал удаления', 'docker compose config', '/sitemap.xml', 'scripts/og.mjs'])
    assert.ok(deploy.includes(s), `в docs/deploy.md есть «${s}»`)
  // Команды compose в документе — с теми профилями, что есть в файле
  for (const m of deploy.matchAll(/--profile ([a-z-]+)/g)) assert.ok(compose.includes(`profiles: [${m[1]}]`), `профиль ${m[1]} есть в docker-compose.yml`)
  assert.doesNotMatch(deploy, /\b(19|20)\d\d\b/, 'дат в документе нет')
})
