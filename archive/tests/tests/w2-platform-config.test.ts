// Зависимости и настройки (w2-pl-1, w2-pl-c2): GSAP убран из package.json, lockfile и сборки — вместо vendor-gsap
// чанк vendor-lenis; каждая переменная окружения, которую читает сервер, описана в .env.example, у GigaChat —
// адрес API и число одновременных запросов с теми же значениями, что по умолчанию в коде.
// Запуск: pnpm test w2-platform-config

import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const read = (p: string) => readFileSync(p, 'utf8')

/** Все файлы .ts, .tsx и .mjs в папках, без node_modules */
function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) files(p, out)
    else if (/\.(ts|tsx|mjs)$/.test(name)) out.push(p)
  }
  return out
}

test('GSAP: ни импортов, ни зависимости, ни чанка vendor-gsap', () => {
  const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> }
  for (const name of ['gsap', '@gsap/react']) {
    assert.ok(!(name in pkg.dependencies) && !(name in pkg.devDependencies), `${name} в package.json`)
  }
  assert.doesNotMatch(read('pnpm-lock.yaml'), /gsap/, 'в pnpm-lock.yaml не осталось gsap')
  for (const file of [...files('src'), ...files('server'), ...files('shared')]) {
    assert.doesNotMatch(read(file), /from ['"](gsap|@gsap\/react)['"/]|import\(['"]gsap/, `${file}: импорт gsap`)
  }
  const vite = read('vite.config.ts')
  assert.doesNotMatch(vite, /vendor-gsap|gsap/, 'в vite.config.ts нет группы GSAP')
  assert.match(vite, /name: 'vendor-lenis', test: \/node_modules\[\\\\\/\]lenis\[\\\\\/\]\//, 'Lenis — своим чанком')
})

test('.env.example: GIGACHAT_BASE_URL и GIGACHAT_CONCURRENCY с умолчаниями из кода', () => {
  const env = read('.env.example')
  const value = (name: string) => new RegExp(`^${name}=(.*)$`, 'm').exec(env)?.[1]
  const giga = read('server/llm/gigachat.ts')
  assert.equal(value('GIGACHAT_BASE_URL'), '', 'пусто — адрес по умолчанию')
  const base = /baseUrl: '([^']+)'/.exec(giga)?.[1]
  assert.ok(base && env.includes(base), `в комментарии — адрес по умолчанию ${base}`)
  assert.equal(value('GIGACHAT_CONCURRENCY'), '1', 'физлицам разрешён один запрос')
  assert.match(giga, /concurrency: Number\(env\.GIGACHAT_CONCURRENCY\) \|\| 1/)
  assert.equal(value('METRIKA_ID'), '')
  assert.equal(value('VK_PIXEL_ID'), '')
})

test('.env.example описывает каждую переменную, которую читает сервер', () => {
  const documented = new Set([...read('.env.example').matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]))
  // Служебные: режим запуска, версия из CI, подмена адресов API в проверках, прежнее имя, папка сборки для проверок
  const internal = new Set(['NODE_ENV', 'APP_VERSION', 'HH_API_URL', 'SMS_API_URL', 'VITE_METRIKA_ID', 'DIST_DIR'])
  const used = new Set<string>()
  for (const file of files('server')) {
    for (const m of read(file).matchAll(/\benv\.([A-Z][A-Z0-9_]{2,})\b/g)) used.add(m[1])
  }
  const missing = [...used].filter((v) => !documented.has(v) && !internal.has(v)).sort()
  assert.deepEqual(missing, [], `нет в .env.example: ${missing.join(', ')}`)
  const deploy = read('docs/deploy.md')
  for (const v of ['GIGACHAT_BASE_URL', 'GIGACHAT_CONCURRENCY', 'METRIKA_ID', 'VK_PIXEL_ID']) assert.ok(deploy.includes(`\`${v}\``), `docs/deploy.md: ${v}`)
})
