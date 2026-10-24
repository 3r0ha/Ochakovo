import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Ролики «Смена изнутри» для бота: ссылки на файлы, которые раздаёт сайт (public/video, манифест — node scripts/media.mjs video).
// В мессенджер ролик уходит ссылкой: 480p — около 1,6 МБ, открывается в браузере телефона.
// Нет манифеста или ролика — кнопки просто нет.

type ManifestVideo = { id: string; profession: string; duration: number; speech?: boolean; files: Record<string, string> }

const manifestPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/video/manifest.json')

let cache: ManifestVideo[] | null = null

function videos(): ManifestVideo[] {
  if (cache) return cache
  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as { videos?: ManifestVideo[] }
    cache = (raw.videos ?? []).filter((v) => typeof v.id === 'string' && v.files && (v.files['480'] || v.files['720']))
  } catch {
    cache = []
  }
  return cache
}

/** Какой ролик показывает работу вакансии: по «Описанию практики» и подписям роликов (c2-brand-media) */
const byVacancy: Record<string, string> = { 'bottling-operator': 'bottling-operator', 'lab-chemist': 'lab-assistant' }

/** 27 → «0:27», 31.3 → «0:31» */
export const durationLabel = (seconds: number) => {
  const s = Math.round(seconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export type ShiftVideoLink = { id: string; profession: string; duration: string; url: string; speech: boolean }

/** Ссылка на ролик по id из манифеста; base — адрес сайта без «/» в конце */
export function shiftVideo(id: string, base: string): ShiftVideoLink | null {
  const v = videos().find((x) => x.id === id)
  const file = v?.files['480'] ?? v?.files['720']
  if (!v || !file) return null
  return { id: v.id, profession: v.profession, duration: durationLabel(v.duration), url: `${base}${file.startsWith('/') ? '' : '/'}${file}`, speech: v.speech === true }
}

/** Ролик о работе этой вакансии или null */
export const shiftVideoForVacancy = (vacancyId: string, base: string) => (byVacancy[vacancyId] ? shiftVideo(byVacancy[vacancyId], base) : null)

/** Ролики о ролях оплачиваемой практики — в порядке ролей */
export const practiceVideos = (base: string) => Object.values(byVacancy).flatMap((id) => shiftVideo(id, base) ?? [])
