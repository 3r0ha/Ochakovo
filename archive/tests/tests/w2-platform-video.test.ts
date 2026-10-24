// Раздача роликов «Смена изнутри» (w2-pl-c1): Range с 206 для Safari, 416 за пределами файла, If-Range и 304,
// верный Content-Type без сжатия, долгий кэш, media-src в CSP; ролики попадают в Docker-образ; бюджет размера.
// Сервер собирается на временной папке сборки с настоящим роликом из public/video.
// Запуск: pnpm test w2-platform-video (нужен PostgreSQL, база создаётся и удаляется сама)

import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createApp } from '../../server/app'
import { loadAdapters } from '../../server/channels/registry'
import { PostgresStorage } from '../../server/db'
import { HrRepo } from '../../server/db/hr'
import { parseRange, VIDEO_CACHE, VIDEO_CACHE_VERSIONED } from '../../server/middleware/video'
import { withTestDb } from './_db'

type Manifest = { videos: { id: string; files: Record<string, string>; poster: Record<string, Record<string, string>> }[] }
const manifest = JSON.parse(readFileSync('public/video/manifest.json', 'utf8')) as Manifest

test('parseRange: один диапазон, хвост, открытый конец, за пределами файла, мусор', () => {
  assert.deepEqual(parseRange('bytes=0-1', 100), { start: 0, end: 1 }, 'первый запрос Safari')
  assert.deepEqual(parseRange('bytes=10-', 100), { start: 10, end: 99 })
  assert.deepEqual(parseRange('bytes=-30', 100), { start: 70, end: 99 })
  assert.deepEqual(parseRange('bytes=-300', 100), { start: 0, end: 99 }, 'хвост длиннее файла — весь файл')
  assert.deepEqual(parseRange('bytes=90-500', 100), { start: 90, end: 99 }, 'конец за файлом — до конца файла')
  assert.equal(parseRange('bytes=100-', 100), 'unsatisfiable')
  assert.equal(parseRange('bytes=-0', 100), 'unsatisfiable')
  assert.equal(parseRange(undefined, 100), null)
  assert.equal(parseRange('bytes=5-1', 100), null, 'конец раньше начала — заголовок не понят, весь файл')
  assert.equal(parseRange('bytes=0-1,5-9', 100), null, 'несколько диапазонов — весь файл')
  assert.equal(parseRange('items=0-1', 100), null)
})

test('бюджет: 720p до 4 МБ, 480p до 2 МБ, все ролики вместе с постерами до 20 МБ', () => {
  assert.ok(manifest.videos.length >= 3, 'ролики есть в манифесте')
  let total = 0
  for (const v of manifest.videos) {
    for (const [q, url] of Object.entries(v.files)) {
      const bytes = statSync(`public${url}`).size
      assert.ok(url.endsWith('.mp4'), url)
      assert.ok(bytes <= (q === '720' ? 4 : 2) * 1_000_000, `${url}: ${(bytes / 1e6).toFixed(2)} МБ`)
    }
  }
  for (const f of readdirSync('public/video')) total += statSync(`public/video/${f}`).size
  assert.ok(total <= 20_000_000, `public/video: ${(total / 1e6).toFixed(1)} МБ`)
})

