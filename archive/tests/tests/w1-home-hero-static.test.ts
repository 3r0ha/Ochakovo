// Первый экран и общее для главной — по исходникам: слова кейса, сумма без проявления, движение без GSAP и вечных
// циклов, «Смена» цвета кваса, «Позвать друга» с личным кодом, остановка лент, шов-ленты, появление заголовков.
// В браузере то же проверяет scripts/e2e/home-hero.ts. Запуск: pnpm test w1-home-hero

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const hero = read('src/home/Hero.tsx')
const kit = read('src/home/kit.tsx')
const belt = read('src/home/HeroBelt.tsx')
const final = read('src/home/FinalBand.tsx')
const home = read('src/pages/Home.tsx')
const motion = read('src/lib/motion.ts')
const css = read('src/index.css')
/** Без комментариев: проверяем код, а не пояснения к нему */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

test('первый экран: слова кейса под суммой — практика, студенты и выпускники, 18 лет, с марта по сентябрь', () => {
  const facts = (name: string) => hero.match(new RegExp(`const ${name} = nb\\('([^']+)'\\)`))?.[1] ?? ''
  // По полному кейсу: оплачиваемая практика и работа, формата «сезонная работа» у вакансий больше нет (docs/case-delta.md).
  // Разделитель «·» держится за предыдущее слово неразрывным пробелом — строка не начинается с точки
  const plainFacts = (name: string) => facts(name).replace(/\\u00A0/g, ' ')
  assert.equal(plainFacts('FACTS_WIDE'), 'Оплачиваемая практика и работа · студентам и выпускникам с 18 лет · сезон с марта по сентябрь')
  assert.equal(plainFacts('FACTS_SHORT'), 'Оплачиваемая практика и работа · с 18 лет · сезон с марта по сентябрь')
  for (const name of ['FACTS_WIDE', 'FACTS_SHORT']) assert.doesNotMatch(facts(name), / ·/, `${name}: обычный пробел перед «·»`)
  // Строка фактов идёт после суммы и «на руки», до кнопок
  const at = (s: string) => hero.indexOf(s)
  assert.ok(at('data-hero-sum') < at('на руки от') && at('на руки от') < at('data-hero-facts') && at('data-hero-facts') < at('hero-apply'))
  // Заголовок и кнопки прежние
  for (const s of ['<FitLine max="var(--hero-cap-m)">Работа</FitLine>', '<FitLine max="var(--hero-cap-m)">на лето</FitLine>', 'Работа на лето</FitLine>', 'Откликнуться', 'Поймай брак · 20 с', 'Моя заявка']) assert.ok(hero.includes(s), s)
})

