// Показ презентации: один слайд на экран, переходы и появление элементов, счётчики чисел, графики.
// Листать — стрелки, пробел, PageUp/PageDown, Home/End, клик по правой или левой части слайда, свайп, колесо мыши.
// F — во весь экран. Номер слайда — в адресе (#7). Адрес с ?static — все слайды лентой без движения: так печатает
// scripts/deck-pdf.mjs. Без скрипта и при печати слайды тоже идут лентой. Скрипт — отдельным файлом: CSP сайта
// запрещает встроенные скрипты

const root = document.documentElement
const slides = [...document.querySelectorAll('.slide')]
const calm = matchMedia('(prefers-reduced-motion: reduce)').matches
const still = new URLSearchParams(location.search).has('static')

// ── Сгенерированная графика: ленты бутылок, сетки «N из M» ───────────────────────────────────────────────
// Бутылка — силуэт той же бутылки, что в игре на сайте (src/game/Bottle.tsx), с этикеткой «КВАС»
const BODY = 'M15.5 10h9v6.5c0 3.6 10.5 7.4 10.5 15V89a7 7 0 0 1-7 7H12a7 7 0 0 1-7-7V31.5c0-7.6 10.5-11.4 10.5-15z'
const sprite = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
sprite.setAttribute('aria-hidden', 'true')
sprite.style.cssText = 'position:absolute;width:0;height:0'
sprite.innerHTML = `
  <defs>
    <linearGradient id="kvass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b06a26"/><stop offset="1" stop-color="#5a2f0e"/></linearGradient>
    <clipPath id="bottle-clip"><path d="${BODY}"/></clipPath>
    <symbol id="bottle" viewBox="0 0 40 100">
      <rect x="15.5" y="3" width="9" height="7" rx="1" fill="#d50032"/>
      <g clip-path="url(#bottle-clip)"><rect x="0" y="27" width="40" height="73" fill="url(#kvass)"/></g>
      <path d="${BODY}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
      <rect x="5" y="49" width="30" height="19" fill="#fff"/>
      <text x="20" y="63" text-anchor="middle" font-family="Sofia Display, Arial Narrow, sans-serif" font-weight="900" font-size="11" fill="#d50032">КВАС</text>
    </symbol>
  </defs>`
document.body.prepend(sprite)

for (const belt of document.querySelectorAll('[data-belt]')) {
  const n = Number(belt.dataset.belt) || 14
  const row = Array.from({ length: n }, () => '<svg class="b" viewBox="0 0 40 100"><use href="#bottle"/></svg>').join('')
  // Две одинаковые половины: лента едет на половину своей длины и незаметно начинается заново
  belt.innerHTML = `<div class="belt-row">${row}${row}</div>`
}

for (const el of document.querySelectorAll('[data-of]')) {
  const of = Number(el.dataset.of)
  const hot = Number(el.dataset.hot)
  el.innerHTML = Array.from({ length: of }, (_, i) => `<i${i < hot ? ' class="on"' : ''} style="--k:${i}"></i>`).join('')
}

// ── Появление элементов: метки и порядок ставит скрипт, чтобы не размечать каждый слайд руками ───────────
const RULES = [
  ['h1, h2, .display, .quote', 'mask'],
  ['.bar, .hbar .fill, .gantt .phase, .cmp .fill, .age .seg, .tl-line, .j-line, .stack > span', 'grow'],
  ['.device, .browser, .paper-shot, .print-row > img, .sheets > img, .item-box, .keys6 > figure, figure:not(.backdrop):not(.bg), .phones > *, .materials > *, .merch > *, .covers > img, .frames > *, .collage > *', 'rise'],
  ['.tag, .kicker, .lead, .points > div, .msg, .q, .why, .agenda > div, .an, .own, .mini, p, li, tr, .stat, .row, .box, .rule, .tile, .msgs > div, .journey > div, .analogs > div, .goals > div, .fraction, [data-of]', 'up'],
]
for (const slide of slides) {
  let i = 0
  const seen = new Set()
  const tagged = []
  for (const [sel, kind] of RULES)
    for (const el of slide.querySelectorAll(sel)) {
      if (seen.has(el) || el.closest('.top, .src') || el.closest('[data-a]')) continue
      seen.add(el)
      el.dataset.a = kind
      tagged.push(el)
    }
  // Порядок появления — сверху вниз, слева направо, как читают
  tagged
    .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
    .forEach((el) => el.style.setProperty('--i', String(Math.min(i++, 18))))
}

