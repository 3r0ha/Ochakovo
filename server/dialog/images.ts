import { existsSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type Sharp from 'sharp'
import { photos, type PhotoName } from '@shared/photos'
import { DIGITS, KVAS, type Glyph } from './glyphs'

// Картинки для ботов. Возвращаем абсолютные пути: адаптер делает path.resolve('public', path),
// и абсолютный путь проходит как есть. Фото сайта хранятся в WebP — для мессенджеров
// перекладываем их в JPEG, игровые кадры рисуем из SVG в PNG. Всё кэшируется в server/.generated.
//
// sharp загружается лениво, при первой картинке, которой ещё нет на диске. Если модуль не встал
// (нет сборки под платформу) или отрисовка упала, функции отдают null — бот отвечает текстом без картинки.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

type SharpFn = typeof Sharp

let cacheDir = join(root, 'server/.generated')
let loadSharp: () => Promise<SharpFn> = async () => (await import('sharp')).default
let sharpJob: Promise<SharpFn> | null = null
let warned = false
const pending = new Map<string, Promise<string | null>>()

/**
 * Для проверок: другой загрузчик sharp (например, падающий) и другая папка кэша.
 * Без аргументов — обратно к настоящему sharp и server/.generated
 */
export function configureImages(opts: { loadSharp?: () => Promise<SharpFn>; cacheDir?: string } = {}) {
  loadSharp = opts.loadSharp ?? (async () => (await import('sharp')).default)
  cacheDir = opts.cacheDir ?? join(root, 'server/.generated')
  sharpJob = null
  warned = false
  pending.clear()
}

function sharpModule(): Promise<SharpFn> {
  sharpJob ??= loadSharp().catch((error: unknown) => {
    sharpJob = null
    throw error
  })
  return sharpJob
}

/** Готовый файл из кэша или новый через make. Сбой — null и одна строка в журнале без подробностей запроса */
function once(file: string, make: (sharp: SharpFn, file: string) => Promise<unknown>): Promise<string | null> {
  let job = pending.get(file)
  if (!job) {
    job = (async () => {
      if (existsSync(file)) return file
      try {
        const sharp = await sharpModule()
        await mkdir(dirname(file), { recursive: true })
        await make(sharp, file)
        return file
      } catch (error) {
        if (!warned) {
          warned = true
          console.warn('[dialog] картинки для ботов не рисуются, ответы уходят текстом:', error instanceof Error ? error.name : typeof error)
        }
        pending.delete(file)
        return null
      }
    })()
    pending.set(file, job)
  }
  return job
}

/** JPEG-версия фото сайта шириной до 960 px; null — картинку сделать не вышло */
export function photoJpeg(name: PhotoName): Promise<string | null> {
  const widths = photos[name].widths
  const width = [...widths].reverse().find((w) => w <= 960) ?? widths[0]
  const source = join(root, 'public/photos', `${name}-${width}.webp`)
  // Ширина в имени: пересобранное фото другого размера (например, после кадрирования) не возьмётся из старого кэша
  return once(join(cacheDir, 'photos', `${name}-${width}.jpg`), (sharp, file) => sharp(source).jpeg({ quality: 82, mozjpeg: true }).toFile(file))
}

export type DefectKind = 'nocap' | 'lowfill' | 'label'
type BottleKind = 'ok' | DefectKind

// Та же бутылка, что в игре на сайте (src/game/Bottle.tsx, тёмная тема), но с цветами вместо CSS-переменных
const BODY = 'M15.5 10h9v6.5c0 3.6 10.5 7.4 10.5 15V89a7 7 0 0 1-7 7H12a7 7 0 0 1-7-7V31.5c0-7.6 10.5-11.4 10.5-15z'
const BRAND = '#d50032'
const INK = '#141414'
// Квас на просвет: тёплый янтарь у поверхности, густой коричневый ко дну, светлая пена
const KVASS_TOP = '#b06a26'
const KVASS_BOTTOM = '#5a2f0e'
const KVASS_FOAM = '#e7b77a'

/** Контур буквы или слова, вписанный по ширине в рамку: x, y — левый верх, w — ширина */
function glyphPath(g: Glyph, x: number, y: number, w: number, fill: string) {
  const k = w / (g.maxX - g.minX)
  return `<path transform="translate(${(x - g.minX * k).toFixed(3)} ${(y - g.minY * k).toFixed(3)}) scale(${k.toFixed(5)})" d="${g.d}" fill="${fill}"/>`
}

/** Знак «ОЧАКОВО» с сайта (public/brand/logo-wordmark-red.svg, 195×24); нет файла — этикетка без него */
let wordmark: string | null | undefined
function wordmarkPaths(): string | null {
  if (wordmark !== undefined) return wordmark
  try {
    const svg = readFileSync(join(root, 'public/brand/logo-wordmark-red.svg'), 'utf8')
    const ds = [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1])
    wordmark = ds.length ? ds.map((d) => `<path fill-rule="evenodd" d="${d}" fill="${BRAND}"/>`).join('') : null
  } catch {
    wordmark = null
  }
  return wordmark
}

