import { BOTTLE_BODY, KVASS_BOTTOM, KVASS_TOP, LABEL_BOX } from './Bottle'
import { KVAS_GLYPH, WORDMARK } from './label'
import { defectsTotal, plural } from './result'
import type { GameStats } from './useConveyorGame'

// Картинка результата «Поймай брак» для сторис: PNG 1080×1920 из canvas — счёт, «Поймай брак» и адрес сайта.
// Числа на картинке — те же, что в итоге раунда (storyLines сверяет scripts/tests/w2-game-story.test.ts).
// Плоские цвета без шума и фото: файл выходит в десятки килобайт, предел — 400 КБ

export const STORY_W = 1080
export const STORY_H = 1920
/** Предел размера файла: больше — сторис грузится долго, а соцсети пережимают картинку */
export const STORY_MAX_BYTES = 400 * 1024

const NIGHT = '#0c0a08'
const RED = '#d50032'
const WHITE = '#ffffff'
const QUIET = 'rgba(255,255,255,0.72)'
const DISPLAY = '"Sofia Sans Extra Condensed Variable", "Arial Narrow", sans-serif'
const TEXT = '"Onest Variable", system-ui, sans-serif'

/** Тексты картинки: только из раунда. site — адрес сайта без протокола */
export function storyLines(s: GameStats, site: string) {
  const total = defectsTotal(s)
  return {
    eyebrow: `Игра на ${s.seconds} ${plural(s.seconds, ['секунду', 'секунды', 'секунд'])}`,
    title: ['Поймай', 'брак'] as const,
    score: String(s.score),
    scoreWord: plural(s.score, ['очко', 'очка', 'очков']),
    caught: `Поймано ${s.caught} из ${total}`,
    extra: `Лишних нажатий: ${s.mistakes}`,
    cta: 'Сыграть',
    site: `${site.replace(/^https?:\/\//, '').replace(/\/+$/, '')}/game`,
  }
}

/** Имя файла без даты: счёт и название игры */
export const storyFileName = (s: GameStats) => `poymay-brak-${s.score}.png`

/** «КВАС» на этикетке: ширина 22 из 40 единиц бутылки, по центру белой полосы — как на маленькой бутылке игры */
const KVAS_K = 22 / (KVAS_GLYPH.maxX - KVAS_GLYPH.minX)
const KVAS_X = 20 - 11 - KVAS_GLYPH.minX * KVAS_K
const KVAS_Y = LABEL_BOX.y + (LABEL_BOX.height - (KVAS_GLYPH.maxY - KVAS_GLYPH.minY) * KVAS_K) / 2 - KVAS_GLYPH.minY * KVAS_K

/** Бутылка игры: контур белый, налив цвета кваса до уровня level (0…1), белая этикетка с красным «КВАС» */
function bottle(ctx: CanvasRenderingContext2D, x: number, y: number, h: number, level: number, stroke = WHITE) {
  const k = h / 100
  const body = new Path2D(BOTTLE_BODY)
  ctx.save()
  ctx.translate(x, y)
  ctx.scale(k, k)
  if (level > 0) {
    ctx.save()
    ctx.clip(body)
    const top = 10 + (1 - level) * 86
    const g = ctx.createLinearGradient(0, top, 0, 96)
    g.addColorStop(0, KVASS_TOP)
    g.addColorStop(1, KVASS_BOTTOM)
    ctx.fillStyle = g
    ctx.fillRect(0, top, 40, 96 - top)
    ctx.restore()
  }
  ctx.fillStyle = WHITE
  ctx.fillRect(LABEL_BOX.x, LABEL_BOX.y, LABEL_BOX.width, LABEL_BOX.height)
  ctx.save()
  ctx.translate(KVAS_X, KVAS_Y)
  ctx.scale(KVAS_K, KVAS_K)
  ctx.fillStyle = RED
  ctx.fill(new Path2D(KVAS_GLYPH.d))
  ctx.restore()
  ctx.lineWidth = 1.6
  ctx.lineJoin = 'round'
  ctx.strokeStyle = stroke
  ctx.stroke(body)
  ctx.restore()
}

