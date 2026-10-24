// QR-код без сторонних пакетов: байтовый режим, уровень коррекции M, версии 1–10 (до 213 байт).
// Этого хватает на ссылку сайта с меткой источника (https://…/?src=fair-misis) и на ссылки ботов с ?start=.
// Порядок — по ISO/IEC 18004: биты данных → коды Рида — Соломона и перемежение блоков → служебные узоры →
// укладка «змейкой» → восемь масок, из них берётся с наименьшим штрафом. Сверка с эталонным генератором —
// scripts/tests/w2-hr-sources-qr.test.ts и матрицы в scripts/fixtures/qr/.
//
// Модуль общий для сервера и браузера: без DOM. Картинки — qrSvg (SVG для печати) и qrPath (контур для React);
// PNG рисует браузер на canvas по той же матрице (src/components/hr/SourcesView.tsx).

export type QrMask = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7

export type QrCode = {
  /** Версия 1–10: сторона 21 + 4 × (версия − 1) модулей */
  version: number
  /** Маска, которую выбрал кодировщик (или задали явно) */
  mask: QrMask
  /** Сторона в модулях, без свободного поля */
  size: number
  /** modules[y][x] — тёмный модуль */
  modules: boolean[][]
}

export type QrOptions = {
  /** Наименьшая и наибольшая версия; по умолчанию 1 и 10 */
  minVersion?: number
  maxVersion?: number
  /** Своя маска вместо выбора по штрафу — для сверки с эталоном */
  mask?: QrMask
}

/** Данные не помещаются в версию 10 на уровне M */
export class QrTooLong extends Error {
  constructor(public bytes: number) {
    super(`QR: ${bytes} байт не помещаются в версию 10 на уровне M`)
  }
}

export const QR_MIN_VERSION = 1
export const QR_MAX_VERSION = 10

// ── Таблицы уровня M для версий 1–10 (ISO/IEC 18004, таблица 9) ──────────────
// Индекс — версия. Кодов коррекции на блок и число блоков
const ECC_PER_BLOCK_M = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26]
const BLOCKS_M = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5]
/** Биты формата для уровня M: 00 */
const ECL_BITS_M = 0

const sideOf = (version: number) => version * 4 + 17

/** Сколько модулей версии отдано под данные и коррекцию — всё, кроме служебных узоров и полей формата и версии */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2
    result -= (25 * align - 10) * align - 55
    if (version >= 7) result -= 36
  }
  return result
}

/** Кодовых слов данных (без коррекции) у версии на уровне M */
export function qrDataCapacity(version: number): number {
  return Math.floor(rawDataModules(version) / 8) - ECC_PER_BLOCK_M[version] * BLOCKS_M[version]
}

/** Центры узоров выравнивания по одной оси: у версии 1 их нет */
function alignmentPositions(version: number): number[] {
  if (version === 1) return []
  const count = Math.floor(version / 7) + 2
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2
  const result = [6]
  for (let pos = sideOf(version) - 7; result.length < count; pos -= step) result.splice(1, 0, pos)
  return result
}

// ── Рид — Соломон над GF(256), образующий многочлен 0x11D ─────────────────────

function gfMultiply(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xff
}

/** Делитель степени degree: произведение (x − α^i), i = 0…degree−1; старший коэффициент 1 опущен */
function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j], root)
      if (j + 1 < degree) result[j] ^= result[j + 1]
    }
    root = gfMultiply(root, 0x02)
  }
  return result
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0)
  for (const b of data) {
    const factor = b ^ (result.shift() as number)
    result.push(0)
    divisor.forEach((coef, i) => (result[i] ^= gfMultiply(coef, factor)))
  }
  return result
}

// ── Данные ──────────────────────────────────────────────────────────────────

/** Строка — в UTF-8; для латиницы и цифр это те же байты, что ASCII */
function toBytes(data: string | Uint8Array): Uint8Array {
  return typeof data === 'string' ? new TextEncoder().encode(data) : data
}

/** Длина поля «число символов» в байтовом режиме: 8 бит до версии 9, 16 — с 10-й */
const countBits = (version: number) => (version <= 9 ? 8 : 16)

function pickVersion(bytes: number, min: number, max: number): number {
  for (let v = min; v <= max; v++) {
    const bits = 4 + countBits(v) + bytes * 8
    if (bits <= qrDataCapacity(v) * 8) return v
  }
  throw new QrTooLong(bytes)
}

/** Кодовые слова данных: режим 0100, длина, байты, терминатор, добивка 0xEC/0x11 */
function dataCodewords(bytes: Uint8Array, version: number): number[] {
  const bits: number[] = []
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }
  push(0b0100, 4)
  push(bytes.length, countBits(version))
  for (const b of bytes) push(b, 8)
  const capacity = qrDataCapacity(version) * 8
  push(0, Math.min(4, capacity - bits.length))
  push(0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8)
  const words: number[] = []
  for (let i = 0; i < bits.length; i += 8) words.push(bits.slice(i, i + 8).reduce((acc, b) => (acc << 1) | b, 0))
  return words
}

