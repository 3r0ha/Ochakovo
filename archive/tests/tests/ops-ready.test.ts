// Честная готовность и проверка настроек при старте: /api/health/ready отвечает 503 без движка диалогов
// и с упавшим ботом, рабочая версия не стартует без SITE_URL на https, при старте — одна строка-сводка.
// Запуск: pnpm test ops-ready (нужен PostgreSQL, базы создаются и удаляются сами)

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { get } from 'node:http'
import { createServer } from 'node:net'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createApp, siteUrlProblem } from '../../server/app'
import { loadAdapters, type Registry } from '../../server/channels/registry'
import { PostgresStorage } from '../../server/db'
import { HrRepo } from '../../server/db/hr'
import { createEngine } from '../../server/dialog/engine'
import { withTestDb } from './_db'

const root = fileURLToPath(new URL('../..', import.meta.url))
const quiet = { info() {}, warn() {}, error() {} }
const stub = (failed: string[] = []): Registry => ({ get: () => undefined, active: () => [], failed: () => failed, start() {} })
const env = { NODE_ENV: 'test', SITE_URL: 'https://season.example.ru' }

type Ready = { status: string; db: { ok: boolean }; engine: boolean; botsFailed: string[] }

test('SITE_URL в рабочей версии: только https, http — для localhost и 127.0.0.1', () => {
  const prod = (SITE_URL?: string) => siteUrlProblem({ NODE_ENV: 'production', ...(SITE_URL === undefined ? {} : { SITE_URL }) })
  assert.match(prod() ?? '', /нужен SITE_URL/)
  assert.match(prod('') ?? '', /нужен SITE_URL/)
  assert.match(prod('   ') ?? '', /нужен SITE_URL/)
  assert.match(prod('season.ochakovo.ru') ?? '', /не похож на адрес/)
  assert.match(prod('http://season.ochakovo.ru') ?? '', /https:\/\//)
  assert.match(prod('ftp://season.ochakovo.ru') ?? '', /https:\/\//)
  assert.equal(prod('https://season.ochakovo.ru'), null)
  assert.equal(prod('https://season.ochakovo.ru/'), null)
  assert.equal(prod('http://localhost:8787'), null)
  assert.equal(prod('http://127.0.0.1:5180'), null)
  // В разработке и в проверках адрес не обязателен
  assert.equal(siteUrlProblem({ NODE_ENV: 'test' }), null)
  assert.equal(siteUrlProblem({}), null)
})

test('/api/health/ready: 503 без движка и с упавшим ботом, 200 когда всё поднялось', async () => {
  await withTestDb('ops-ready', async (sql) => {
    // Сотрудник уже есть — createApp не заводит демо-администратора в фоне, пока база закрывается
    await new HrRepo(sql).createUser({ email: 'ops@ochakovo.test', name: 'Проверка', role: 'admin', passwordHash: 'x' })
    const storage = new PostgresStorage(sql)
    const engine = createEngine(storage, { siteUrl: env.SITE_URL })
    const ready = async (app: Awaited<ReturnType<typeof createApp>>) => {
      const res = await app.request('/api/health/ready')
      return { status: res.status, body: (await res.json()) as Ready, cache: res.headers.get('cache-control') }
    }

    const noEngine = await ready(await createApp({ storage, engine: null, bots: stub(), hrToken: '', env }))
    assert.equal(noEngine.status, 503, 'движок не загрузился — трафик не слать')
    assert.equal(noEngine.body.status, 'not_ready')
    assert.equal(noEngine.body.engine, false)
    assert.equal(noEngine.body.db.ok, true, 'база при этом отвечает')

    // Настоящий реестр: токен задан, а фабрика адаптера упала — сервер жив, бот в failed()
    const broken = await loadAdapters(
      { TELEGRAM_BOT_TOKEN: '123456:test' },
      {
        log: quiet,
        factories: {
          telegram: () => {
            throw new Error('адаптер упал')
          },
        },
      },
    )
    assert.deepEqual(broken.failed(), ['telegram'])
    const failedBot = await ready(await createApp({ storage, engine, bots: broken, hrToken: '', env }))
    assert.equal(failedBot.status, 503, 'включённый бот упал — готовность 503')
    assert.deepEqual(failedBot.body.botsFailed, ['telegram'])
    assert.equal(failedBot.body.engine, true)

    const ok = await ready(await createApp({ storage, engine, bots: stub(), hrToken: '', env }))
    assert.equal(ok.status, 200)
    assert.equal(ok.body.status, 'ready')
    assert.deepEqual(ok.body.botsFailed, [])
    assert.equal(ok.cache, 'no-store', 'готовность не кэшируется')

    // Для людей: упавший бот виден и в /api/health, но сайт живой — 200
    const health = await (await createApp({ storage, engine, bots: broken, hrToken: '', env })).request('/api/health')
    const body = (await health.json()) as { botsFailed: string[]; engine: boolean }
    assert.equal(health.status, 200)
    assert.deepEqual(body.botsFailed, ['telegram'])
    assert.equal(body.engine, true)
    // Фоновая проверка администратора у каждого createApp — даём ей закончить до удаления базы
    await new Promise((r) => setTimeout(r, 100))
  })
})

/** Запустить server/index.ts и дождаться выхода или нужной строки в журнале */
function runServer(extra: Record<string, string>, until?: (out: string) => boolean, timeoutMs = 30_000) {
  return new Promise<{ code: number | null; out: string; stop: () => Promise<number | null> }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      cwd: root,
      env: {
        ...process.env,
        // Пустые значения не даёт перезаписать .env: никаких ботов, GigaChat, Диска и SMS
        NODE_ENV: 'production',
        TELEGRAM_BOT_TOKEN: '',
        MAX_BOT_TOKEN: '',
        GIGACHAT_AUTH_KEY: '',
        YANDEX_DISK_TOKEN: '',
        YANDEX_DISK_REFRESH_TOKEN: '',
        SMS_PROVIDER: '',
        PUBLIC_URL: '',
        HR_TOKEN: '',
        ...extra,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let done = false
    const stop = () =>
      new Promise<number | null>((ok) => {
        if (child.exitCode !== null) return ok(child.exitCode)
        child.once('exit', (code) => ok(code))
        child.kill('SIGTERM')
      })
    const timer = setTimeout(() => {
      if (done) return
      done = true
      child.kill('SIGKILL')
      reject(new Error(`сервер не ответил за ${timeoutMs / 1000} с:\n${out}`))
    }, timeoutMs)
    const onData = (b: Buffer) => {
      out += b.toString()
      if (!done && until?.(out)) {
        done = true
        clearTimeout(timer)
        resolve({ code: null, out, stop })
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('exit', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code, out, stop })
    })
  })
}