/** Рисует картинку и отдаёт PNG. Шрифты сайта догружаются заранее, иначе canvas возьмёт запасные */
export async function renderStory(s: GameStats, site = window.location.host): Promise<Blob> {
  const lines = storyLines(s, site)
  try {
    await Promise.all([
      document.fonts.load(`900 120px ${DISPLAY}`, 'ПОЙМАЙ БРАК 0123456789 Иглнасекудот'),
      document.fonts.load(`500 56px ${TEXT}`, `${lines.caught} ${lines.extra} ${lines.site}`),
    ])
  } catch {
    // шрифт не догрузился — нарисуем запасным
  }
  const canvas = document.createElement('canvas')
  canvas.width = STORY_W
  canvas.height = STORY_H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas недоступен')
  const pad = 96

  ctx.fillStyle = NIGHT
  ctx.fillRect(0, 0, STORY_W, STORY_H)

  // Знак «ОЧАКОВО» — готовый контур из label.ts, белым
  const markW = 300
  ctx.save()
  ctx.translate(pad, 140)
  ctx.scale(markW / WORDMARK.width, markW / WORDMARK.width)
  ctx.fillStyle = WHITE
  ctx.fill(new Path2D(WORDMARK.d), 'evenodd')
  ctx.restore()

  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = QUIET
  ctx.font = `800 44px ${DISPLAY}`
  ctx.fillText(lines.eyebrow.toUpperCase(), pad, 330)

  // «Поймай брак» — как заголовок страницы игры: первое слово белым, второе красным
  ctx.font = `900 250px ${DISPLAY}`
  ctx.fillStyle = WHITE
  ctx.fillText(lines.title[0].toUpperCase(), pad - 6, 560)
  ctx.fillStyle = RED
  ctx.fillText(lines.title[1].toUpperCase(), pad - 6, 780)

  // Счёт
  ctx.fillStyle = WHITE
  ctx.font = `900 400px ${DISPLAY}`
  ctx.fillText(lines.score, pad - 10, 1170)
  const scoreW = ctx.measureText(lines.score).width
  ctx.fillStyle = QUIET
  ctx.font = `800 72px ${DISPLAY}`
  ctx.fillText(lines.scoreWord.toUpperCase(), pad + scoreW + 24, 1170)

  ctx.fillStyle = WHITE
  ctx.font = `500 58px ${TEXT}`
  ctx.fillText(lines.caught, pad, 1280)
  ctx.fillStyle = QUIET
  ctx.fillText(lines.extra, pad, 1360)

  // Лента: красная полоса и бутылки кваса без брака — картинка не подсказывает ответов
  const beltY = 1650
  for (let i = 0; i < 6; i++) bottle(ctx, pad + i * 156, beltY - 200, 200, 0.78)
  ctx.fillStyle = RED
  ctx.fillRect(0, beltY, STORY_W, 10)

  ctx.fillStyle = QUIET
  ctx.font = `500 40px ${TEXT}`
  ctx.fillText(lines.cta, pad, 1770)
  ctx.fillStyle = WHITE
  ctx.font = `600 52px ${TEXT}`
  ctx.fillText(lines.site, pad, 1840)

  return await new Promise<Blob>((done, fail) => canvas.toBlob((b) => (b ? done(b) : fail(new Error('PNG не собрался'))), 'image/png'))
}

/**
 * Отдать картинку: на телефоне — системное меню «Поделиться» с файлом (сразу в сторис), иначе — скачивание.
 * 'cancelled' — человек закрыл меню
 */
export async function saveStory(blob: Blob, name: string): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const file = new File([blob], name, { type: 'image/png' })
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Поймай брак' })
      return 'shared'
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return 'cancelled'
      // share с файлом не прошёл — скачиваем
    }
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return 'downloaded'
}
