// Контракты пакета pages-chat для других пакетов и код приглашения браузера.
// request, myRefCode и inviteUrl, useSiteConfig, openKvasychChat(question?), слот /hr/poster, маршрут /consent.
// Запуск: pnpm test w1-pages-chat

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const src = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8')

// ── Код приглашения: src/lib/ref.ts работает в браузере, здесь — с подменёнными localStorage и адресом ──

const store = new Map<string, string>()
const g = globalThis as unknown as { localStorage: Storage; window: { location: { origin: string } } }
g.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
}
g.window = { location: { origin: 'https://season.example' } }

/** Свежий модуль ref.ts: код запоминается в модуле, поэтому каждому случаю — своя копия */
let copy = 0
const freshRef = () => import(`../../src/lib/ref.ts?copy=${++copy}`) as Promise<typeof import('../../src/lib/ref')>

const ALPHABET = /^[abcdefghjkmnpqrstuvwxyz23456789]{6}$/

test('myRefCode: 6 символов алфавита бота, один и тот же, хранится в localStorage', async () => {
  store.clear()
  const ref = await freshRef()
  const code = ref.myRefCode()
  assert.match(code, ALPHABET)
  assert.equal(ref.myRefCode(), code)
  assert.equal(store.get('ochakovo.ref'), code)
  // Новая загрузка страницы берёт код из хранилища
  assert.equal((await freshRef()).myRefCode(), code)
})

test('myRefCode: кривой код в хранилище заменяется новым', async () => {
  store.clear()
  store.set('ochakovo.ref', 'abc0l1')
  const code = (await freshRef()).myRefCode()
  assert.match(code, ALPHABET)
  assert.notEqual(code, 'abc0l1')
})

test('inviteUrl: ?src=ref_<код> на нужной странице, якорь сохраняется', async () => {
  store.clear()
  store.set('ochakovo.ref', 'kvas29')
  const ref = await freshRef()
  assert.equal(ref.inviteUrl(), 'https://season.example/?src=ref_kvas29')
  assert.equal(ref.inviteUrl('/#money'), 'https://season.example/?src=ref_kvas29#money')
  assert.equal(ref.inviteUrl('/game'), 'https://season.example/game?src=ref_kvas29')
})

test('invitedBy: чужой код засчитывается, свой — нет, другие метки — не приглашение', async () => {
  store.clear()
  store.set('ochakovo.ref', 'kvas29')
  const ref = await freshRef()
  assert.equal(ref.invitedBy('friend-mnpq23'), 'mnpq23')
  assert.equal(ref.invitedBy('friend-kvas29'), null, 'своя ссылка засчиталась')
  assert.equal(ref.invitedBy('fair-mgupp'), null)
  assert.equal(ref.invitedBy(null), null)
  assert.equal(ref.isOwnRefCode('kvas29'), true)
  assert.equal(ref.isOwnRefCode('mnpq23'), false)
  assert.equal(ref.refCodeFromSource('friend-mnpq23'), 'mnpq23')
  assert.equal(ref.refCodeFromSource('friend-'), null)
})

test('captureSource: своя ссылка ?src=ref_<код> не становится меткой friend-', () => {
  const source = src('lib/source.ts')
  assert.match(source, /isOwnRefCode\(ref\[1\]\) \? '' : `friend-\$\{ref\[1\]\}`/)
})

// ── Сигнатуры, на которые опираются другие пакеты ─────────────────────

test('request<T>(path, init) экспортируется из src/lib/api.ts', () => {
  assert.match(src('lib/api.ts'), /export async function request<T>\(path: string, init: RequestInit & \{ hr\?: boolean \} = \{\}\): Promise<T>/)
})

test('useSiteConfig и loadSiteConfig в src/lib/config.ts', () => {
  const config = src('lib/config.ts')
  assert.match(config, /export function loadSiteConfig\(\): Promise<SiteConfig \| null>/)
  assert.match(config, /export function useSiteConfig\(\): SiteConfig \| null/)
})

test('openKvasychChat(question?) и takePendingQuestion в src/components/chat/bus.ts', () => {
  const bus = src('components/chat/bus.ts')
  assert.match(bus, /export function openKvasychChat\(question\?: string\)/)
  // Событие клика вместо вопроса не принимается: только строка
  assert.match(bus, /typeof question === 'string'/)
  assert.match(bus, /export function takePendingQuestion\(\): string \| null/)
})

test('слот /hr/poster — без шапки сайта; /consent — внутри каркаса сайта, без входа', () => {
  const app = src('App.tsx')
  assert.match(src('pages/HrPoster.tsx'), /export function HrPoster\(\)/)
  const layoutAt = app.indexOf('<Route element={<Layout />}>')
  const poster = app.indexOf('path="hr/poster"')
  const consent = app.indexOf('path="consent"')
  assert.ok(poster > 0 && poster < layoutAt, '/hr/poster должен быть вне Layout')
  assert.ok(consent > layoutAt, '/consent должен быть внутри Layout')
  assert.match(app, /import\('\.\/pages\/Consent'\), 'Consent'/)
})
