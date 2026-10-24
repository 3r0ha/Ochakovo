// Медиа сайта из материалов заказчика (archive/case-materials) — всё воспроизводится одной командой:
//   node scripts/media.mjs           — всё по порядку
//   node scripts/media.mjs brand     — логотип без квадрата, пиктограммы и паттерн: векторы из .ai через PyMuPDF
//   node scripts/media.mjs favicon   — public/favicon.ico из public/favicon.svg (16, 32 и 48 px)
//   node scripts/media.mjs video     — четыре ролика о профессиях: вырезка, H.264 720p и 480p, постеры, манифест
// Нужны python3 с PyMuPDF (python3 -c "import fitz"), ffmpeg с libx264 и sharp из зависимостей.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'

const ROOT = new URL('..', import.meta.url).pathname
const at = (p) => join(ROOT, p)
const CASE = at('archive/case-materials')
const BRAND_SRC = join(CASE, 'brandbook')
const LOGO_DIR = join(BRAND_SRC, 'Брендбук Очаково/ЛОГО БЕЗ КВАДРАТА')
const PICTO_DIR = join(BRAND_SRC, 'Патерн и пиктограммы')

// Цвета брендбука (стр. 58): красный Pantone 199, тёмно-красный Pantone 7621 — для пиктограмм на красном фоне,
// серый Pantone 429 — для геометрических фигур паттерна
export const BRAND_RED = '#D50032'
export const BRAND_DARK_RED = '#AB2328'
export const BRAND_GREY = '#A2AAAD'

const steps = process.argv.slice(2)
const run = (name) => !steps.length || steps.includes(name)

// ─── Векторы из .ai ─────────────────────────────────────────────────────────────
// Файлы .ai из брендбука — это PDF. PyMuPDF отдаёт заливки страницы как контуры: отрезки, кривые Безье и прямоугольники
// в координатах страницы (y вниз) — то же, что нужно SVG. Python запускаем из временной папки, чтобы модуль
// с именем fitz из рабочей папки не подменил библиотеку.
const PY_DRAWINGS = `
import fitz, json, sys
out = {}
for path in sys.argv[1:]:
    page = fitz.open(path)[0]
    drawings = []
    for dr in page.get_drawings():
        items = []
        for it in dr['items']:
            k = it[0]
            if k == 'l':
                items.append(['l', [it[1].x, it[1].y], [it[2].x, it[2].y]])
            elif k == 'c':
                items.append(['c', [it[1].x, it[1].y], [it[2].x, it[2].y], [it[3].x, it[3].y], [it[4].x, it[4].y]])
            elif k == 're':
                r = it[1]
                items.append(['re', [r.x0, r.y0, r.x1, r.y1], it[2] if len(it) > 2 else 1])
            elif k == 'qu':
                q = it[1]
                items.append(['qu', [[q.ul.x, q.ul.y], [q.ur.x, q.ur.y], [q.lr.x, q.lr.y], [q.ll.x, q.ll.y]]])
        r = dr['rect']
        drawings.append({'fill': list(dr.get('fill') or []), 'evenOdd': bool(dr.get('even_odd')), 'rect': [r.x0, r.y0, r.x1, r.y1], 'items': items})
    out[path] = {'page': [page.rect.width, page.rect.height], 'drawings': drawings}
print(json.dumps(out))
`

/** Растр участка страницы .ai в PNG — для сверки нашего SVG с исходником */
const PY_RENDER = `
import fitz, sys
path, out, x0, y0, x1, y1, zoom = sys.argv[1], sys.argv[2], *map(float, sys.argv[3:8])
page = fitz.open(path)[0]
page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), clip=fitz.Rect(x0, y0, x1, y1), alpha=False).save(out)
`

