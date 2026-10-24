// Макеты кампании: обложки коротких роликов (docs/brand/clips/), стенд на ярмарке (docs/brand/stand/),
// раскадровка ролика о компании (docs/brand/video/storyboard.html). Тексты совпадают со сценариями и данными сайта,
// файлы на месте и локальные, обложки — ровно 1080 × 1920, суммы — только официальные. Скрипты макетов — только
// отдельными файлами: сайт отдаёт /materials/… с CSP script-src 'self', встроенный скрипт там не выполнится.
// Запуск: pnpm test c3-brand-layouts (без базы и браузера)

import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { test } from 'node:test'
import sharp from 'sharp'
import { dorm } from '../../shared/content/handbook'
import { maxEntryPay, minMonthlyPay } from '../../shared/content/vacancies'

const root = join(import.meta.dirname, '..', '..')
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')
const rub = (n: number) => n.toLocaleString('ru-RU').replace(/\s/g, ' ')
const unquote = (s: string) => s.replace(/^«|»$/g, '')

/** Все ссылки страницы на файлы существуют, внешних адресов нет */
function localRefs(rel: string) {
  const src = read(rel)
  const code = src.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  assert.ok(!/https?:\/\//.test(code), `${rel}: внешний адрес`)
  const refs = [
    ...src.matchAll(/(?:src|href)="([^"#$]+)"/g),
    ...src.matchAll(/url\(([^)#]+)\)/g),
    ...src.matchAll(/'((?:\.\.\/)+[^']+\.(?:webp|svg|jpg|png|woff2))'/g),
  ].map((m) => m[1].replace(/^['"]|['"]$/g, ''))
  // Пути из данных скрипта: P + 'hero-line-1600.webp', F + 'lab-quality.webp'
  const P = /const P = '([^']+)'/.exec(src)?.[1]
  const F = /const F = '([^']+)'/.exec(src)?.[1]
  for (const m of src.matchAll(/\b([PF]) \+ '([^']+)'/g)) refs.push((m[1] === 'P' ? P : F) + m[2])
  for (const ref of refs) assert.ok(existsSync(join(root, normalize(join(dirname(rel), ref)))), `${rel}: нет файла ${ref}`)
  return src
}

/** Все HTML-макеты в docs/brand */
function layouts(dir = 'docs/brand'): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? layouts(`${dir}/${e.name}`) : e.name.endsWith('.html') ? [`${dir}/${e.name}`] : [],
  )
}

test('макеты без встроенных скриптов и обработчиков: CSP сайта их не выполняет', () => {
  const files = layouts()
  assert.ok(files.length >= 8, `макетов ${files.length}`)
  for (const rel of files) {
    const html = read(rel).replace(/<!--[\s\S]*?-->/g, '')
    for (const [tag] of html.matchAll(/<script\b[^>]*>/gi)) {
      const src = /\ssrc="([^"]+)"/.exec(tag)?.[1]
      assert.ok(src, `${rel}: встроенный скрипт ${tag}`)
      assert.ok(existsSync(join(root, normalize(join(dirname(rel), src)))), `${rel}: нет файла ${src}`)
    }
    // Тело <script src> пустое
    for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) assert.equal(m[1].trim(), '', `${rel}: код внутри <script src>`)
    // onclick=, onchange=, onload= … и javascript: в ссылках
    const handler = /<[a-z][^>]*\son[a-z]+\s*=/i.exec(html)
    assert.equal(handler, null, `${rel}: встроенный обработчик ${handler?.[0]}`)
    assert.ok(!/href="javascript:/i.test(html), `${rel}: javascript: в ссылке`)
    assert.ok(!/document\.write/.test(html), `${rel}: document.write`)
  }
  // Ловит нарушения на примере
  assert.match('<input type="checkbox" onchange="x()">', /<[a-z][^>]*\son[a-z]+\s*=/i)
})

