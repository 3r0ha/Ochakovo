// Скриншоты по ходу прокрутки колесом: node scripts/scrollshots.mjs / out/prefix desktop 12 700
import { chromium } from 'playwright'

const [path = '/', prefix = 'shot', device = 'desktop', steps = '10', step = '700'] = process.argv.slice(2)
const viewport = device === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 }
const b = await chromium.launch()
const p = await b.newPage({ viewport, deviceScaleFactor: 1, hasTouch: device === 'mobile' })
const errors = []
p.on('pageerror', (e) => errors.push(e.message))
p.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
await p.goto((process.env.BASE_URL ?? 'http://localhost:5180') + path, { waitUntil: 'networkidle' })
await p.waitForTimeout(2600)
await p.mouse.move(viewport.width * 0.6, viewport.height * 0.5)
for (let i = 0; i < +steps; i++) {
  if (i) for (let k = 0; k < 5; k++) { await p.mouse.wheel(0, +step / 5); await p.waitForTimeout(40) }
  await p.waitForTimeout(1300)
  await p.screenshot({ path: `${prefix}-${String(i).padStart(2, '0')}.png` })
}
await b.close()
console.log(errors.length ? 'PAGE ERRORS:\n' + errors.join('\n') : 'no page errors')