function python(code, args) {
  const res = spawnSync('python3', ['-c', code, ...args], { cwd: tmpdir(), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (res.status !== 0) throw new Error(`python3: ${res.stderr || res.error}`)
  return res.stdout
}

function readDrawings(...files) {
  return JSON.parse(python(PY_DRAWINGS, files))
}

const num = (v) => {
  const s = (Math.round(v * 100) / 100).toFixed(2).replace(/\.?0+$/, '')
  return s === '-0' ? '0' : s
}

/** Ломаная подконтура для расчётов: кривые — по восьми точкам */
function polyline(sub) {
  const pts = [sub.start]
  for (const s of sub.segs) {
    if (s[0] === 'L') pts.push(s[1])
    else {
      const p0 = pts[pts.length - 1]
      const [, c1, c2, p3] = s
      for (let i = 1; i <= 8; i++) {
        const t = i / 8
        const u = 1 - t
        pts.push([
          u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p3[0],
          u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p3[1],
        ])
      }
    }
  }
  return pts
}
const signedArea = (pts) => pts.reduce((a, p, i) => {
  const q = pts[(i + 1) % pts.length]
  return a + p[0] * q[1] - q[0] * p[1]
}, 0) / 2
const inside = (pt, pts) => {
  let wn = 0
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    const cross = (b[0] - a[0]) * (pt[1] - a[1]) - (pt[0] - a[0]) * (b[1] - a[1])
    if (a[1] <= pt[1]) {
      if (b[1] > pt[1] && cross > 0) wn++
    } else if (b[1] <= pt[1] && cross < 0) wn--
  }
  return wn !== 0
}

/**
 * Контур заливки в SVG path. tf — перенос и масштаб без поворота (брендбук запрещает поворачивать знаки и пиктограммы).
 * Заливка по правилу nonzero, как в исходнике: отверстие — подконтур с обходом против внешнего. Направление отрезков и кривых
 * берём как есть. У прямоугольников (оператор re) PyMuPDF отдаёт только рамку, и знак обхода у вложенных групп с ним не сходится,
 * поэтому прямоугольник внутри другого подконтура делаем отверстием (обход против него), остальные — как в исходнике
 */
function pathData(drawing, tf) {
  const same = (a, b) => a && b && Math.abs(a[0] - b[0]) < 1e-3 && Math.abs(a[1] - b[1]) < 1e-3
  /** Подконтуры: { start, segs: [['L', p] | ['C', c1, c2, p]], rect } */
  const subs = []
  let cur = null
  const corners = ([x0, y0, x1, y1], ccw) => (ccw ? [[x0, y0], [x0, y1], [x1, y1], [x1, y0]] : [[x0, y0], [x1, y0], [x1, y1], [x0, y1]])
  for (const it of drawing.items) {
    if (it[0] === 're' || it[0] === 'qu') {
      const c = it[0] === 're' ? corners(it[1], it[2] === -1) : it[1]
      subs.push({ start: c[0], segs: c.slice(1).map((p) => ['L', p]), rect: it[0] === 're' ? it[1] : null })
      cur = null
      continue
    }
    if (!cur || !same(cur.end, it[1])) {
      cur = { start: it[1], segs: [] }
      subs.push(cur)
    }
    if (it[0] === 'l') cur.segs.push(['L', it[2]])
    else if (it[0] === 'c') cur.segs.push(['C', it[2], it[3], it[4]])
    cur.end = cur.segs[cur.segs.length - 1].at(-1)
  }
  const polys = subs.map(polyline)
  subs.forEach((s, i) => {
    if (!s.rect) return
    const centre = [(s.rect[0] + s.rect[2]) / 2, (s.rect[1] + s.rect[3]) / 2]
    let host = -1
    polys.forEach((p, j) => {
      if (j === i || !inside(centre, p) || Math.abs(signedArea(p)) <= Math.abs(signedArea(polys[i]))) return
      if (host < 0 || Math.abs(signedArea(p)) < Math.abs(signedArea(polys[host]))) host = j
    })
    if (host < 0) return
    const want = -Math.sign(signedArea(polys[host]))
    if (Math.sign(signedArea(polys[i])) !== want) {
      const c = corners(s.rect, true)
      const flip = Math.sign(signedArea(c)) === want ? c : corners(s.rect, false)
      s.start = flip[0]
      s.segs = flip.slice(1).map((p) => ['L', p])
    }
  })
  const P = (p) => {
    const [x, y] = tf(p)
    return `${num(x)} ${num(y)}`
  }
  return subs
    .map((s) => `M${P(s.start)}` + s.segs.map((g) => (g[0] === 'L' ? `L${P(g[1])}` : `C${P(g[1])} ${P(g[2])} ${P(g[3])}`)).join('') + 'Z')
    .join('')
}

const union = (rects) => [
  Math.min(...rects.map((r) => r[0])),
  Math.min(...rects.map((r) => r[1])),
  Math.max(...rects.map((r) => r[2])),
  Math.max(...rects.map((r) => r[3])),
]

/**
 * Доля пикселей, где наш SVG и исходник расходятся больше чем наполовину. Сравниваем «красноту» (R − G) на белом фоне:
 * красная заливка даёт около 210, белая подложка из .ai, пустое место и серые подписи на листе — около нуля
 */
async function compareRaster(paths, aiFile, box, k, zoom) {
  // Рамка по целым пикселям: иначе растр PyMuPDF сдвинут на долю пикселя и тонкие линии расходятся по краю
  const B = [Math.floor(box[0] * zoom) / zoom, Math.floor(box[1] * zoom) / zoom, Math.ceil(box[2] * zoom) / zoom, Math.ceil(box[3] * zoom) / zoom]
  const width = Math.round((B[2] - B[0]) * zoom)
  const height = Math.round((B[3] - B[1]) * zoom)
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="${(B[0] - box[0]) * k} ${(B[1] - box[1]) * k} ${(B[2] - B[0]) * k} ${(B[3] - B[1]) * k}" fill="${BRAND_RED}">` +
    paths.map((d) => `<path d="${d}"/>`).join('') +
    `</svg>`
  const png = join(tmpdir(), `media-check-${process.pid}.png`)
  python(PY_RENDER, [aiFile, png, ...B.map(String), String(zoom)])
  const ref = sharp(png)
  const meta = await ref.metadata()
  const redness = async (img) => {
    const px = await img.resize(width, height, { fit: 'fill' }).flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer()
    const out = Buffer.alloc(width * height)
    for (let i = 0; i < out.length; i++) out[i] = Math.max(0, px[i * 3] - px[i * 3 + 1])
    return out
  }
  const a = await redness(ref)
  const b = await redness(sharp(Buffer.from(svg)))
  if (process.env.MEDIA_DEBUG) {
    const diffPng = Buffer.alloc(a.length)
    for (let i = 0; i < a.length; i++) diffPng[i] = Math.abs(a[i] - b[i]) > 105 ? 0 : 255
    await sharp(diffPng, { raw: { width, height, channels: 1 } }).png().toFile(`${process.env.MEDIA_DEBUG}/diff-${width}.png`)
  }
  rmSync(png, { force: true })
  if (Math.abs(meta.width - width) > 1 || Math.abs(meta.height - height) > 1) throw new Error(`растр ${meta.width}×${meta.height}, ждали ${width}×${height}`)
  let bad = 0
  let ink = 0
  for (let i = 0; i < a.length; i++) {
    if (a[i] > 105 || b[i] > 105) ink++
    if (Math.abs(a[i] - b[i]) > 105) bad++
  }
  return ink ? bad / ink : 0
}

// ─── Логотип без квадрата ───────────────────────────────────────────────────────
// Брендбук, папка «ЛОГО БЕЗ КВАДРАТА»: прежний знак «квадрат с кругом» заменён надписью ОЧАКОВО с подписью
// «Натуральные напитки» (там же — «Логотипы с квадратом и без.docx»: «замена на»).
//   block — блок в три строки (Лого_без квадрата.ai, вариант без красной плашки): подвал, крупные носители
//   line  — подпись в одну строку (031_OCHAKOVO_logoblock_rus_friz03.ai): шапка сайта
//   frieze — горизонтальный, через вертикальную черту (Лого на фриз.ai): широкие полосы, баннеры
const LOGOS = [
  // В «Лого_без квадрата.ai» два варианта: справа надпись без плашки (контуры 1 и 2 поверх белого прямоугольника 0), слева — на красной плашке
  { name: 'block', file: 'Лого_без квадрата.ai', pick: (ds) => ds.filter((d, i) => i === 1 || i === 2) },
  { name: 'line', file: '031_OCHAKOVO_logoblock_rus_friz03.ai', pick: (ds) => ds },
  { name: 'frieze', file: 'Лого на фриз.ai', pick: (ds) => ds },
]

async function buildLogos() {
  const files = LOGOS.map((l) => join(LOGO_DIR, l.file))
  const all = readDrawings(...files)
  const out = {}
  for (const logo of LOGOS) {
    const file = join(LOGO_DIR, logo.file)
    const drawings = logo.pick(all[file].drawings)
    const box = union(drawings.map((d) => d.rect))
    // Единица SVG — сотая доля высоты блока: числа короткие и одинаково точные у всех вариантов
    const k = 100 / (box[3] - box[1])
    const tf = ([x, y]) => [(x - box[0]) * k, (y - box[1]) * k]
    const w = Number(num((box[2] - box[0]) * k))
    const h = 100
    const paths = drawings.map((d) => pathData(d, tf))
    out[logo.name] = { w, h, paths }
    for (const [suffix, color] of [
      ['red', BRAND_RED],
      ['white', '#FFFFFF'],
    ]) {
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" fill="${color}">` +
        `<title>ОЧАКОВО — натуральные напитки</title>` +
        paths.map((d) => `<path d="${d}"/>`).join('') +
        `</svg>\n`
      const name = logo.name === 'block' ? `logo-${suffix}.svg` : `logo-${logo.name}-${suffix}.svg`
      writeFileSync(at(`public/brand/${name}`), svg)
      if (suffix === 'red') {
        const zoom = 900 / (box[3] - box[1])
        const diff = await compareRaster(paths, file, box, k, Math.min(zoom, 8))
        console.log(`логотип ${logo.name}: ${w}×${h}, расхождение с исходником ${(diff * 100).toFixed(2)} %`)
        if (diff > 0.02) throw new Error(`логотип ${logo.name} не совпал с исходником`)
      }
    }
  }
  // Те же контуры — в src/components/Logo.tsx (между отметками), чтобы логотип в шапке был в разметке, без запроса
  const tsx = at('src/components/Logo.tsx')
  const src = readFileSync(tsx, 'utf8')
  const block =
    `// <media:logos> — блок пишет node scripts/media.mjs brand, руками не править\n` +
    `const LOGOS = {\n` +
    Object.entries(out)
      .filter(([name]) => name !== 'frieze')
      .map(([name, { w, h, paths }]) => `  ${name}: {\n    w: ${w},\n    h: ${h},\n    paths: [\n${paths.map((d) => `      '${d}',`).join('\n')}\n    ],\n  },\n`)
      .join('') +
    `} as const\n// </media:logos>`
  const next = src.replace(/\/\/ <media:logos>[\s\S]*?\/\/ <\/media:logos>/, block)
  if (next === src && !src.includes(block)) throw new Error('в Logo.tsx нет отметок // <media:logos> … // </media:logos>')
  writeFileSync(tsx, next)
}