test('обложки: вопросы первого кадра — из сценариев роликов, 14 файлов 1080 × 1920', async () => {
  // Данные обложек — в covers.js рядом с макетом
  const src = localRefs('docs/brand/clips/covers.html') + localRefs('docs/brand/clips/covers.js')
  const clips = read('docs/brand/clips.md')
  // Строки сценариев: | 01 | рубрика | первый кадр | …
  const plan = new Map([...clips.matchAll(/^\| (\d\d) \| ([^|]+) \| ([^|]+) \|/gm)].map((m) => [m[1], { rubric: unquote(m[2].trim()), first: unquote(m[3].trim()) }]))
  assert.equal(plan.size, 12)
  const covers = [...src.matchAll(/\{ n: '(\d\d)', rubric: '([^']+)', hook: '([^']+)'/g)].map((m) => ({ n: m[1], rubric: m[2], hook: m[3] }))
  assert.equal(covers.length, 12)
  for (const c of covers) {
    const p = plan.get(c.n)!
    // У шаблона «Сколько я заработал за лето» сумму называет герой — на обложке для неё место
    if (c.n === '06') assert.match(p.first, /Сумма/)
    else assert.equal(c.hook, p.first, `обложка ${c.n}`)
    if (!['06', '12'].includes(c.n)) assert.equal(c.rubric, p.rubric, `рубрика ${c.n}`)
  }
  for (const s of ['56 000', '70 000', '60 000', '3 400']) assert.ok(src.includes(s), s)
  assert.ok(src.includes(rub(minMonthlyPay)) && src.includes(rub(maxEntryPay)) && src.includes(rub(dorm.priceStudent)))
  // Готовые файлы
  const dir = 'docs/brand/clips/covers'
  const files = readdirSync(join(root, dir)).sort()
  assert.deepEqual(files, [...covers.map((c) => `clip-${c.n}.webp`), 'template-end.webp', 'template-subtitles.webp'].sort())
  for (const f of files) {
    const meta = await sharp(join(root, dir, f)).metadata()
    assert.deepEqual([meta.width, meta.height], [1080, 1920], f)
    assert.ok(statSync(join(root, dir, f)).size < 300_000, `${f} тяжелее 300 КБ`)
  }
})

test('стенд: ролл-ап 850 × 2000 мм и табличка A4 — официальные суммы, с 18 лет, QR по метке, вылеты по классу', () => {
  const rollup = localRefs('docs/brand/stand/rollup.html')
  const tent = localRefs('docs/brand/stand/table-tent.html')
  localRefs('docs/brand/stand/stand.css')
  assert.match(rollup, /@page \{\s*size: 850mm 2000mm;/)
  assert.match(tent, /@page \{\s*size: A4;/)
  for (const [name, html] of [['ролл-ап', rollup], ['табличка', tent]] as const) {
    const text = html.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ')
    assert.match(text, /18 лет/, `${name}: возраст`)
    assert.match(text, /QR/, `${name}: QR`)
    // Суммы — только из данных сайта: оплачиваемая практика и общежитие для студентов
    const sums = [...text.matchAll(/(\d{1,3}(?: \d{3})+) ₽|(\d{1,3}(?: \d{3})+) до (\d{1,3}(?: \d{3})+) ₽/g)].flatMap((m) => m.slice(1).filter(Boolean))
    for (const s of sums) assert.ok([rub(minMonthlyPay), rub(maxEntryPay), rub(dorm.priceStudent)].includes(s), `${name}: сумма ${s}`)
    assert.ok(!/!|\.\.\.|…/.test(text.replace(/«[^»]*»/g, '')), `${name}: «!» или многоточие`)
  }
  assert.match(rollup, /Квас делают<br><span class="red">люди/)
  assert.match(tent, /\/game\?t=quiz&amp;src=fair-/)
  // QR — настоящие коды из scripts/materials-qr.ts, не рамки-заглушки
  assert.match(rollup, /<img src="qr\/[a-z0-9-]+\.svg"/)
  assert.match(tent, /<img src="qr\/[a-z0-9-]+\.svg"/)
  // #bleed — классом на <html> и именованной страницей с вылетами, без document.write
  for (const html of [rollup, tent]) {
    assert.match(html, /<script src="\.\.\/print\/bleed\.js"><\/script>/)
    assert.match(html, /html\.bleed \{\s*--bleed: \d+mm;/)
    assert.match(html, /html\.bleed \.sheet \{\s*page: [a-z]+-bleed;/)
  }
})

test('раскадровка: десять сцен, тайминг 60 секунд, титры — из сценария ролика', () => {
  // Сцены — в storyboard.js рядом с макетом
  const src = localRefs('docs/brand/video/storyboard.html') + localRefs('docs/brand/video/storyboard.js')
  const video = read('docs/brand/video.md')
  const rows = [...video.matchAll(/^\| (\d+) \| (\d:\d\d)–(\d:\d\d) \| [^|]+ \| «([^|]+)» \|/gm)].map((m) => ({ n: Number(m[1]), title: m[4] }))
  assert.equal(rows.length, 10)
  const scenes = [...src.matchAll(/\{ n: (\d+), t: \[(\d+), (\d+)\]/g)].map((m) => ({ n: Number(m[1]), from: Number(m[2]), to: Number(m[3]) }))
  assert.equal(scenes.length, 10)
  let at = 0
  for (const s of scenes) {
    assert.equal(s.from, at, `сцена ${s.n} начинается не там`)
    at = s.to
  }
  assert.equal(at, 60)
  // Титры в кадрах — те же, что в таблице сценария; у сцены 4 — по кадру на отдел, у 9 и 10 — графика
  const titles = new Map([...src.matchAll(/\{ n: (\d+), [^\n]*?title: '([^']+)'/g)].map((m) => [Number(m[1]), m[2]]))
  for (const r of rows) {
    if ([4, 9, 10].includes(r.n)) continue
    assert.equal(titles.get(r.n), r.title.replace(/„|“/g, (q) => (q === '„' ? '«' : '»')), `титр сцены ${r.n}`)
  }
  for (const dept of ['Лаборатория', 'Технологический цех', 'Склад', 'Цех розлива']) assert.ok(src.includes(`title: '${dept}'`), dept)
  // Кадры роликов компании — лёгкие
  for (const f of readdirSync(join(root, 'docs/brand/frames'))) assert.ok(statSync(join(root, 'docs/brand/frames', f)).size < 200_000, `${f} тяжелее 200 КБ`)
})

test('страница /materials: маршрут, превью для ссылок, все макеты и картинки публикуются из docs/brand', () => {
  const page = read('src/pages/Materials.tsx')
  assert.match(read('src/App.tsx'), /path="materials"/)
  assert.match(read('server/app.ts'), /'\/materials': \{\s*title:/)
  assert.match(read('server/app.ts'), /'\/materials': 'src\/pages\/Materials\.tsx'/)
  // Плагин публикует эти папки docs/brand по адресу /materials/…
  const vite = read('vite.config.ts')
  const dirs = JSON.parse((/const dirs = (\[[^\]]+\])/.exec(vite)?.[1] ?? '[]').replace(/'/g, '"')) as string[]
  // Пути вида ${M}/img/key-mentor.jpg и шаблоны ${M}/img/${m.img}.webp — подставляем значения из данных страницы
  const direct = [...page.matchAll(/\$\{M\}\/([^`'"$]+)(?=[`'"])/g)].map((m) => m[1])
  const fromData = [
    ...[...page.matchAll(/img: '(merch-[a-z]+)'/g)].map((m) => `img/${m[1]}.webp`),
    ...[...page.matchAll(/img: \['([a-z0-9-]+)', '([a-z0-9-]+)'\]/g)].flatMap((m) => [`img/${m[1]}.webp`, `img/${m[2]}.webp`]),
    ...Array.from({ length: 12 }, (_, i) => `clips/covers/clip-${String(i + 1).padStart(2, '0')}.webp`),
    // Снимки экранов продукта (scripts/materials-shots.mjs) и кадры раскадровки (scripts/materials-previews.mjs)
    ...[...page.matchAll(/shot: '(site-[a-z-]+)'/g)].map((m) => `img/${m[1]}.webp`),
    ...[...page.matchAll(/img: '(storyboard-\d\d)'/g)].map((m) => `img/${m[1]}.webp`),
  ]
  const paths = [...direct, ...fromData]
  assert.ok(paths.length > 30)
  assert.equal(paths.filter((p) => p.startsWith('img/site-')).length, 6, 'шесть снимков продукта')
  assert.equal(paths.filter((p) => p.startsWith('img/storyboard-')).length, 4, 'четыре кадра раскадровки')
  // Снимки лёгкие: телефон — 600 px, компьютер — 1200 px, каждый легче 150 КБ
  for (const p of paths.filter((p) => p.startsWith('img/site-')))
    if (existsSync(join(root, 'docs/brand', p))) assert.ok(statSync(join(root, 'docs/brand', p)).size < 150_000, `${p} тяжелее 150 КБ`)
  for (const p of paths) {
    assert.ok(dirs.includes(p.split('/')[0]), `${p}: папки нет в публикации`)
    assert.ok(existsSync(join(root, 'docs/brand', p)), `${p}: нет файла в docs/brand`)
  }
  // Сайт: внутренние ссылки ведут на существующие маршруты
  for (const m of page.matchAll(/\['(\/[a-z]*)(?:\?[^']*)?', '/g)) assert.ok(m[1] === '/' || read('src/App.tsx').includes(`path="${m[1].slice(1)}"`), m[1])
  // Тексты страницы — по правилам: без «!», многоточий и «не X, а Y»
  const strings = [...page.matchAll(/'([^'\n]{12,})'/g)].map((m) => m[1]).join('\n')
  assert.ok(!/!|\.\.\.|…/.test(strings.replace(/«[^»]*»/g, '')), '«!» или многоточие')
  assert.ok(!/(?:^|[\s«(])не\s+[^\s,]+,\s+а\s/m.test(strings), '«не X, а Y»')
})

test('презентация HR-бренда: идея, цель, слоган, ключевые образы; картинки на месте, без дат и «!», название группировки', () => {
  const html = localRefs('docs/brand/deck/index.html')
  localRefs('docs/brand/deck/deck.css')
  const slides = html.match(/<section class="slide\b/g) ?? []
  assert.equal(slides.length, 35)
  // Критерии оценки кейса — отдельными слайдами
  for (const part of ['<span>Критерии оценки</span>', '<span>Новаторские идеи</span>', '<span>Второстепенные проблемы</span>', '<span>Прототип</span>', 'Путь кандидата', 'Аналоги']) assert.ok(html.includes(part), part)
  // Требование кейса: концепция продвижения структурированно оформлена в презентацию — идея, цель, слоган, ключевые образы
  for (const part of ['<span>Идея</span>', '<span>Цель</span>', '<span>Слоган</span>', '<span>Ключевые образы</span>', 'Сначала научим,<br>']) assert.ok(html.includes(part), part)
  assert.ok(html.includes('<span class="team">группировка antihype</span>'), 'название группировки')
  // Показ и анимации — отдельным файлом: CSP сайта запрещает встроенные скрипты
  assert.match(html, /<script src="deck\.js" defer><\/script>/)
  assert.ok(existsSync(join(root, 'docs/brand/deck/deck.js')))
  const text = html.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/[\u00a0\u202f]/g, ' ')
  assert.ok(!/!|\.\.\.|…/.test(text), '«!» или многоточие')
  // Размеры «850 × 2000 мм» — не годы
  const noSizes = text.replace(/\d+(?:[,.]\d+)?\s?×\s?\d+(?:[,.]\d+)?/g, '')
  assert.deepEqual(noSizes.match(/(?<!\d)20\d{2}(?!\d)/g) ?? [], [], 'год текущего века')
  for (const y of noSizes.match(/(?<!\d)19\d{2}(?!\d)/g) ?? []) assert.ok(['1978', '1996', '1998'].includes(y), `год ${y}`)
  // Суммы практики — официальные
  for (const s of [rub(minMonthlyPay), rub(maxEntryPay), rub(dorm.priceStudent)]) assert.ok(text.includes(s), s)
})