test('кегль заголовка ограничен долей высоты окна отдельным свойством FitLine — только у первого экрана', () => {
  assert.match(hero, /<FitLine max="var\(--hero-cap\)">Работа на лето<\/FitLine>/)
  assert.match(css, /\.hero \{ --hero-cap: 21svh; --hero-cap-m: 1000px; --hero-photo-h: min\(26svh, 300px\); \}/)
  // Телефон с низким экраном: строки заголовка с потолком, полоса кадра ниже — кнопка в первом экране
  assert.match(css, /@media \(width < 768px\) and \(height <= 760px\) \{\s*\.hero \{ --hero-cap-m: [\d.]+svh; --hero-photo-h: \d+svh; \}/)
  const caps = [...css.matchAll(/--hero-cap: (\d+)svh/g)].map((m) => Number(m[1]))
  assert.ok(caps.length >= 2 && caps.every((c) => c <= 21), `потолки: ${caps}`)
  // В других местах FitLine без потолка — финальная полоса и 404 не меняются
  assert.equal([...final.matchAll(/<FitLine max=/g)].length, 0)
  // Строка с потолком законно уже контейнера — ResizeObserver не перемеряет её по кругу
  assert.match(kit, /if \(diff > 1 \|\| \(!max && diff < -box\.clientWidth \* 0\.02\)\) measure\(\)/)
})

test('затемнение под текстом на ноутбуке: слева 0,75 до 60 %, снизу почти чёрное; низкий экран — кадр выше', () => {
  const shade = css.slice(css.indexOf('@media (width >= 768px) {\n  /* Снизу'), css.indexOf('/* Потолок кегля'))
  assert.match(shade, /linear-gradient\(90deg, rgba\(12, 12, 12, 0\.75\) 0%.*rgba\(12, 12, 12, 0\) 60%\)/)
  assert.match(shade, /linear-gradient\(0deg, #0c0c0c 0, rgba\(12, 12, 12, 0\.9\)/)
  assert.match(css, /@media \(width >= 768px\) and \(height <= 800px\) \{[^}]*\.hero \{ --hero-cap: 18svh; \}[^]*?\.hero-copy \{ padding-top: 4rem; \}/)
})

test('сумма, «на руки», факты и кнопки без проявления: GSAP нет, движутся только фото и строки заголовка — не дольше 0,4 с', () => {
  for (const [name, src] of [
    ['Hero.tsx', hero],
    ['motion.ts', motion],
    ['Home.tsx', home],
    ['HeroBelt.tsx', belt],
    ['kit.tsx', kit],
  ])
    assert.doesNotMatch(src, /from ['"](gsap|@gsap\/react)/, `${name}: импорт gsap`)
  for (const file of readdirSync(new URL('../../src/home/', import.meta.url)).filter((f) => /\.tsx?$/.test(f)))
    assert.doesNotMatch(read(`src/home/${file}`), /from ['"](gsap|@gsap\/react)/, `src/home/${file}`)
  assert.doesNotMatch(hero, /hero-fade|opacity-0/)
  // Анимации первого экрана — CSS, только transform, не дольше 0,4 с и только без «уменьшить движение»
  const anims = css.slice(css.indexOf('@keyframes hero-zoom'), css.indexOf('/* Затемнение под фото'))
  assert.match(anims, /@keyframes hero-zoom \{\s*from \{ transform: scale\([\d.]+\); \}/)
  assert.match(anims, /@keyframes hero-rise \{\s*from \{ transform: translateY\(105%\); \}/)
  const durations = [...anims.matchAll(/animation: hero-\w+ ([\d.]+)s/g)].map((m) => Number(m[1]))
  assert.ok(durations.length === 2 && durations.every((d) => d <= 0.4), `длительности: ${durations}`)
  assert.match(anims, /@media \(prefers-reduced-motion: no-preference\) \{\s*\.hero-photo/)
  // Строки заголовка выезжают из-под маски: обёртки overflow-hidden на месте
  assert.equal([...hero.matchAll(/overflow-hidden[^"]*">\s*<span className="hero-line/g)].length, 3)
  // Параллакс — motion от прокрутки, при «уменьшить движение» его нет
  assert.match(hero, /useScroll\(\{ target: scope/)
  assert.match(hero, /style=\{calm \? undefined : \{ y: drift \}\}/)
})

test('Lenis: свой цикл кадров от ввода и scrollTo, сам встаёт; на касаниях и при «уменьшить движение» его нет', () => {
  const m = code(motion)
  assert.match(m, /new Lenis\(\{[^}]*autoRaf: false/)
  assert.match(m, /\['wheel', 'touchstart', 'keydown', 'scroll'\]/)
  assert.match(m, /frame = idle > 2 \? 0 : requestAnimationFrame\(loop\)/)
  assert.match(m, /\(pointer: coarse\)/)
  assert.match(m, /lenis\.scrollTo\(el, [^)]*\)\s*wake\(\)/)
  assert.doesNotMatch(m, /ticker|ScrollTrigger/)
  // Зерно статично: ни анимации, ни кадров
  assert.doesNotMatch(css, /grain-shift|\.grain \{[^}]*animation/)
  assert.match(home, /<div className="grain size-full" \/>/)
})

test('useReveal: IntersectionObserver один раз, класс ставит JS, при «уменьшить движение» — ничего', () => {
  const m = code(motion)
  assert.match(m, /export function useReveal<T extends HTMLElement = HTMLElement>\(\): RefObject<T \| null>/)
  assert.match(m, /prefersReducedMotion\(\)\) return/)
  assert.match(m, /io\.disconnect\(\)\s*el\.classList\.add\('reveal-mask'\)\s*void el\.offsetWidth\s*el\.addEventListener\('transitionend', done\)\s*el\.classList\.add\('reveal-in'\)/)
  assert.match(css, /\.reveal \{\s*transform: translateY\(var\(--reveal-shift\)\);/)
  // Сдвиг считается по тексту, наблюдатель продлён вниз на сдвиг: растянутый сеткой заголовок тоже появляется
  assert.match(m, /const shift = Math\.ceil\(text\.bottom - box\.top\)/)
  assert.match(m, /rootMargin: `0px 0px \$\{Math\.round\(shift - window\.innerHeight \* 0\.08\)\}px 0px`/)
  assert.match(css, /\.reveal\.reveal-mask\.reveal-in \{[^}]*transform 0\.9s/)
  // Пока ждёт — без маски: элемент под маской наблюдатель считает невидимым
  assert.doesNotMatch(css.slice(css.indexOf('.reveal {'), css.indexOf('.reveal.reveal-mask {')), /clip-path/)
})

test('«Смена»: силуэт бутылки из игры, налив цвета кваса, на красной полосе белый', () => {
  assert.match(kit, /import \{ BottleShape \} from '\.\.\/game\/Bottle'/)
  assert.match(kit, /<BottleShape level=\{full \? 1 : 0\} fill=\{onRed \? 'white' : 'kvass'\}/)
  assert.doesNotMatch(kit, /fill="var\(--color-brand\)"/)
  assert.match(final, /<ShiftBottle key=\{t\.id\} full=\{!!done\[t\.id\]\} onRed /)
  // Метка задания на красной секции — тоже белый налив, свойством, без подмены цвета снаружи
  const label = kit.slice(kit.indexOf('export function TaskLabel'), kit.indexOf('/** Заголовок обычной секции'))
  assert.match(label, /<ShiftBottle key=\{t\.id\} full=\{!!done\[t\.id\]\} onRed=\{onRed\}/)
})

test('«Позвать друга»: ссылка с личным кодом, кнопка в первом экране и финале и до заявки', () => {
  assert.match(kit, /import \{ inviteUrl \} from '\.\.\/lib\/ref'/)
  assert.match(kit, /const url = inviteUrl\(\)/)
  assert.doesNotMatch(kit, /src=friend/)
  // До заявки (ветка без sent) кнопка тоже есть
  const heroIdle = hero.slice(hero.indexOf(') : ('), hero.indexOf('{status &&'))
  assert.match(heroIdle, /onClick=\{invite\}[^>]*>\s*Позвать друга/)
  const finalIdle = final.slice(final.indexOf(') : ('), final.indexOf('{status &&'))
  assert.match(finalIdle, /onClick=\{invite\}[^>]*>\s*Позвать друга/)
  assert.doesNotMatch(hero + final + kit, /бонус/i)
})

test('ленты под контролем: «Пауза» и наведение у ленты первого экрана и бегущей строки, при «уменьшить движение» — список', () => {
  assert.match(belt, /\$\{paused \|\| stopped \? 'hb-paused' : ''\}/)
  assert.match(belt, /@media \(hover: hover\) \{ \.hb-root:hover \.hb-track/)
  assert.match(belt, /\.hb-root:has\(:focus-visible\) \.hb-track/)
  assert.match(belt, /\{stopped \? 'Пуск' : 'Пауза'\}/)
  const ticker = kit.slice(kit.indexOf('export function Ticker'), kit.indexOf('export function ShiftBottle'))
  assert.match(ticker, /group-hover:\[animation-play-state:paused\]/)
  assert.match(ticker, /group-has-\[:focus-visible\]:\[animation-play-state:paused\]/)
  assert.match(ticker, /motion-reduce:flex-wrap/)
  assert.match(ticker, /\$\{copy \? 'motion-reduce:hidden' : ''\}/)
  assert.match(ticker, /\{stopped \? 'Пуск' : 'Пауза'\}/)
})

test('шов-ленты стоят между одноцветными соседями; рёбра двигает только прокрутка через --seam-x', () => {
  const order = [...home.matchAll(/<(\w+) \/>/g)].map((m) => m[1])
  const seams = order.flatMap((name, i) => (name === 'BeltSeam' ? [`${order[i - 1]} → ${order[i + 1]}`] : []))
  // Шов — только между соседними тёмными разделами: ролики и «Собери лето», «Путь кваса» и игра
  assert.deepEqual(seams, ['ShiftInside → Money', 'ProductionPath → GameSection'])
  const seam = kit.slice(kit.indexOf('export function BeltSeam'), kit.indexOf('/** Метка задания'))
  assert.match(seam, /window\.addEventListener\('scroll', move, \{ passive: true \}\)/)
  assert.match(seam, /setProperty\('--seam-x'/)
  assert.doesNotMatch(seam, /requestAnimationFrame|animation/)
  assert.match(css, /\.belt-seam-ribs \{[^}]*transform: translateX\(var\(--seam-x, 0px\)\)/)
})

test('без дат в файлах пакета', () => {
  for (const [name, src] of [
    ['Hero.tsx', hero],
    ['kit.tsx', kit],
    ['HeroBelt.tsx', belt],
    ['FinalBand.tsx', final],
    ['Home.tsx', home],
    ['motion.ts', motion],
    ['index.css', css],
    ['fonts.css', read('src/fonts.css')],
    ['fonts-subset.py', read('scripts/fonts-subset.py')],
    ['perf.mjs', read('scripts/perf.mjs')],
  ])
    // Диапазоны Unicode (U+2000-206F), номера критериев WCAG (1.4.12) и пространство имён SVG — не даты
    assert.doesNotMatch(src.replace(/U\+[0-9A-F?-]+/gi, '').replace(/WCAG \d+\.\d+\.\d+/g, '').replace(/w3\.org\/2000\/svg/g, ''), /\b(19[5-9]\d|20\d\d)\b|\d{1,2}\.\d{1,2}\.\d{2,4}/, `${name}: похоже на год или дату`)
})