// ─── Пиктограммы ───────────────────────────────────────────────────────────────
// OCHAKOVO_pictograms.ai: три ряда — «процессы производства и оборудование» (10), «продукция» (6), «ингредиенты, сырьё» (9).
// Брендбук (стр. 51): у каждой пиктограммы свой квадратный модуль, в группе — единый масштаб, без поворотов и искажений.
// Модуля в файле нет (он без заливки и обводки), поэтому берём шаг сетки листа — 45,5 pt: пиктограмма по центру своей
// колонки, по высоте — как стоит в своём ряду. Все модули одного размера, значит и масштаб у всех один.
// Пиво не показываем: бутылку с длинным горлом, кег, ящик с бутылками и хмель не выгружаем.
const SHEET = { colX0: 215.95, step: 45.5, rowsY: [220, 330] }
const PICTOGRAMS = [
  // ряд 1 — процессы производства и оборудование
  { at: [0, 0], id: 'hopper', name: 'Бункер с дробилкой', genre: 'equipment' },
  { at: [0, 1], id: 'tanks', name: 'Ёмкости', genre: 'equipment' },
  { at: [0, 2], id: 'tank-unit', name: 'Установка с ёмкостями', genre: 'equipment' },
  { at: [0, 3], id: 'kettle', name: 'Варочный котёл', genre: 'equipment' },
  { at: [0, 4], id: 'vat', name: 'Чан с вытяжкой', genre: 'equipment' },
  { at: [0, 5], id: 'cct', name: 'Цилиндро-конический танк', genre: 'equipment' },
  { at: [0, 6], id: 'cycle', name: 'Цикл производства', genre: 'process' },
  { at: [0, 7], id: 'control', name: 'Контроль параметров', genre: 'process' },
  { at: [0, 8], id: 'tap-tank', name: 'Ёмкость с кранами', genre: 'equipment' },
  { at: [0, 9], id: 'cooler', name: 'Охладитель', genre: 'equipment' },
  // ряд 2 — продукция
  { at: [1, 0], id: 'beer-bottle', name: 'Бутылка с длинным горлом', excluded: 'пивная бутылка' },
  { at: [1, 1], id: 'pet-bottle', name: 'Бутылка ПЭТ', genre: 'product' },
  { at: [1, 2], id: 'keg', name: 'Кег', excluded: 'пивная тара' },
  { at: [1, 3], id: 'bottle-crate', name: 'Ящик с бутылками', excluded: 'пивные бутылки в ящике' },
  { at: [1, 4], id: 'can', name: 'Банка', genre: 'product' },
  { at: [1, 5], id: 'glass-bottle', name: 'Стеклянная бутылка', genre: 'product' },
  // ряд 3 — ингредиенты, сырьё
  { at: [2, 0], id: 'barley', name: 'Колос ячменя', genre: 'raw' },
  { at: [2, 1], id: 'hop-cones', name: 'Шишки хмеля', excluded: 'хмель для пива' },
  { at: [2, 2], id: 'grain', name: 'Зерно', genre: 'raw' },
  { at: [2, 3], id: 'citrus', name: 'Цитрус', genre: 'raw' },
  { at: [2, 4], id: 'hop', name: 'Хмель', excluded: 'хмель для пива' },
  { at: [2, 5], id: 'grapes', name: 'Виноград', genre: 'raw' },
  { at: [2, 6], id: 'apple', name: 'Яблоко', genre: 'raw' },
  { at: [2, 7], id: 'pear', name: 'Груша', genre: 'raw' },
  { at: [2, 8], id: 'ears', name: 'Колосья', genre: 'raw' },
]
const GENRES = { process: 'процесс', equipment: 'оборудование', raw: 'сырьё', product: 'продукция' }
/** Модуль на выходе — 48 единиц: удобно задавать размер кратно 12 и 16 px */
const MODULE_OUT = 48

