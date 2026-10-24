import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Картинки для мессенджеров: поиск файла, перевод WebP/AVIF в JPEG и кэш загрузок.
// Telegram отдаёт file_id, MAX — токен картинки; оба можно переиспользовать, поэтому каждый файл грузим один раз.

export type MediaFile = { data: Uint8Array<ArrayBuffer>; filename: string; mime: string }

const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif' }

/**
 * Путь из OutMessage.image.path: абсолютный, относительно public/ (как на сайте: 'photos/x-960.webp')
 * или относительно корня проекта (сгенерированные картинки сценариев).
 */
export async function loadMedia(imagePath: string, publicDir: string): Promise<MediaFile> {
  const candidates = path.isAbsolute(imagePath)
    ? [imagePath]
    : [path.resolve(publicDir, imagePath.replace(/^\/+/, '')), path.resolve(process.cwd(), imagePath)]

  let data: Uint8Array<ArrayBuffer> | null = null
  let found = ''
  for (const file of candidates) {
    try {
      data = new Uint8Array(await readFile(file))
      found = file
      break
    } catch {
      // пробуем следующий вариант
    }
  }
  if (!data) throw new Error(`Картинка не найдена: ${imagePath}`)

  const ext = path.extname(found).toLowerCase()
  const base = path.basename(found, ext)
  if (MIME[ext]) return { data, filename: base + ext, mime: MIME[ext] }

  // WebP и AVIF мессенджеры принимают не везде — переводим в JPEG
  try {
    const { default: sharp } = await import('sharp')
    const jpeg = await sharp(data).jpeg({ quality: 85 }).toBuffer()
    return { data: new Uint8Array(jpeg), filename: `${base}.jpg`, mime: 'image/jpeg' }
  } catch {
    return { data, filename: base + ext, mime: ext === '.webp' ? 'image/webp' : 'application/octet-stream' }
  }
}

/** Кэш «файл → идентификатор в мессенджере» на время жизни процесса */
export class MediaCache {
  private ids = new Map<string, string>()
  private pending = new Map<string, Promise<string>>()

  get(imagePath: string) {
    return this.ids.get(imagePath)
  }

  set(imagePath: string, id: string) {
    this.ids.set(imagePath, id)
  }

  /** Загружает файл один раз, даже если его одновременно запросили несколько чатов */
  async getOrUpload(imagePath: string, upload: () => Promise<string>): Promise<string> {
    const cached = this.ids.get(imagePath)
    if (cached) return cached
    const inFlight = this.pending.get(imagePath)
    if (inFlight) return inFlight
    const job = upload()
      .then((id) => {
        this.ids.set(imagePath, id)
        return id
      })
      .finally(() => this.pending.delete(imagePath))
    this.pending.set(imagePath, job)
    return job
  }

  forget(imagePath: string) {
    this.ids.delete(imagePath)
  }
}

export const defaultPublicDir = () => path.resolve(process.cwd(), 'public')

// ── Картинки сценариев для браузера ──────────────────────────────────────
// Движок отдаёт картинки путями на диске: сгенерированные — в server/.generated, фото сайта — в public.
// Чат на сайте и предпросмотр ботов в HR-панели показывают их по адресам /api/media/gen/… и /api/media/pub/…

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const mediaRoots = { gen: path.join(projectRoot, 'server/.generated'), pub: path.join(projectRoot, 'public') } as const
export type MediaRoot = keyof typeof mediaRoots

/** Путь картинки из OutMessage → адрес для браузера; null — файл вне разрешённых папок */
export function mediaUrl(imagePath: string): string | null {
  const abs = path.isAbsolute(imagePath) ? imagePath : path.resolve(mediaRoots.pub, imagePath)
  for (const key of Object.keys(mediaRoots) as MediaRoot[]) {
    const base = mediaRoots[key]
    if (abs.startsWith(base + path.sep)) return `/api/media/${key}/${path.relative(base, abs).split(path.sep).map(encodeURIComponent).join('/')}`
  }
  return null
}

/** Путь картинки без адреса на диске сервера: от корня проекта или от public — для показа в HR-панели */
export function displayPath(imagePath: string): string {
  const abs = path.isAbsolute(imagePath) ? imagePath : path.resolve(mediaRoots.pub, imagePath)
  if (abs.startsWith(mediaRoots.pub + path.sep)) return path.relative(mediaRoots.pub, abs).split(path.sep).join('/')
  if (abs.startsWith(projectRoot + path.sep)) return path.relative(projectRoot, abs).split(path.sep).join('/')
  return path.basename(abs)
}