// ── Счётчики: число в .num набирается от нуля, когда слайд открылся ──────────────────────────────────────
const NUMBER = /^(\D*?)(\d[\d   ]*(?:,\d+)?)(\D*)$/
const counters = slides.map((slide) =>
  [...slide.querySelectorAll('.num')].flatMap((el) => {
    const text = el.textContent.trim()
    const m = text.match(NUMBER)
    if (!m || el.children.length) return []
    const digits = m[2].replace(/[   ]/g, '')
    const value = Number(digits.replace(',', '.'))
    if (!value) return []
    const decimals = (digits.split(',')[1] ?? '').length
    return [{ el, text, pre: m[1], post: m[3], value, decimals, grouped: /[   ]/.test(m[2]) }]
  }),
)
const format = (c, v) => {
  const fixed = v.toFixed(c.decimals).replace('.', ',')
  const [int, frac] = fixed.split(',')
  const intText = c.grouped ? int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : int
  return `${c.pre}${intText}${frac ? `,${frac}` : ''}${c.post}`
}
let frame = 0
function count(list) {
  cancelAnimationFrame(frame)
  if (calm || !list.length) return
  const start = performance.now() + 350
  const tick = (now) => {
    const t = Math.min(1, Math.max(0, (now - start) / 1300))
    const k = 1 - Math.pow(1 - t, 4)
    for (const c of list) c.el.textContent = t >= 1 ? c.text : format(c, c.value * k)
    if (t < 1) frame = requestAnimationFrame(tick)
  }
  for (const c of list) c.el.textContent = format(c, 0)
  frame = requestAnimationFrame(tick)
}

