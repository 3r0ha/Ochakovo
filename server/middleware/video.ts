import { createReadStream, statSync, type Stats } from 'node:fs'
import { extname, join } from 'node:path'
import { Readable } from 'node:stream'
import type { MiddlewareHandler } from 'hono'

// Ролики «Смена изнутри» и их постеры: /video/* из собранного сайта (public/video → dist/video, node scripts/media.mjs video).
//
// Safari и плееры на iPhone играют <video> только с сервера, который отвечает на Range кодом 206: первый запрос —
// bytes=0-1, дальше кусками. Поэтому здесь свой обработчик, а не общий serveStatic:
//  • Range — один диапазон: 206 и Content-Range; за пределами файла — 416 с размером; несколько диапазонов или
//    непонятный заголовок — весь файл с 200, так разрешает HTTP;
//  • Accept-Ranges: bytes — в каждом ответе, плеер сразу знает, что можно перематывать;
//  • If-Range: файл поменялся с прошлого куска — отдаём весь файл заново, а не кусок нового;
//  • ETag и Last-Modified, повторный запрос с If-None-Match или If-Modified-Since — 304 без тела;
//  • без сжатия: MP4 и картинки уже сжаты, а no-transform не даёт сжимать ни compress(), ни прокси;
//  • кэш 30 дней; с ?v=<версия> в адресе — год и immutable (адрес меняется вместе с файлом).
// Имена — только латиница, цифры, точка, дефис и подчёркивание: никаких «..» и вложенных папок.

const types: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.avif': 'image/avif',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
}

/** Кэш ролика без версии в адресе: 30 дней */
export const VIDEO_CACHE = 'public, max-age=2592000, no-transform'
/** Кэш ролика с ?v=<версия>: год, без перепроверки */
export const VIDEO_CACHE_VERSIONED = 'public, max-age=31536000, immutable, no-transform'

const NAME = /^[a-z0-9][a-z0-9._-]{0,127}$/i

export type ByteRange = { start: number; end: number }

/**
 * Разбор Range для файла размера size.
 * null — заголовка нет, он непонятный или диапазонов несколько: отдаём весь файл;
 * 'unsatisfiable' — диапазон за пределами файла: 416
 */
export function parseRange(header: string | undefined, size: number): ByteRange | 'unsatisfiable' | null {
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header ?? '')
  if (!m || (m[1] === '' && m[2] === '')) return null
  if (m[1] === '') {
    // Последние N байт
    const n = Number(m[2])
    if (!n || !size) return 'unsatisfiable'
    return { start: Math.max(0, size - n), end: size - 1 }
  }
  const start = Number(m[1])
  if (m[2] !== '' && Number(m[2]) < start) return null
  if (start >= size) return 'unsatisfiable'
  return { start, end: m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1) }
}

/** Слабое сравнение ETag для If-None-Match: W/"x" и "x" — один и тот же */
const weakMatch = (header: string, etag: string) => {
  const bare = (t: string) => t.trim().replace(/^W\//, '')
  return header.split(',').some((t) => t.trim() === '*' || bare(t) === bare(etag))
}

const etagOf = (st: Stats) => `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`

/** Даты HTTP — с точностью до секунды */
const seconds = (ms: number) => Math.floor(ms / 1000)

/** Кусок можно отдать, только если файл тот же, что у первого куска (If-Range — ETag или дата) */
function sameFile(ifRange: string | undefined, etag: string, st: Stats) {
  if (!ifRange) return true
  const v = ifRange.trim()
  if (v.startsWith('"') || v.startsWith('W/')) return v === etag
  const t = Date.parse(v)
  return Number.isFinite(t) && seconds(t) === seconds(st.mtimeMs)
}

/** Раздача /video/<имя> из папки root (dist/video). Чего нет — дальше по цепочке: там честный 404 */
export function videoFiles({ root }: { root: string }): MiddlewareHandler {
  return async (c, next) => {
    const name = c.req.path.slice('/video/'.length)
    const type = types[extname(name).toLowerCase()]
    if (!NAME.test(name) || name.includes('..') || !type) return next()
    let st: Stats
    const file = join(root, name)
    try {
      st = statSync(file)
    } catch {
      return next()
    }
    if (!st.isFile()) return next()

    const etag = etagOf(st)
    const lastModified = new Date(seconds(st.mtimeMs) * 1000).toUTCString()
    const headers = new Headers({
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      ETag: etag,
      'Last-Modified': lastModified,
      'Cache-Control': c.req.query('v') ? VIDEO_CACHE_VERSIONED : VIDEO_CACHE,
    })

    // Повторный запрос того же файла — без тела
    const ifNoneMatch = c.req.header('if-none-match')
    const ifModifiedSince = c.req.header('if-modified-since')
    const notModified = ifNoneMatch
      ? weakMatch(ifNoneMatch, etag)
      : Boolean(ifModifiedSince) && Number.isFinite(Date.parse(ifModifiedSince!)) && seconds(st.mtimeMs) <= seconds(Date.parse(ifModifiedSince!))
    if (notModified) return new Response(null, { status: 304, headers })

    const range = sameFile(c.req.header('if-range'), etag, st) ? parseRange(c.req.header('range'), st.size) : null
    if (range === 'unsatisfiable') {
      headers.set('Content-Range', `bytes */${st.size}`)
      headers.set('Content-Length', '0')
      return new Response(null, { status: 416, headers })
    }
    const { start, end } = range ?? { start: 0, end: st.size - 1 }
    const length = st.size ? end - start + 1 : 0
    headers.set('Content-Length', String(length))
    if (range) headers.set('Content-Range', `bytes ${start}-${end}/${st.size}`)
    const status = range ? 206 : 200
    // HEAD: только заголовки — файл не открываем
    if (c.req.method === 'HEAD' || !length) return new Response(null, { status, headers })
    const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array>
    return new Response(body, { status, headers })
  }
}