/** Этикетка как в игре на сайте: белая полоса, «КВАС» красным шрифтом сайта и знак «ОЧАКОВО» под ним */
function labelSvg() {
  const mark = wordmarkPaths()
  const kvasTop = mark ? 51.6 : 53.6
  const kvasW = 22
  const kvasH = (KVAS.maxY - KVAS.minY) * (kvasW / (KVAS.maxX - KVAS.minX))
  const markW = 17
  return (
    `<rect x="5" y="49" width="30" height="21" fill="#ffffff"/>` +
    glyphPath(KVAS, 20 - kvasW / 2, kvasTop, kvasW, BRAND) +
    (mark ? `<g transform="translate(${20 - markW / 2} ${(kvasTop + kvasH + 2.2).toFixed(3)}) scale(${(markW / 195).toFixed(5)})">${mark}</g>` : '')
  )
}

/**
 * Бутылка в SVG. subtle — тонкий брак для поздних раундов: горлышко без пены,
 * небольшой недолив без пунктирной метки, этикетка чуть съехала. Кривая этикетка — та же этикетка, повёрнутая.
 */
function bottleSvg(kind: BottleKind, id: string, subtle = false) {
  const liquidTop = kind === 'lowfill' ? (subtle ? 44 : 70) : 27
  const lowfill =
    kind === 'lowfill' && !subtle
      ? `<line x1="5" x2="35" y1="27" y2="27" stroke="#ffffff" stroke-opacity="0.85" stroke-width="1.2" stroke-dasharray="2.4 2"/>`
      : ''
  const label =
    kind === 'label'
      ? subtle
        ? `<g transform="rotate(-9 20 59.5) translate(0 3.5)">${labelSvg()}</g>`
        : `<g transform="rotate(-28 20 59.5) translate(0 6)">${labelSvg()}</g>`
      : labelSvg()
  const cap =
    kind === 'nocap'
      ? `<ellipse cx="20" cy="10" rx="4.5" ry="1.4" fill="${KVASS_TOP}" stroke="#ffffff" stroke-width="1"/>` +
        (subtle ? '' : `<circle cx="17" cy="6" r="2.2" fill="#ffffff"/><circle cx="22.5" cy="4.2" r="2.8" fill="#ffffff"/><circle cx="19.5" cy="0" r="1.7" fill="#ffffff"/>`)
      : `<rect x="14" y="2" width="12" height="8.5" rx="1.2" fill="${BRAND}" stroke="#ffffff" stroke-width="1"/>` +
        `<rect x="15.5" y="3.4" width="9" height="1.2" rx="0.6" fill="#ffffff" fill-opacity="0.6"/>`
  return (
    `<defs><clipPath id="${id}"><path d="${BODY}"/></clipPath>` +
    `<linearGradient id="${id}-k" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${KVASS_TOP}"/><stop offset="1" stop-color="${KVASS_BOTTOM}"/></linearGradient></defs>` +
    `<path d="${BODY}" fill="#ffffff" fill-opacity="0.08"/>` +
    `<g clip-path="url(#${id})"><rect x="0" y="${liquidTop}" width="40" height="${96 - liquidTop}" fill="url(#${id}-k)"/>` +
    `<rect x="0" y="${liquidTop}" width="40" height="2" fill="${KVASS_FOAM}" fill-opacity="0.85"/>` +
    `<rect x="9" y="${liquidTop + 4}" width="2.6" height="${Math.max(0, 86 - liquidTop)}" rx="1.3" fill="#ffffff" fill-opacity="0.2"/>${lowfill}</g>` +
    label +
    `<path d="${BODY}" fill="none" stroke="#ffffff" stroke-opacity="0.92" stroke-width="1.4" stroke-linejoin="round"/>` +
    cap
  )
}

/** Номер бутылки шрифтом сайта: высота цифры size px, центр — cx, cy */
function digit(n: string, cx: number, cy: number, size: number) {
  const g = DIGITS[n]
  const w = size * ((g.maxX - g.minX) / (g.maxY - g.minY))
  return glyphPath(g, cx - w / 2, cy - size / 2, w, INK)
}

/**
 * Кадр раунда: count пронумерованных бутылок на ленте (4 или 6), брак — на месте defectAt.
 * subtle — тонкий брак для поздних раундов.
 */
export function gameRoundImage(defectAt: number, kind: DefectKind, count: 4 | 6 = 4, subtle = false): Promise<string | null> {
  const W = 960
  const H = 520
  const scale = count === 4 ? 3.3 : 2.6
  const step = count === 4 ? 220 : 150
  const first = count === 4 ? 150 : 105
  const top = count === 4 ? 40 : 70
  const badge = count === 4 ? { r: 30, size: 34 } : { r: 25, size: 28 }
  // Низ бутылки (y = 96 в её системе координат) стоит ровно на ленте
  const beltY = top + 96 * scale
  const bottles = Array.from({ length: count }, (_, i) => {
    const cx = first + i * step
    const x = cx - 20 * scale
    const k: BottleKind = i === defectAt ? kind : 'ok'
    return (
      `<g transform="translate(${x} ${top}) scale(${scale})">${bottleSvg(k, `b${i}`, subtle)}</g>` +
      `<circle cx="${cx}" cy="${beltY + 68}" r="${badge.r}" fill="#ffffff"/>` +
      digit(String(i + 1), cx, beltY + 68, badge.size)
    )
  }).join('')
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="${W}" height="${H}" fill="#0c0c0c"/>` +
    `<rect x="0" y="${beltY}" width="${W}" height="16" fill="#2b2b2b"/>` +
    `<rect x="0" y="${beltY}" width="${W}" height="3" fill="${BRAND}"/>` +
    bottles +
    `</svg>`
  return once(join(cacheDir, 'game', `round-v5-${count}-${defectAt}-${kind}${subtle ? '-s' : ''}.png`), (sharp, file) =>
    sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(file),
  )
}
