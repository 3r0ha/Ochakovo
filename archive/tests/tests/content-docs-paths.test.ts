// Пути в документах существуют: README.md и docs/*.md ссылаются только на настоящие файлы и папки.
// Проверяются пути в обратных кавычках (с «/» и расширением или из известной папки) и относительные ссылки Markdown.
// Маршруты сайта и API (/vacancies, /api/…), переменные окружения, адреса, шаблоны (*, <имя>, NNN) пропускаются.
// docs/plan.md и docs/case-delta.md не проверяются: это планы, они называют файлы, которые ещё предстоит создать.
// Запуск: pnpm test content-docs-paths (без базы)

import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { test } from 'node:test'

const root = join(import.meta.dirname, '..', '..')

/** Папки проекта: путь из такой папки проверяется, даже если у него нет расширения */
const KNOWN_DIRS = ['src', 'server', 'shared', 'scripts', 'docs', 'public', 'archive', 'photos-src', 'certs', '.github']
const EXT = /\.(ts|tsx|mjs|js|json|md|sql|sh|py|yml|yaml|svg|png|jpg|jpeg|webp|avif|css|html|ico|txt|example)$/i

/** {a,b} в пути → несколько путей: server/api/{hr-kb,booking}.ts */
function expandBraces(path: string): string[] {
  const m = path.match(/\{([^{}]+)\}/)
  if (!m) return [path]
  return m[1].split(',').flatMap((alt) => expandBraces(path.replace(m[0], alt.trim())))
}

/** Похоже ли слово на путь в проекте, который надо проверить */
function isCheckablePath(token: string): boolean {
  if (!token.includes('/')) return false
  if (token.startsWith('/') || token.startsWith('~')) return false // маршрут сайта или API, домашняя папка
  if (/^[a-z][a-z0-9+.-]*:/i.test(token)) return false // http:, disk:, vd:, postgres:
  if (/^[A-Z][A-Z0-9_]*(=|$)/.test(token)) return false // переменная окружения
  if (/[*<>…]|NNN|\.\.\.|\$\{|\$[A-Z]|=|\?|#|@/.test(token)) return false // шаблоны, параметры, якоря, пакеты
  if (/^[\w.-]+\.(ru|com|org|io|net|dev|app)\b/i.test(token)) return false // домены: hh.ru/…, developers.sber.ru/…
  const first = token.split('/')[0]
  return EXT.test(token.replace(/\/$/, '')) || KNOWN_DIRS.includes(first)
}

export type BrokenPath = { file: string; path: string }

/**
 * Пути из текста документа, которых нет в проекте. Пути в обратных кавычках — от корня проекта;
 * относительные ссылки Markdown — от папки документа
 */
export function brokenPaths(file: string, text: string, base = root): BrokenPath[] {
  const out: BrokenPath[] = []
  // Блоки кода целиком пропускаем: там команды и примеры вывода
  const prose = text.replace(/```[\s\S]*?```/g, '')
  for (const [, span] of prose.matchAll(/`([^`\n]+)`/g)) {
    for (const raw of span.split(/\s+/)) {
      const token = raw.replace(/^[(«"']+|[)»"',.:;]+$/g, '')
      if (!isCheckablePath(token)) continue
      for (const p of expandBraces(token)) if (!existsSync(join(base, p))) out.push({ file, path: p })
    }
  }
  for (const [, target] of prose.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^[a-z][a-z0-9+.-]*:|^#|^\//i.test(target)) continue
    const p = normalize(join(dirname(file), target.split('#')[0]))
    if (!existsSync(join(base, p))) out.push({ file, path: p })
  }
  return out
}

/** README.md и docs/*.md, кроме плана */
const docs = ['README.md', ...readdirSync(join(root, 'docs')).filter((f) => f.endsWith('.md') && !['plan.md', 'case-delta.md'].includes(f)).map((f) => `docs/${f}`)]

test('все пути в README и docs существуют', () => {
  const broken = docs.flatMap((f) => brokenPaths(f, readFileSync(join(root, f), 'utf8')))
  assert.deepEqual(broken, [], broken.map((b) => `${b.file}: ${b.path}`).join('\n'))
})

test('несуществующий путь роняет проверку, маршруты и переменные окружения — нет', () => {
  const sample = [
    'Данные — в `src/data/vacancies.ts`, игра — `src/game/InlineGame.tsx`.',
    'Страницы: `/vacancies`, `/apply`; API — `/api/hr/funnel?from=&to=`; база — `DATABASE_URL`, `HR_ADMIN_EMAIL`.',
    'Миграции — `server/db/migrations/NNN_*.sql`, адрес — `disk:/Очаково HR`, ссылка — `?src=fair-mgupp`.',
    'Заглушки `server/api/{hr-kb,booking,nope}.ts`, папка `public/mascot/`, команда `node scripts/nope.mjs /vacancies shot.png`.',
    'Ссылка [бриф](kvasych.md) и [нет такого](missing.md), сайт [hh](https://hh.ru/vacancy/1).',
    '```bash\npnpm test scripts/not-checked-inside-code.ts\n```',
  ].join('\n')
  const broken = brokenPaths('docs/sample.md', sample).map((b) => b.path)
  assert.deepEqual(broken.sort(), ['docs/missing.md', 'scripts/nope.mjs', 'server/api/nope.ts', 'src/data/vacancies.ts'])
})