const sheetCell = (d) => {
  const cx = (d.rect[0] + d.rect[2]) / 2
  const cy = (d.rect[1] + d.rect[3]) / 2
  const row = cy < SHEET.rowsY[0] ? 0 : cy < SHEET.rowsY[1] ? 1 : 2
  return [row, Math.round((cx - SHEET.colX0) / SHEET.step)]
}
const isRed = (d) => d.fill.length === 3 && d.fill[0] > 0.8 && d.fill[1] < 0.3

/** Пиктограммы листа: путь в координатах своего модуля 48×48 и рамка в координатах листа */
function sheetPictograms(sheet) {
  const red = sheet.drawings.filter(isRed)
  const rows = [0, 1, 2].map((r) => union(red.filter((d) => sheetCell(d)[0] === r).map((d) => d.rect)))
  const k = MODULE_OUT / SHEET.step
  const result = new Map()
  for (const d of red) {
    const [row, col] = sheetCell(d)
    const meta = PICTOGRAMS.find((p) => p.at[0] === row && p.at[1] === col)
    if (!meta) throw new Error(`на листе пиктограмм лишний контур в ряду ${row + 1}, колонке ${col + 1}`)
    // Модуль: по горизонтали — колонка, по вертикали — середина ряда
    const mx = SHEET.colX0 + col * SHEET.step - SHEET.step / 2
    const my = (rows[row][1] + rows[row][3]) / 2 - SHEET.step / 2
    result.set(meta.id, { meta, drawing: d, rowBox: rows[row], d: pathData(d, ([x, y]) => [(x - mx) * k, (y - my) * k]) })
  }
  for (const p of PICTOGRAMS) if (!result.has(p.id)) throw new Error(`на листе нет пиктограммы ${p.id}`)
  return result
}