/** Делим на блоки, к каждому — коды коррекции, затем перемежаем: сначала данные по столбцам, потом коррекция */
function withEcc(data: number[], version: number): number[] {
  const blocks = BLOCKS_M[version]
  const eccLen = ECC_PER_BLOCK_M[version]
  const raw = Math.floor(rawDataModules(version) / 8)
  const shortBlocks = blocks - (raw % blocks)
  const shortLen = Math.floor(raw / blocks)
  const divisor = rsDivisor(eccLen)
  const parts: number[][] = []
  for (let i = 0, k = 0; i < blocks; i++) {
    const len = shortLen - eccLen + (i < shortBlocks ? 0 : 1)
    const chunk = data.slice(k, k + len)
    k += len
    const ecc = rsRemainder(chunk, divisor)
    // У коротких блоков пустое место, чтобы столбцы данных совпадали с длинными блоками
    if (i < shortBlocks) chunk.push(-1)
    parts.push([...chunk, ...ecc])
  }
  const result: number[] = []
  for (let i = 0; i < parts[0].length; i++) {
    parts.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= shortBlocks) result.push(block[i])
    })
  }
  return result
}

// ── Матрица ─────────────────────────────────────────────────────────────────

type Grid = { size: number; dark: boolean[][]; fixed: boolean[][] }

function newGrid(size: number): Grid {
  const make = () => Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  return { size, dark: make(), fixed: make() }
}

function setFixed(g: Grid, x: number, y: number, dark: boolean) {
  g.dark[y][x] = dark
  g.fixed[y][x] = true
}

/** Биты формата: уровень M и маска, BCH(15,5), маска 0x5412. Две копии */
function drawFormat(g: Grid, mask: QrMask) {
  const data = (ECL_BITS_M << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  const bits = ((data << 10) | rem) ^ 0x5412
  const bit = (i: number) => ((bits >>> i) & 1) === 1
  const n = g.size
  for (let i = 0; i <= 5; i++) setFixed(g, 8, i, bit(i))
  setFixed(g, 8, 7, bit(6))
  setFixed(g, 8, 8, bit(7))
  setFixed(g, 7, 8, bit(8))
  for (let i = 9; i < 15; i++) setFixed(g, 14 - i, 8, bit(i))
  for (let i = 0; i < 8; i++) setFixed(g, n - 1 - i, 8, bit(i))
  for (let i = 8; i < 15; i++) setFixed(g, 8, n - 15 + i, bit(i))
  // Тёмный модуль у нижнего левого узора — всегда
  setFixed(g, 8, n - 8, true)
}

/** Номер версии с 7-й: BCH(18,6), две копии 6 × 3 */
function drawVersion(g: Grid, version: number) {
  if (version < 7) return
  let rem = version
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
  const bits = (version << 12) | rem
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) === 1
    const a = g.size - 11 + (i % 3)
    const b = Math.floor(i / 3)
    setFixed(g, a, b, dark)
    setFixed(g, b, a, dark)
  }
}

function drawFinder(g: Grid, cx: number, cy: number) {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx
      const y = cy + dy
      if (x < 0 || y < 0 || x >= g.size || y >= g.size) continue
      const dist = Math.max(Math.abs(dx), Math.abs(dy))
      setFixed(g, x, y, dist !== 2 && dist !== 4)
    }
  }
}

function drawAlignment(g: Grid, cx: number, cy: number) {
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFixed(g, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
}

function drawFunctionPatterns(g: Grid, version: number) {
  const n = g.size
  for (let i = 0; i < n; i++) {
    setFixed(g, 6, i, i % 2 === 0)
    setFixed(g, i, 6, i % 2 === 0)
  }
  drawFinder(g, 3, 3)
  drawFinder(g, n - 4, 3)
  drawFinder(g, 3, n - 4)
  const align = alignmentPositions(version)
  const last = align.length - 1
  align.forEach((ax, i) =>
    align.forEach((ay, j) => {
      // Углы, где стоят узоры поиска, пропускаем
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return
      drawAlignment(g, ax, ay)
    }),
  )
  // Место под формат резервируем (маску впишем позже) и сразу пишем версию
  drawFormat(g, 0)
  drawVersion(g, version)
}

/** Укладка кодовых слов «змейкой» парами столбцов справа налево, столбец 6 пропускается */
function drawCodewords(g: Grid, words: number[]) {
  const n = g.size
  let i = 0
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < n; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? n - 1 - vert : vert
        if (!g.fixed[y][x] && i < words.length * 8) {
          g.dark[y][x] = ((words[i >>> 3] >>> (7 - (i & 7))) & 1) === 1
          i++
        }
      }
    }
  }
}

const maskFns: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
]

/** Маска обратима: второй вызов с той же маской снимает её */
function applyMask(g: Grid, mask: QrMask) {
  const fn = maskFns[mask]
  for (let y = 0; y < g.size; y++) for (let x = 0; x < g.size; x++) if (!g.fixed[y][x] && fn(x, y)) g.dark[y][x] = !g.dark[y][x]
}

// ── Штраф маски (ISO/IEC 18004, 7.8.3) ─────────────────────────────────────

