// Ролики «Смена изнутри»: манифест, файлы, формат MP4 (H.264 + AAC 96k, faststart), бюджет размера, постеры.
// Файлы готовит node scripts/media.mjs video. MP4 разбираем сами — ffprobe для проверки не нужен.
// Запуск: pnpm test c2-brand-media-video

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { test } from 'node:test'
import { SHIFT_VIDEOS } from '../../src/components/ShiftVideo'

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url))
const exists = (p: string) => existsSync(new URL(`../../${p}`, import.meta.url))
const pub = (url: string) => `public${url}`

type Video = {
  id: string
  profession: string
  department: string
  duration: number
  speech: boolean
  speechCheck: string
  volume: { mean: number; max: number }
  steps: string[]
  width: number
  height: number
  files: Record<'480' | '720', string>
  bytes: Record<'480' | '720', number>
  poster: Record<'avif' | 'webp', Record<string, string>>
  lqip: string
  source: string
  keep: [number, number][]
  review: string
}
const manifest = JSON.parse(read('public/video/manifest.json').toString()) as { videos: Video[]; excluded: { source: string; why: string }[] }

// ── Разбор MP4: дерево боксов ──────────────────────────────────────────────────
type Box = { type: string; start: number; end: number; body: number }
function boxes(buf: Buffer, from = 0, to = buf.length): Box[] {
  const out: Box[] = []
  let p = from
  while (p + 8 <= to) {
    let size = buf.readUInt32BE(p)
    const type = buf.toString('latin1', p + 4, p + 8)
    let header = 8
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(p + 8))
      header = 16
    } else if (size === 0) size = to - p
    out.push({ type, start: p, end: p + size, body: p + header })
    p += size
  }
  return out
}
const child = (buf: Buffer, box: Box, type: string, skip = 0) => boxes(buf, box.body + skip, box.end).find((b) => b.type === type)
function path(buf: Buffer, root: Box, ...types: string[]) {
  let cur: Box | undefined = root
  for (const t of types) {
    // stsd: 4 байта версии и флагов + 4 байта числа записей
    cur = cur && child(buf, cur, t, cur.type === 'stsd' ? 8 : 0)
    if (!cur) return undefined
  }
  return cur
}

function inspect(file: string) {
  const buf = read(file)
  const top = boxes(buf)
  const order = top.map((b) => b.type)
  const moov = top.find((b) => b.type === 'moov')!
  // mvhd: версия 0 — timescale на 12-м байте тела, duration на 16-м
  const mvhd = child(buf, moov, 'mvhd')!
  const v1 = buf[mvhd.body] === 1
  const timescale = buf.readUInt32BE(mvhd.body + (v1 ? 20 : 12))
  const duration = v1 ? Number(buf.readBigUInt64BE(mvhd.body + 24)) : buf.readUInt32BE(mvhd.body + 16)
  const tracks = boxes(buf, moov.body, moov.end)
    .filter((b) => b.type === 'trak')
    .map((trak) => {
      const tkhd = child(buf, trak, 'tkhd')!
      const tv1 = buf[tkhd.body] === 1
      const w = buf.readUInt32BE(tkhd.body + (tv1 ? 88 : 76)) / 65536
      const h = buf.readUInt32BE(tkhd.body + (tv1 ? 92 : 80)) / 65536
      const stsd = path(buf, trak, 'mdia', 'minf', 'stbl', 'stsd')!
      const entry = boxes(buf, stsd.body + 8, stsd.end)[0]
      const info: { codec: string; w: number; h: number; profile?: number; avgBitrate?: number; objectType?: number } = { codec: entry.type, w, h }
      if (entry.type === 'avc1') {
        // VisualSampleEntry — 78 байт до вложенных боксов; avcC: [версия, профиль, совместимость, уровень]
        const avcC = boxes(buf, entry.body + 78, entry.end).find((b) => b.type === 'avcC')!
        info.profile = buf[avcC.body + 1]
      }
      if (entry.type === 'mp4a') {
        // AudioSampleEntry — 28 байт; esds: ES_Descriptor(3) → DecoderConfigDescriptor(4) → avgBitrate
        const esds = boxes(buf, entry.body + 28, entry.end).find((b) => b.type === 'esds')!
        const body = buf.subarray(esds.body + 4, esds.end)
        const at = body.indexOf(0x04, 3)
        let p = at + 1
        while (body[p] & 0x80) p++
        p++
        info.objectType = body[p]
        info.avgBitrate = body.readUInt32BE(p + 9)
      }
      return info
    })
  return { order, seconds: duration / timescale, tracks, bytes: buf.length }
}

test('три ролика о профессиях, четвёртый исключён с причиной', () => {
  assert.deepEqual(
    manifest.videos.map((v) => v.id),
    ['machinist', 'bottling-operator', 'lab-assistant'],
  )
  assert.equal(new Set(manifest.videos.map((v) => v.id)).size, 3)
  const excluded = manifest.excluded.map((e) => e.source)
  assert.deepEqual(excluded, ['Процесс создания нового вкуса.mp4'])
  assert.match(manifest.excluded[0].why, /пив/)
  // Все четыре исходника учтены: три в работе, один исключён
  const sources = [...manifest.videos.map((v) => v.source.split('/').at(-1)), ...excluded].sort()
  // Исходники роликов в репозиторий не входят (.gitignore): сверяем, только когда они лежат в папке
  const originals = exists('archive/case-materials/video')
    ? readdirSync(new URL('../../archive/case-materials/video', import.meta.url)).filter((f) => f.endsWith('.mp4')).sort()
    : []
  if (originals.length) assert.deepEqual(sources, originals)
  // Исключённый ролик никуда не попал
  assert.ok(!readdirSync(new URL('../../public/video', import.meta.url)).some((f) => /flavor|вкус|kern/i.test(f)))
})