function buildPictograms(sheet) {
  const picts = sheetPictograms(sheet)
  const dir = at('public/brand/pictograms')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const list = []
  for (const p of PICTOGRAMS) {
    if (p.excluded) continue
    const { d } = picts.get(p.id)
    writeFileSync(
      join(dir, `${p.id}.svg`),
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MODULE_OUT} ${MODULE_OUT}" width="${MODULE_OUT}" height="${MODULE_OUT}" fill="${BRAND_RED}"><title>${p.name}</title><path d="${d}"/></svg>\n`,
    )
    list.push({ id: p.id, name: p.name, genre: p.genre, genreName: GENRES[p.genre], file: `/brand/pictograms/${p.id}.svg` })
  }
  const manifest = {
    source: 'archive/case-materials/brandbook/Патерн и пиктограммы/OCHAKOVO_pictograms.ai',
    module: MODULE_OUT,
    rules: [
      'Модуль у всех одинаковый: при одной ширине картинки масштаб пиктограмм в группе единый.',
      'Не поворачивать, не отражать, не растягивать по одной оси.',
      'В группе — один масштаб и один цвет, лучше разные жанры: сырьё, производство, продукция.',
      'Свободное поле вокруг — не меньше модуля пиктограммы.',
      'Цвет: красный на белом, белый или тёмно-красный на красном, красный на тёмно-сером (брендбук, стр. 50).',
    ],
    colors: { red: BRAND_RED, darkRed: BRAND_DARK_RED, grey: BRAND_GREY },
    pictograms: list,
    excluded: PICTOGRAMS.filter((p) => p.excluded).map((p) => ({ id: p.id, name: p.name, why: p.excluded })),
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(`пиктограммы: ${list.length} в public/brand/pictograms, исключено ${manifest.excluded.length}`)
  return picts
}

// ─── Паттерн ───────────────────────────────────────────────────────────────────
// OCHAKOVO_pattern_01.ai: две части по 5×5 пиктограмм на сетке с шагом 79 pt и серые геометрические фигуры на втором плане.
// Под паттерном в файле — образцы фигур, в паттерн они не входят. Пиктограммы пива меняем на разрешённые того же жанра
// так, чтобы рядом (в том числе по диагонали) не стояли одинаковые: брендбук разрешает добавлять пиктограммы по этому правилу.
const PATTERN = { step: 79.04, col0: 56.5, base0: 106.5, bottom: 424 }
const REPLACE = { 'hop-cones': 'grapes', hop: 'ears', keg: 'pet-bottle', 'bottle-crate': 'can', 'beer-bottle': 'glass-bottle' }
export const PATTERN_COLORWAYS = [
  { name: 'red', pict: BRAND_RED, note: 'на белом и тёмно-сером фоне' },
  { name: 'white', pict: '#FFFFFF', note: 'на красном фоне' },
  { name: 'dark-red', pict: BRAND_DARK_RED, note: 'на красном фоне, приглушённо' },
]

function buildPattern(pattern, picts) {
  const grey = pattern.drawings.filter((d) => !isRed(d) && d.rect[3] <= PATTERN.bottom)
  const red = pattern.drawings.filter(isRed)
  const scale = PATTERN.step / SHEET.step
  // Каждую пиктограмму паттерна узнаём по размеру: на листе она та же, только в масштабе 79 / 45,5
  const size = (r) => [r[2] - r[0], r[3] - r[1]]
  const grid = []
  for (const d of red) {
    const [w, h] = size(d.rect)
    let best = null
    let err = Infinity
    for (const p of picts.values()) {
      const [sw, sh] = size(p.drawing.rect)
      const e = Math.abs(sw * scale - w) + Math.abs(sh * scale - h)
      if (e < err) [best, err] = [p, e]
    }
    if (err > 1.5) throw new Error(`пиктограмма паттерна в ${d.rect.map(num)} не узнана`)
    const col = Math.round(((d.rect[0] + d.rect[2]) / 2 - PATTERN.col0) / PATTERN.step)
    const row = Math.round((d.rect[3] - PATTERN.base0) / PATTERN.step)
    grid.push({ row, col, source: best.meta.id, rect: d.rect })
  }
  const cells = new Map(grid.map((g) => [`${g.row}:${g.col}`, g]))
  for (const g of grid) g.id = REPLACE[g.source] ?? g.source
  // Проверка правила брендбука: рядом нет одинаковых
  for (const g of grid)
    for (const [dr, dc] of [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]]) {
      const n = cells.get(`${g.row + dr}:${g.col + dc}`)
      if (n && n.id === g.id) throw new Error(`в паттерне рядом две «${g.id}»: ${g.row}:${g.col} и ${n.row}:${n.col}`)
    }
  const box = union([...grey.map((d) => d.rect), ...red.map((d) => d.rect)])
  const tf = ([x, y]) => [x - box[0], y - box[1]]
  const w = num(box[2] - box[0])
  const h = num(box[3] - box[1])
  const used = [...new Set(grid.map((g) => g.id))].sort()
  const k = MODULE_OUT / SHEET.step
  const uses = grid
    .sort((a, b) => a.row - b.row || a.col - b.col)
    .map((g) => {
      const p = picts.get(g.id)
      // Своя пиктограмма — на место исходной; замена — по центру колонки и на строку ряда, как стоит в своём ряду листа
      const sheetRect = p.drawing.rect
      const [cx, bottom] =
        g.id === g.source
          ? [(g.rect[0] + g.rect[2]) / 2, g.rect[3]]
          : [PATTERN.col0 + g.col * PATTERN.step, PATTERN.base0 + g.row * PATTERN.step - (p.rowBox[3] - sheetRect[3]) * scale]
      // Где в модуле 48×48 центр и низ пиктограммы
      const col = p.meta.at[1]
      const mx = SHEET.colX0 + col * SHEET.step - SHEET.step / 2
      const my = (p.rowBox[1] + p.rowBox[3]) / 2 - SHEET.step / 2
      const inCx = ((sheetRect[0] + sheetRect[2]) / 2 - mx) * k
      const inBottom = (sheetRect[3] - my) * k
      const s = scale / k
      const x = cx - box[0] - inCx * s
      const y = bottom - box[1] - inBottom * s
      return `<use href="#${g.id}" transform="translate(${num(x)} ${num(y)}) scale(${Math.round(s * 10000) / 10000})"/>`
    })
  // Контур пиктограммы в координатах модуля 48×48 — один раз в defs, на месте — use со сдвигом и масштабом
  const symbols = used.map((id) => `<path id="${id}" d="${picts.get(id).d}"/>`)
  const shapes = grey.map((d) => `<path d="${pathData(d, tf)}"/>`).join('')
  for (const c of PATTERN_COLORWAYS) {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
      `<title>Паттерн ОЧАКОВО: пиктограммы и геометрические фигуры</title>` +
      `<defs>${symbols.join('')}</defs>` +
      `<g fill="${BRAND_GREY}">${shapes}</g>` +
      `<g fill="${c.pict}">${uses.join('')}</g>` +
      `</svg>\n`
    writeFileSync(at(`public/brand/pattern-${c.name}.svg`), svg)
  }
  console.log(`паттерн: ${w}×${h}, ${grid.length} пиктограмм, замен ${grid.filter((g) => g.id !== g.source).length}`)
  return { grid, w, h }
}