const N1 = 3
const N2 = 3
const N3 = 40
const N4 = 10

/**
 * Штраф за узор, похожий на узор поиска: 1:1:3:1:1 со светлой полосой не короче 4 с одной стороны.
 * Края матрицы считаются светлыми — так свободное поле вокруг кода
 */
function finderLike(history: number[]): number {
  const n = history[1]
  const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n
  return (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) + (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0)
}

function penalty(m: boolean[][]): number {
  const n = m.length
  let result = 0
  const line = (get: (i: number) => boolean) => {
    let color = false
    let run = 0
    const history = [0, 0, 0, 0, 0, 0, 0]
    const add = (length: number) => {
      if (history[0] === 0) length += n
      history.pop()
      history.unshift(length)
    }
    for (let i = 0; i < n; i++) {
      if (get(i) === color) {
        run++
        if (run === 5) result += N1
        else if (run > 5) result++
      } else {
        add(run)
        if (!color) result += finderLike(history) * N3
        color = get(i)
        run = 1
      }
    }
    if (color) {
      add(run)
      run = 0
    }
    add(run + n)
    result += finderLike(history) * N3
  }
  for (let y = 0; y < n; y++) line((x) => m[y][x])
  for (let x = 0; x < n; x++) line((y) => m[y][x])
  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const c = m[y][x]
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) result += N2
    }
  }
  let dark = 0
  for (const row of m) for (const v of row) if (v) dark++
  const total = n * n
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1
  return result + k * N4
}

// ── Кодирование целиком ───────────────────────────────────────────────────────

/**
 * QR-код для строки (в UTF-8) или байтов: байтовый режим, уровень M, наименьшая подходящая версия от 1 до 10.
 * Бросает QrTooLong, если данные длиннее 213 байт (или не влезают в maxVersion)
 */
export function encodeQr(data: string | Uint8Array, opts: QrOptions = {}): QrCode {
  const bytes = toBytes(data)
  const min = Math.max(QR_MIN_VERSION, opts.minVersion ?? QR_MIN_VERSION)
  const max = Math.min(QR_MAX_VERSION, opts.maxVersion ?? QR_MAX_VERSION)
  const version = pickVersion(bytes.length, min, max)
  const words = withEcc(dataCodewords(bytes, version), version)
  const g = newGrid(sideOf(version))
  drawFunctionPatterns(g, version)
  drawCodewords(g, words)

  let mask = opts.mask
  if (mask === undefined) {
    let best = Infinity
    for (let k = 0; k < 8; k++) {
      const candidate = k as QrMask
      applyMask(g, candidate)
      drawFormat(g, candidate)
      const score = penalty(g.dark)
      if (score < best) {
        best = score
        mask = candidate
      }
      applyMask(g, candidate)
    }
  }
  applyMask(g, mask!)
  drawFormat(g, mask!)
  return { version, mask: mask!, size: g.size, modules: g.dark.map((row) => [...row]) }
}

/** Матрица строками «0» и «1» — для эталонов и сверки */
export const qrRows = (qr: QrCode): string[] => qr.modules.map((row) => row.map((v) => (v ? '1' : '0')).join(''))

/** Свободное поле по стандарту — 4 модуля */
export const QR_QUIET = 4

/**
 * Контур тёмных модулей одним path: по строке — отрезки подряд идущих тёмных модулей.
 * Координаты — в модулях, со сдвигом на свободное поле margin
 */
export function qrPath(qr: QrCode, margin = QR_QUIET): string {
  const parts: string[] = []
  qr.modules.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!row[x]) continue
      let end = x
      while (end + 1 < row.length && row[end + 1]) end++
      parts.push(`M${x + margin} ${y + margin}h${end - x + 1}v1h-${end - x + 1}z`)
      x = end
    }
  })
  return parts.join('')
}

export type QrSvgOptions = {
  /** Свободное поле в модулях, по умолчанию 4 */
  margin?: number
  /** Цвет модулей и фона; фон null — прозрачный */
  dark?: string
  light?: string | null
  /** Ширина и высота в единицах SVG (например, '30mm'); без неё — в модулях, растягивается по месту */
  size?: string
  /** Подпись для экранного диктора и программ просмотра */
  title?: string
}

const escapeXml = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** SVG для печати: чёткие края без сглаживания, свободное поле включено */
export function qrSvg(qr: QrCode, opts: QrSvgOptions = {}): string {
  const margin = opts.margin ?? QR_QUIET
  const side = qr.size + margin * 2
  const dark = opts.dark ?? '#000000'
  const light = opts.light === undefined ? '#ffffff' : opts.light
  const dims = opts.size ? ` width="${escapeXml(opts.size)}" height="${escapeXml(opts.size)}"` : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}"${dims} shape-rendering="crispEdges">` +
    (opts.title ? `<title>${escapeXml(opts.title)}</title>` : '') +
    (light ? `<rect width="${side}" height="${side}" fill="${escapeXml(light)}"/>` : '') +
    `<path d="${qrPath(qr, margin)}" fill="${escapeXml(dark)}"/>` +
    `</svg>`
  )
}
