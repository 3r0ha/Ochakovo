// Скриншот страницы dev-сервера: node scripts/shot.mjs /quest out.png [mobile|desktop] [fullPage]
import { chromium } from 'playwright'

const [path = '/', out = 'shot.png', device = 'desktop', full = 'full'] = process.argv.slice(2)
const viewport = device === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 }
const base = process.env.BASE_URL ?? 'http://localhost:5180'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport, deviceScaleFactor: device === 'mobile' ? 2 : 1 })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
await page.goto(base + path, { waitUntil: 'networkidle' })
await page.waitForTimeout(1200)
if (full === 'full') {
  // прокрутка, чтобы сработали ScrollTrigger-анимации
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 400) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 80)) }
    window.scrollTo(0, 0)
  })
  await page.waitForTimeout(800)
}
await page.screenshot({ path: out, fullPage: full === 'full' })
await browser.close()
console.log(errors.length ? 'PAGE ERRORS:\n' + errors.join('\n') : 'no page errors')