async function brand() {
  mkdirSync(at('public/brand'), { recursive: true })
  await buildLogos()
  const sheetFile = join(PICTO_DIR, 'OCHAKOVO_pictograms.ai')
  const patternFile = join(PICTO_DIR, 'OCHAKOVO_pattern_01.ai')
  const all = readDrawings(sheetFile, patternFile)
  const picts = buildPictograms(all[sheetFile])
  // Сверка пиктограмм с исходником: все сразу, в координатах листа
  const red = all[sheetFile].drawings.filter(isRed)
  const box = union(red.map((d) => d.rect))
  const sheetPaths = red.map((d) => pathData(d, ([x, y]) => [x - box[0], y - box[1]]))
  const diff = await compareRaster(sheetPaths, sheetFile, box, 1, 6)
  console.log(`пиктограммы: расхождение с исходником ${(diff * 100).toFixed(2)} %`)
  if (diff > 0.02) throw new Error('пиктограммы не совпали с исходником')
  buildPattern(all[patternFile], picts)
}

// ─── Фавиконка ─────────────────────────────────────────────────────────────────
// public/favicon.svg — бутылка кваса с этикеткой «КВАС» (рисует её w1-game, силуэт тот же, что в игре).
// favicon.ico — она же в 16, 32 и 48 px: его по умолчанию просят старые браузеры, Яндекс и почтовые клиенты.
// Внутри ICO лежат PNG — так умеют все браузеры с Windows Vista
async function favicon() {
  const svg = readFileSync(at('public/favicon.svg'))
  const sizes = [16, 32, 48]
  const pngs = await Promise.all(
    sizes.map((size) => sharp(svg, { density: 72 * (size / 100) * 8 }).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png({ compressionLevel: 9 }).toBuffer()),
  )
  const header = Buffer.alloc(6 + 16 * sizes.length)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // 1 — значок
  header.writeUInt16LE(sizes.length, 4)
  let offset = header.length
  sizes.forEach((size, i) => {
    const e = 6 + 16 * i
    header.writeUInt8(size, e)
    header.writeUInt8(size, e + 1)
    header.writeUInt8(0, e + 2) // без палитры
    header.writeUInt8(0, e + 3)
    header.writeUInt16LE(1, e + 4) // плоскости
    header.writeUInt16LE(32, e + 6) // бит на пиксель
    header.writeUInt32LE(pngs[i].length, e + 8)
    header.writeUInt32LE(offset, e + 12)
    offset += pngs[i].length
  })
  const ico = Buffer.concat([header, ...pngs])
  writeFileSync(at('public/favicon.ico'), ico)
  console.log(`favicon.ico: ${sizes.join(', ')} px, ${ico.length} байт`)
}