test('Docker: ролики собираются в dist/video и попадают в образ одной копией', () => {
  const docker = readFileSync('Dockerfile', 'utf8')
  const ignore = readFileSync('.dockerignore', 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  for (const p of ignore) assert.ok(!/^(public|public\/video|\*\.mp4|\*\*\/\*\.mp4|video)\/?$/.test(p), `.dockerignore не отрезает ролики: ${p}`)
  assert.match(docker, /COPY --from=build \/app\/dist \.\/dist/, 'сборка с dist/video — в рабочем образе')
  assert.match(docker, /find dist\/video -name '\*\.mp4'/, 'сборка падает, если роликов в dist нет')
  assert.match(docker, /COPY --from=build \/app\/public-runtime \.\/public/, 'public без второй копии роликов')
  assert.doesNotMatch(docker, /^COPY public /m, 'public целиком с роликами в образ не копируется')
  const vite = readFileSync('vite.config.ts', 'utf8')
  assert.doesNotMatch(vite, /copyPublicDir:\s*false/, 'Vite копирует public в dist')
})

test('сервер: Range и 206, 416, HEAD, If-Range, 304, тип и кэш без сжатия, CSP', async () => {
  const video = manifest.videos[0]
  const src = `public${video.files['480']}`
  const name = video.files['480'].replace('/video/', '')
  const posterUrl = video.poster.webp['640']
  const raw = readFileSync(src)
  const size = raw.length
  const dist = mkdtempSync(join(tmpdir(), 'w2-platform-video-'))
  try {
    writeFileSync(join(dist, 'index.html'), '<!doctype html><html><head><title>Проверка</title></head><body><div id="root"></div></body></html>')
    mkdirSync(join(dist, 'video'))
    copyFileSync(src, join(dist, 'video', name))
    copyFileSync(`public${posterUrl}`, join(dist, posterUrl))
    await withTestDb('w2-platform-video', async (sql) => {
      await new HrRepo(sql).createUser({ email: 'video@ochakovo.test', name: 'Проверка', role: 'admin', passwordHash: 'x' })
      const app = await createApp({ storage: new PostgresStorage(sql), engine: null, bots: await loadAdapters({}), hrToken: '', env: { NODE_ENV: 'test' }, distDir: dist })
      const get = (headers: Record<string, string> = {}, path = `/video/${name}`, method = 'GET') => app.request(path, { method, headers })
      const bytes = async (r: Response) => Buffer.from(await r.arrayBuffer())

      // Весь файл: тип, длина, Accept-Ranges, без сжатия даже при gzip и br
      const full = await get({ 'accept-encoding': 'gzip, deflate, br, zstd' })
      assert.equal(full.status, 200)
      assert.equal(full.headers.get('content-type'), 'video/mp4')
      assert.equal(full.headers.get('accept-ranges'), 'bytes')
      assert.equal(full.headers.get('content-length'), String(size))
      assert.equal(full.headers.get('content-encoding'), null, 'MP4 не сжимается')
      assert.equal(full.headers.get('cache-control'), VIDEO_CACHE)
      assert.match(full.headers.get('cache-control') ?? '', /max-age=(\d+)/)
      assert.ok(Number(/max-age=(\d+)/.exec(full.headers.get('cache-control')!)![1]) >= 30 * 86400, 'кэш не меньше 30 дней')
      assert.match(full.headers.get('cache-control') ?? '', /no-transform/)
      assert.ok((await bytes(full)).equals(raw), 'тело — файл целиком')
      const csp = full.headers.get('content-security-policy') ?? ''
      assert.match(csp, /media-src 'self'/, 'CSP разрешает ролики со своего сайта')
      const etag = full.headers.get('etag')!
      assert.match(etag, /^"[0-9a-z]+-[0-9a-z]+"$/)

      // Safari: сначала bytes=0-1, потом кусками
      const probe = await get({ range: 'bytes=0-1' })
      assert.equal(probe.status, 206)
      assert.equal(probe.headers.get('content-range'), `bytes 0-1/${size}`)
      assert.equal(probe.headers.get('content-length'), '2')
      assert.equal(probe.headers.get('content-type'), 'video/mp4')
      assert.ok((await bytes(probe)).equals(raw.subarray(0, 2)))
      const middle = await get({ range: `bytes=1000-${size - 1001}`, 'accept-encoding': 'gzip' })
      assert.equal(middle.status, 206)
      assert.equal(middle.headers.get('content-encoding'), null, 'кусок не сжимается')
      assert.ok((await bytes(middle)).equals(raw.subarray(1000, size - 1000)))
      const tail = await get({ range: 'bytes=-500' })
      assert.equal(tail.headers.get('content-range'), `bytes ${size - 500}-${size - 1}/${size}`)
      assert.ok((await bytes(tail)).equals(raw.subarray(size - 500)))
      const open = await get({ range: `bytes=${size - 10}-` })
      assert.equal(open.status, 206)
      assert.equal((await bytes(open)).length, 10)

      // За пределами файла — 416 с размером
      const beyond = await get({ range: `bytes=${size}-` })
      assert.equal(beyond.status, 416)
      assert.equal(beyond.headers.get('content-range'), `bytes */${size}`)

      // HEAD — только заголовки
      const head = await get({}, `/video/${name}`, 'HEAD')
      assert.equal(head.status, 200)
      assert.equal(head.headers.get('content-length'), String(size))
      assert.equal(head.headers.get('accept-ranges'), 'bytes')

      // If-Range: тот же файл — кусок, другой — весь файл
      const same = await get({ range: 'bytes=0-9', 'if-range': etag })
      assert.equal(same.status, 206)
      const changed = await get({ range: 'bytes=0-9', 'if-range': '"other-file"' })
      assert.equal(changed.status, 200)
      assert.equal(changed.headers.get('content-length'), String(size))
      await changed.body?.cancel()

      // Повторный запрос из кэша браузера — 304 без тела
      const cached = await get({ 'if-none-match': etag })
      assert.equal(cached.status, 304)
      assert.equal((await bytes(cached)).length, 0)
      const since = await get({ 'if-modified-since': full.headers.get('last-modified')! })
      assert.equal(since.status, 304)

      // С версией в адресе — год и immutable
      const versioned = await get({}, `/video/${name}?v=abc123`)
      assert.equal(versioned.headers.get('cache-control'), VIDEO_CACHE_VERSIONED)
      await versioned.body?.cancel()

      // Постер — картинка с тем же кэшем
      const poster = await get({}, posterUrl)
      assert.equal(poster.status, 200)
      assert.equal(poster.headers.get('content-type'), 'image/webp')
      assert.equal(poster.headers.get('cache-control'), VIDEO_CACHE)
      await poster.body?.cancel()

      // Нет файла, чужие пути и обход папок — честный 404, а не страница
      for (const path of ['/video/nope.mp4', '/video/..%2Findex.html', '/video/%2e%2e%2Findex.html', '/video/.hidden.mp4']) {
        const res = await get({}, path)
        assert.equal(res.status, 404, path)
        assert.doesNotMatch(await res.text(), /<div id="root">/, `${path}: не страница сайта`)
      }
    })
  } finally {
    rmSync(dist, { recursive: true, force: true })
  }
})