// ── Показ ────────────────────────────────────────────────────────────────────────────────────────────────
if (!still && slides.length) {
  root.classList.add('show')
  if (calm) root.classList.add('calm')

  const ui = document.createElement('div')
  ui.className = 'deck-ui'
  ui.innerHTML = `
    <span class="deck-count" aria-live="polite"></span>
    <button type="button" data-go="-1" aria-label="Предыдущий слайд">←</button>
    <button type="button" data-go="1" aria-label="Следующий слайд">→</button>
    <button type="button" data-full aria-label="Во весь экран">⤢</button>`
  // Полоса прогресса вне .deck-ui: у панели mix-blend-mode, на белых слайдах красный стал бы мятным
  const progress = document.createElement('div')
  progress.className = 'deck-progress'
  progress.innerHTML = '<i></i>'
  document.body.append(ui, progress)
  const bar = progress.querySelector('i')
  const counter = ui.querySelector('.deck-count')

  let current = -1
  let leaving = null
  let leaveTimer = 0
  const pad = (n) => String(n).padStart(2, '0')

  function go(n, push = true) {
    const next = Math.max(0, Math.min(slides.length - 1, n))
    if (next === current) return
    const back = next < current
    const prev = slides[current]
    clearTimeout(leaveTimer)
    if (leaving) leaving.classList.remove('leaving')
    if (prev) {
      prev.classList.remove('is-active')
      prev.classList.add('leaving')
      leaving = prev
      leaveTimer = setTimeout(() => prev.classList.remove('leaving'), calm ? 0 : 900)
    }
    const slide = slides[next]
    slide.classList.toggle('back', back)
    // Перезапуск анимаций появления: снять и вернуть класс через кадр
    slide.classList.remove('is-active')
    void slide.offsetWidth
    slide.classList.add('is-active')
    current = next
    count(counters[next])
    bar.style.transform = `scaleX(${(next + 1) / slides.length})`
    counter.textContent = `${pad(next + 1)} / ${pad(slides.length)}`
    if (push) history.replaceState(null, '', `#${next + 1}`)
    renderPresenter()
  }
  const step = (d) => go(current + d)

  // ── Окно докладчика: N открывает текст текущего слайда, таймер и следующий слайд ──────────────────────
  // Текст лежит в слайдах скрытыми <aside class="notes" data-sec="…">: секунды — бюджет слайда в пятиминутном выступлении.
  // Окно — отдельное, его держат на ноутбуке, пока слайды идут на проекторе; стрелки работают и в нём
  let presenter = null
  let started = 0
  let clockTimer = 0
  const secOf = (i) => Number(slides[i]?.querySelector('aside.notes')?.dataset.sec || 0)
  const titleOf = (i) => {
    const h = slides[i]?.querySelector('h1, h2, .display')
    return h ? h.textContent.replace(/\s+/g, ' ').trim() : ''
  }
  const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`
  const planUntil = (i) => slides.slice(0, i + 1).reduce((t, _, k) => t + secOf(k), 0)

  function renderPresenter() {
    if (!presenter || presenter.closed) return
    const d = presenter.document
    const note = slides[current].querySelector('aside.notes')
    d.getElementById('n').textContent = `${pad(current + 1)} / ${pad(slides.length)}`
    d.getElementById('title').textContent = titleOf(current)
    d.getElementById('text').textContent = note ? note.textContent : 'Для этого слайда текста нет'
    d.getElementById('budget').textContent = `${secOf(current)} с на слайд · к концу слайда ${mmss(planUntil(current))}`
    d.getElementById('next').textContent = current + 1 < slides.length ? `${pad(current + 2)}. ${titleOf(current + 1)}` : 'Это последний слайд'
    renderClock()
  }
  function renderClock() {
    if (!presenter || presenter.closed) return clearInterval(clockTimer)
    const elapsed = (Date.now() - started) / 1000
    const el = presenter.document.getElementById('clock')
    el.textContent = mmss(elapsed)
    // Отстаём от плана больше чем на 10 секунд — время краснеет
    el.classList.toggle('late', elapsed > planUntil(current) + 10)
  }
  function openPresenter() {
    if (presenter && !presenter.closed) return presenter.focus()
    presenter = window.open('', 'deck-presenter', 'width=600,height=780')
    if (!presenter) return
    started = Date.now()
    const d = presenter.document
    d.open()
    d.write(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Докладчик</title><style>
      body{margin:0;padding:28px 32px;background:#0c0c0c;color:#fff;font:20px/1.5 system-ui,sans-serif}
      header{display:flex;justify-content:space-between;align-items:baseline;gap:16px;color:rgba(255,255,255,.6);font-size:15px}
      #clock{font:700 44px/1 system-ui,sans-serif;color:#fff;font-variant-numeric:tabular-nums}#clock.late{color:#ff3d5e}
      h1{margin:18px 0 6px;font-size:17px;letter-spacing:.06em;text-transform:uppercase;color:#ff3d5e}
      #text{font-size:24px;line-height:1.45;margin:0 0 22px}
      #budget,small{color:rgba(255,255,255,.6);font-size:15px}
      footer{border-top:1px solid rgba(255,255,255,.2);margin-top:18px;padding-top:12px;font-size:16px;color:rgba(255,255,255,.7)}
      button{margin-top:16px;background:none;color:#fff;border:1px solid rgba(255,255,255,.4);padding:8px 14px;font:inherit;font-size:15px;cursor:pointer}
    </style></head><body>
      <header><span id="n"></span><span id="clock">0:00</span></header>
      <h1 id="title"></h1><p id="text"></p><p id="budget"></p>
      <footer>Дальше: <span id="next"></span></footer>
      <button id="reset" type="button">Сбросить таймер</button>
      <p><small>Стрелки и пробел листают слайды в обоих окнах</small></p>
    </body></html>`)
    d.close()
    d.getElementById('reset').addEventListener('click', () => {
      started = Date.now()
      renderClock()
    })
    d.addEventListener('keydown', (e) => {
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(e.key)) step(1)
      else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) step(-1)
      else return
      e.preventDefault()
    })
    clearInterval(clockTimer)
    clockTimer = setInterval(renderClock, 500)
    renderPresenter()
  }

  addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const k = e.key
    if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(k)) step(1)
    else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(k)) step(-1)
    else if (k === 'Home') go(0)
    else if (k === 'End') go(slides.length - 1)
    else if (k === 'f' || k === 'F' || k === 'а' || k === 'А') full()
    else if (k === 'n' || k === 'N' || k === 'т' || k === 'Т') openPresenter()
    else return
    e.preventDefault()
  })
  ui.addEventListener('click', (e) => {
    const b = e.target.closest('button')
    if (!b) return
    e.stopPropagation()
    if (b.dataset.full !== undefined) full()
    else step(Number(b.dataset.go))
  })
  // Клик по слайду: правые две трети — вперёд, левая треть — назад. Ссылки работают как ссылки
  document.addEventListener('click', (e) => {
    if (e.target.closest('a, button, .deck-ui')) return
    step(e.clientX > innerWidth / 3 ? 1 : -1)
  })
  let touchX = 0
  addEventListener('touchstart', (e) => (touchX = e.touches[0].clientX), { passive: true })
  addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - touchX
    if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1)
  })
  let wheelLock = 0
  addEventListener(
    'wheel',
    (e) => {
      if (Math.abs(e.deltaY) < 24 || performance.now() < wheelLock) return
      wheelLock = performance.now() + 900
      step(e.deltaY > 0 ? 1 : -1)
    },
    { passive: true },
  )
  addEventListener('hashchange', () => go((parseInt(location.hash.slice(1), 10) || 1) - 1, false))

  function full() {
    if (document.fullscreenElement) document.exitFullscreen?.()
    else root.requestFullscreen?.()
  }

  go((parseInt(location.hash.slice(1), 10) || 1) - 1, false)
}