// ─── Ролики о профессиях ───────────────────────────────────────────────────────
// Каждый ролик просмотрен по кадрам (каждую секунду, в спорных местах — каждые 0,1 с; границы сцен — ffmpeg scene).
// Вырезаем сцены, где читается этикетка алкоголя, и концовку с прежним логотипом в квадрате и QR-кодом неизвестного адреса.
// keep — что оставляем, секунды исходника, по границам сцен (кадры 30 в секунду). Звук режем по тем же границам:
// сцены в роликах смонтированы в долю музыки, поэтому склейка ложится на бит; на стыках — затухание 15 мс без щелчков.
// Речи нет ни в одном ролике: на кадрах никто не говорит в камеру, смысл несут титры, на спектрограмме — музыка с ровной
// громкостью (volumedetect: средняя −14…−15 дБ, пик 0 дБ) без речевых формант. Титры перечислены в steps — это и описание
// для экранного диктора.
export const VIDEOS = [
  {
    id: 'machinist',
    source: 'Машинист оборудования.mp4',
    profession: 'Машинист технологических установок',
    // Табличка на двери в первой сцене: «Производство углекислоты». Концовка с 31,3 вырезана
    department: 'Производство углекислоты',
    keep: [[0, 31.3]],
    poster: 28.3,
    steps: ['Подготовься к работе', 'Следи за работой', 'Контролируй и управляй', 'Наставники всему научат', 'Закрепляй пройденный материал', 'Твоя точность — наш успех'],
    review: 'Пива и алкогольных этикеток нет. Вырезана концовка: прежний логотип в квадрате и QR-код.',
  },
  {
    id: 'bottling-operator',
    source: 'Оператор линии розлива.mp4',
    profession: 'Оператор линии розлива',
    department: 'Цех розлива напитков',
    // Вырезаны крупные планы банок «Джин & Грейпфрут» (0,73–1,7; 2,7–3,7; 7,5–10,47; 11,6–12,63) и концовка с 32,93
    keep: [[0, 0.733], [1.7, 2.7], [3.7, 7.5], [10.467, 11.6], [12.633, 32.933]],
    // Постер — наставник и новичок у машины («Я делаю натуральные напитки» на куртке). Титр ролика стоит в левом верхнем углу:
    // кадр обрезан ниже и правее него (доли ширины и высоты), пропорция 16:9 сохраняется
    poster: 20.2,
    posterCrop: { x: 0.06, y: 0.245, size: 0.755 },
    steps: ['Надень форму', 'Следи за работой', 'Контролируй и управляй', 'Наставники всегда помогут', 'Твоя точность — наш успех', 'Обучайся легко и просто'],
    review:
      'На линии разливают коктейль «Джин & Грейпфрут»: сцены, где читается этикетка, вырезаны. В оставшихся банки мелко, размыто или в плёнке, надписей не прочитать. Вырезана концовка: прежний логотип в квадрате и QR-код.',
  },
  {
    id: 'lab-assistant',
    source: 'Химик-лаборант.mp4',
    profession: 'Лаборант',
    department: 'Лаборатория',
    // Вырезаны общий план с полками образцов (банка сидра, тёмные бутылки) и стол с бутылками в этикетках (20,93–21,93)
    keep: [[0, 1.467], [3.067, 20.933], [21.933, 27.8]],
    poster: 22.35,
    steps: ['Надень форму', 'Контролируй процесс', 'Выполняй органолептические анализы', 'Наставники всему научат', 'Проверяй качество', 'Обучайся легко и просто', 'Закрепляй пройденный материал'],
    review: 'Вырезаны полки и стол с образцами, где видны банка сидра и тёмные бутылки с этикетками. Вырезана концовка: прежний логотип в квадрате и QR-код.',
  },
]
export const EXCLUDED_VIDEOS = [
  {
    source: 'Процесс создания нового вкуса.mp4',
    why: 'Ролик о солодовом напитке KERN: его наливают в стакан с пеной, как пиво, на ёмкостях — «Лаборатория экспериментального пивоварения», в магазинных холодильниках — пиво. Без этих сцен связного ролика не остаётся.',
  },
]
const SPEECH_CHECK = 'Речи нет: на кадрах никто не говорит в камеру, смысл несут титры; звук — музыка с ровной громкостью без речевых формант на спектрограмме.'
const SIZES = [
  { name: '720', height: 720, budget: 3.7 * 1024 * 1024, profile: 'high', level: '3.1' },
  { name: '480', height: 480, budget: 1.6 * 1024 * 1024, profile: 'main', level: '3.0' },
]
const AUDIO_BPS = 96_000
const FADE = 0.015

const ffmpeg = (args) => execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] })
const probe = (file) =>
  JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,codec_type,width,height,bit_rate', '-of', 'json', file], { encoding: 'utf8' }))

function volume(file) {
  const res = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' })
  const db = (name) => Number(res.stderr.match(new RegExp(`${name}: (-?[\\d.]+) dB`))?.[1])
  return { mean: db('mean_volume'), max: db('max_volume') }
}

/** Склейка сцен keep: видео — trim и concat, звук — по тем же границам с короткими затуханиями, в конце — затухание 0,8 с */
function filterGraph(keep) {
  const total = keep.reduce((s, [a, b]) => s + (b - a), 0)
  const parts = keep.map(([a, b], i) => {
    const d = b - a
    return (
      `[0:v]trim=start=${a}:end=${b},setpts=PTS-STARTPTS[v${i}];` +
      `[0:a]atrim=start=${a}:end=${b},asetpts=PTS-STARTPTS,afade=t=in:d=${FADE},afade=t=out:st=${(d - FADE).toFixed(3)}:d=${FADE}[a${i}];`
    )
  })
  const concat = keep.map((_, i) => `[v${i}][a${i}]`).join('') + `concat=n=${keep.length}:v=1:a=1[vc][ac];`
  return { graph: parts.join('') + concat + `[ac]afade=t=out:st=${(total - 0.8).toFixed(3)}:d=0.8[aout]`, total }
}