test('в манифесте профессия, отдел, длительность, речь, титры; тексты без восклицаний', () => {
  for (const v of manifest.videos) {
    assert.ok(v.profession && v.department, v.id)
    assert.equal(typeof v.speech, 'boolean')
    assert.ok(v.speechCheck.length > 20, 'как проверяли речь')
    assert.ok(Number.isFinite(v.volume.mean) && Number.isFinite(v.volume.max), 'volumedetect')
    assert.ok(v.steps.length >= 4, `${v.id}: титры ролика`)
    for (const text of [v.profession, v.department, v.review, v.speechCheck, ...v.steps]) {
      assert.doesNotMatch(text, /!/)
      assert.doesNotMatch(text, /\b(19|20)\d{2}\b/, 'без дат и годов')
    }
    // Сцены по порядку, не пересекаются; сумма — длительность ролика
    let prev = -1
    let total = 0
    for (const [a, b] of v.keep) {
      assert.ok(a >= prev && b > a, `${v.id}: сцены ${a}–${b}`)
      prev = b
      total += b - a
    }
    assert.ok(Math.abs(total - v.duration) < 0.2, `${v.id}: ${total} против ${v.duration}`)
  }
  for (const e of manifest.excluded) assert.doesNotMatch(e.why, /!/)
})

test('MP4: H.264 и AAC 96 кбит/с, faststart, 720p до 4 МБ и 480p', () => {
  for (const v of manifest.videos) {
    for (const [q, height, profile] of [
      ['720', 720, 100],
      ['480', 480, 77],
    ] as const) {
      const file = pub(v.files[q])
      const mp4 = inspect(file)
      assert.equal(mp4.bytes, statSync(new URL(`../../${file}`, import.meta.url)).size)
      assert.equal(mp4.bytes, v.bytes[q], `${file}: размер в манифесте`)
      // faststart: описание ролика (moov) до данных (mdat) — браузер начинает показ, не дожидаясь конца файла
      assert.ok(mp4.order.indexOf('moov') >= 0 && mp4.order.indexOf('moov') < mp4.order.indexOf('mdat'), `${file}: ${mp4.order.join(',')}`)
      const video = mp4.tracks.find((t) => t.codec === 'avc1')
      const audio = mp4.tracks.find((t) => t.codec === 'mp4a')
      assert.ok(video, `${file}: H.264`)
      assert.equal(video.h, height, `${file}: высота`)
      // Ширина показа 16:9: у 480p — 853⅓ при кадре 854 px
      assert.ok(Math.abs(video.w - (height * 16) / 9) < 1, `${file}: ширина ${video.w}`)
      assert.equal(video.profile, profile, `${file}: профиль H.264 (High — 100, Main — 77)`)
      assert.ok(audio, `${file}: AAC`)
      assert.equal(audio.objectType, 0x40, 'AAC')
      assert.ok(Math.abs(audio.avgBitrate! - 96_000) < 4_000, `${file}: звук ${audio.avgBitrate} бит/с`)
      assert.ok(Math.abs(mp4.seconds - v.duration) < 0.15, `${file}: ${mp4.seconds} с`)
      if (q === '720') assert.ok(mp4.bytes <= 4_000_000, `${file}: ${(mp4.bytes / 1e6).toFixed(2)} МБ — больше 4 МБ`)
      else assert.ok(mp4.bytes < v.bytes['720'] * 0.6, `${file}: 480p заметно легче 720p`)
    }
  }
})

test('постеры AVIF и WebP в двух ширинах и мини-превью', () => {
  for (const v of manifest.videos) {
    for (const format of ['avif', 'webp'] as const) {
      assert.deepEqual(Object.keys(v.poster[format]).sort(), ['1280', '640'])
      for (const url of Object.values(v.poster[format])) {
        const buf = read(pub(url))
        if (format === 'webp') assert.equal(buf.toString('latin1', 8, 12), 'WEBP', url)
        else assert.equal(buf.toString('latin1', 8, 12), 'avif', url)
        assert.ok(buf.length < 80_000, `${url}: ${buf.length} байт`)
      }
    }
    assert.match(v.lqip, /^data:image\/webp;base64,[A-Za-z0-9+/=]{40,}$/)
    assert.ok(v.lqip.length < 400)
  }
})

test('данные в ShiftVideo.tsx совпадают с манифестом', () => {
  assert.equal(SHIFT_VIDEOS.length, manifest.videos.length)
  for (const [i, v] of manifest.videos.entries()) {
    const s = SHIFT_VIDEOS[i]
    assert.deepEqual(
      { id: s.id, profession: s.profession, department: s.department, duration: s.duration, speech: s.speech, steps: [...s.steps], files: { ...s.files }, lqip: s.lqip },
      { id: v.id, profession: v.profession, department: v.department, duration: v.duration, speech: v.speech, steps: v.steps, files: v.files, lqip: v.lqip },
      'перезапустите node scripts/media.mjs video',
    )
  }
})

test('в public/video только файлы из манифеста', () => {
  const listed = new Set(['manifest.json'])
  for (const v of manifest.videos) {
    for (const url of [...Object.values(v.files), ...Object.values(v.poster.avif), ...Object.values(v.poster.webp)]) listed.add(url.replace('/video/', ''))
  }
  assert.deepEqual(readdirSync(new URL('../../public/video', import.meta.url)).sort(), [...listed].sort())
})