test('рабочая версия без SITE_URL или с http-адресом не стартует: код 1 и понятное сообщение', async () => {
  // База не нужна: проверка идёт до подключения
  const empty = await runServer({ SITE_URL: '', DATABASE_URL: 'postgres://localhost:1/none' })
  assert.equal(empty.code, 1)
  assert.match(empty.out, /нужен SITE_URL/)

  const plain = await runServer({ SITE_URL: 'http://season.example.ru', DATABASE_URL: 'postgres://localhost:1/none' })
  assert.equal(plain.code, 1)
  assert.match(plain.out, /SITE_URL должен начинаться с https:\/\//)
})

test('недоступная база: код 1, адрес без пароля и подсказка', async () => {
  const res = await runServer({ SITE_URL: 'https://season.example.ru', DATABASE_URL: 'postgres://user:secret-password@127.0.0.1:1/ochakovo' })
  assert.equal(res.code, 1)
  assert.match(res.out, /База 127\.0\.0\.1:1\/ochakovo не отвечает/)
  assert.match(res.out, /APP_DATABASE_URL/)
  assert.doesNotMatch(res.out, /secret-password/, 'пароль базы в журнал не попадает')
})

const freePort = () =>
  new Promise<number>((resolve) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number }
      srv.close(() => resolve(port))
    })
  })

test('рабочая версия на http://localhost стартует, ready — 200, в журнале одна строка-сводка без секретов', async () => {
  await withTestDb('ops-start', async (_sql, url) => {
    const port = await freePort()
    const run = await runServer(
      {
        SITE_URL: `http://localhost:${port}`,
        PORT: String(port),
        DATABASE_URL: url,
        HR_ADMIN_EMAIL: 'ops-admin@ochakovo.test',
        HR_ADMIN_PASSWORD: 'ops-password-123456',
        HH_ACCESS_TOKEN: '',
        HH_REFRESH_TOKEN: '',
      },
      (out) => out.includes('"msg":"startup"'),
    )
    try {
      // Без keep-alive: открытое соединение задержало бы мягкую остановку сервера
      const ready = await new Promise<{ status: number; body: string }>((resolve, reject) =>
        get(`http://localhost:${port}/api/health/ready`, { agent: false }, (res) => {
          let body = ''
          res.on('data', (c) => (body += c))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
        }).on('error', reject),
      )
      assert.equal(ready.status, 200, ready.body)
      const lines = run.out.split('\n').filter((l) => l.includes('"msg":"startup"'))
      assert.equal(lines.length, 1, 'сводка — одной строкой')
      const summary = JSON.parse(lines[0]) as Record<string, unknown>
      assert.equal(summary.mode, 'production')
      assert.equal(summary.engine, true)
      assert.deepEqual(summary.bots, [])
      assert.deepEqual(summary.botsFailed, [])
      assert.equal(summary.assistant, 'offline')
      assert.equal(summary.siteUrl, `http://localhost:${port}`)
      assert.equal(typeof summary.retentionMonths, 'number')
      assert.doesNotMatch(lines[0], /ops-password|postgres:\/\//, 'ни паролей, ни адреса базы')
    } finally {
      assert.equal(await run.stop(), 0, 'мягкая остановка по SIGTERM')
    }
  })
})