async function video() {
  const out = at('public/video')
  mkdirSync(out, { recursive: true })
  for (const f of readdirSync(out)) rmSync(join(out, f))
  const work = join(tmpdir(), `media-video-${process.pid}`)
  mkdirSync(work, { recursive: true })
  const manifest = { source: 'archive/case-materials/video', checked: 'кадры каждую секунду и по границам сцен', videos: [], excluded: EXCLUDED_VIDEOS }
  try {
    for (const v of VIDEOS) {
      const src = join(CASE, 'video', v.source)
      const { graph, total } = filterGraph(v.keep)
      // Сначала склейка без потерь по качеству (почти), потом два прохода x264 под бюджет размера
      const master = join(work, `${v.id}.mkv`)
      ffmpeg(['-i', src, '-filter_complex', graph, '-map', '[vc]', '-map', '[aout]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-c:a', 'pcm_s16le', master])
      const files = {}
      const bytes = {}
      for (const size of SIZES) {
        const file = `${v.id}-${size.name}.mp4`
        const target = Math.floor(((size.budget * 8) / total - AUDIO_BPS) * 0.97)
        const common = ['-i', master, '-vf', `scale=-2:${size.height}:flags=lanczos,format=yuv420p`, '-c:v', 'libx264', '-preset', 'slow', '-profile:v', size.profile, '-level', size.level, '-b:v', String(target), '-maxrate', String(Math.round(target * 1.6)), '-bufsize', String(target * 2), '-g', '60', '-threads', '4', '-passlogfile', join(work, `${v.id}-${size.name}`)]
        ffmpeg([...common, '-pass', '1', '-an', '-f', 'mp4', '/dev/null'])
        ffmpeg([...common, '-pass', '2', '-c:a', 'aac', '-b:a', String(AUDIO_BPS), '-ac', '2', '-ar', '44100', '-movflags', '+faststart', '-map_metadata', '-1', join(out, file)])
        files[size.name] = `/video/${file}`
        bytes[size.name] = statSync(join(out, file)).size
        if (bytes[size.name] > size.budget * 1.08) throw new Error(`${file}: ${bytes[size.name]} байт — больше бюджета`)
      }
      const info = probe(join(out, `${v.id}-720.mp4`))
      const duration = Math.round(Number(info.format.duration) * 10) / 10
      const { poster, lqip } = await makePoster(v, src, out, work)
      manifest.videos.push({
        id: v.id,
        profession: v.profession,
        department: v.department,
        duration,
        speech: false,
        sound: 'музыка',
        speechCheck: SPEECH_CHECK,
        volume: volume(src),
        steps: v.steps,
        width: 1280,
        height: 720,
        files,
        bytes,
        poster,
        lqip,
        source: `archive/case-materials/video/${v.source}`,
        keep: v.keep,
        review: v.review,
      })
      console.log(`${v.id}: ${duration} с, 720p ${(bytes['720'] / 1048576).toFixed(2)} МБ, 480p ${(bytes['480'] / 1048576).toFixed(2)} МБ`)
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  writeShiftVideos(manifest)
}

/**
 * Постер — кадр без титров, где видно работу (posterCrop срезает угол с титром ролика); размытая мини-превью — пока он грузится
 */
async function makePoster(v, src, out, work) {
  const frame = join(work, `${v.id}-poster.png`)
  const c = v.posterCrop
  const crop = c ? `crop=iw*${c.size}:ih*${c.size}:iw*${c.x}:ih*${c.y},` : ''
  ffmpeg(['-ss', String(v.poster), '-i', src, '-frames:v', '1', '-vf', `${crop}scale=1280:720:flags=lanczos`, frame])
  const poster = { avif: {}, webp: {} }
  for (const w of [1280, 640]) {
    const img = sharp(frame).resize({ width: w })
    await img.clone().avif({ quality: 50, effort: 6 }).toFile(join(out, `${v.id}-${w}.avif`))
    await img.clone().webp({ quality: 72, effort: 6 }).toFile(join(out, `${v.id}-${w}.webp`))
    poster.avif[w] = `/video/${v.id}-${w}.avif`
    poster.webp[w] = `/video/${v.id}-${w}.webp`
  }
  const lqip = await sharp(frame).resize({ width: 24 }).blur(1.2).webp({ quality: 40 }).toBuffer()
  return { poster, lqip: `data:image/webp;base64,${lqip.toString('base64')}` }
}

/** Только постеры, без перекодирования роликов: node scripts/media.mjs posters */
async function posters() {
  const out = at('public/video')
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
  const work = join(tmpdir(), `media-posters-${process.pid}`)
  mkdirSync(work, { recursive: true })
  try {
    for (const v of VIDEOS) {
      const entry = manifest.videos.find((x) => x.id === v.id)
      if (!entry) throw new Error(`${v.id}: нет в manifest.json — сначала node scripts/media.mjs video`)
      Object.assign(entry, await makePoster(v, join(CASE, 'video', v.source), out, work))
      console.log(`${v.id}: постер с ${v.poster} с`)
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  writeShiftVideos(manifest)
}

/** Те же данные — в src/components/ShiftVideo.tsx (между отметками): компоненту не нужен лишний запрос */
function writeShiftVideos(manifest) {
  const tsx = at('src/components/ShiftVideo.tsx')
  const src = readFileSync(tsx, 'utf8')
  const data = manifest.videos.map(({ id, profession, department, duration, speech, steps, width, height, files, poster, lqip }) => ({ id, profession, department, duration, speech, steps, width, height, files, poster, lqip }))
  const block = `// <media:videos> — блок пишет node scripts/media.mjs video из public/video/manifest.json, руками не править\nexport const SHIFT_VIDEOS = ${JSON.stringify(data, null, 2)} as const\n// </media:videos>`
  const next = src.replace(/\/\/ <media:videos>[\s\S]*?\/\/ <\/media:videos>/, block)
  if (next === src && !src.includes(block)) throw new Error('в ShiftVideo.tsx нет отметок // <media:videos> … // </media:videos>')
  writeFileSync(tsx, next)
}

if (run('brand')) await brand()
if (run('favicon')) await favicon()
if (run('video')) await video()
// Постеры входят в шаг video; отдельно — только по имени шага
if (steps.includes('posters')) await posters()
