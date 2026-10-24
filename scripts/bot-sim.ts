// Симулятор бота в терминале — проверка сценариев без Telegram и MAX.
//   pnpm bot:sim                      интерактивно; --channel=max — как в MAX, --channel=web — как чат на сайте
//   printf '/start fair\n1\n' | pnpm bot:sim   — сценарий из stdin
// Ввод: число — нажать кнопку, >текст — нажать кнопку по подписи, /start <метка>,
// !win — правильный ответ в текущем раунде игры, !adult — дата рождения 20 лет назад (шаг заявки),
// !link — привязать к чату последнюю заявку (как ссылка «Получать ответы в Telegram» с сайта), !apps — сохранённые заявки,
// !state — источник, подписка «Напомнить о наборе» и запись аудитории этого чата,
// остальное — текст.
import { relative } from 'node:path'
import { createInterface } from 'node:readline'
import { mskToday } from '../shared/birthDate'
import { createEngine } from '../server/dialog/engine'
import { memoryStorage } from '../server/dialog/storage'
import type { Button, DialogEvent, DialogReply, DialogUser } from '../server/dialog/types'

const channelArg = process.argv.find((a) => a.startsWith('--channel='))?.split('=')[1]
const channel = channelArg === 'max' || channelArg === 'web' ? channelArg : 'telegram'
const storage = memoryStorage()
const engine = createEngine(storage, { siteUrl: process.env.SITE_URL ?? 'http://localhost:5180' })
// Чат на сайте не знает имени и ника человека
const user: DialogUser = channel === 'web' ? { channel, id: 'sim-user' } : { channel, id: 'sim-user', firstName: 'Даня', username: 'danya_sim' }
/** Заявка, которую чат на сайте запомнил бы в браузере: дальше уходит в meta, как с сайта */
let webApplication: { id: string; token: string } | undefined

const bold = (s: string) => s.replace(/\*\*(.+?)\*\*/g, '\x1b[1m$1\x1b[22m')
let buttons: Button[] = []

function render(r: DialogReply) {
  if (r.notice) console.log(`\x1b[33m[уведомление] ${r.notice}\x1b[39m`)
  if (r.application) {
    webApplication = { id: r.application.id, token: r.application.token }
    console.log(`\x1b[33m[сайт запомнил заявку № ${r.application.id}]\x1b[39m`)
  }
  buttons = []
  for (const m of r.messages) {
    console.log('\x1b[36m──────── Квасыч' + (m.replace ? ' (правит прошлое сообщение)' : '') + (m.input ? ` [поле: ${m.input}]` : '') + '\x1b[39m')
    if (m.image) console.log(`[картинка: ${relative(process.cwd(), m.image.path)}]`)
    console.log(bold(m.text))
    for (const row of m.buttons ?? []) {
      const cells = row.map((b) => {
        buttons.push(b)
        const n = buttons.length
        if (b.kind === 'link') return `[${n}] ${b.text} → ${b.url}`
        if (b.kind === 'contact') return `[${n}] ${b.text} (контакт)`
        return `[${n}] ${b.text}`
      })
      console.log('  ' + cells.join('   '))
    }
  }
}

async function send(event: DialogEvent) {
  render(await engine.handle(user, event, channel === 'web' && webApplication ? { application: webApplication } : undefined))
}

async function press(b: Button | undefined) {
  if (!b) return console.log('\x1b[31mНет такой кнопки\x1b[39m')
  if (b.kind === 'link') return console.log(`(откроется ссылка ${b.url})`)
  if (b.kind === 'contact') return send({ type: 'contact', phone: '+79991234567' })
  return send({ type: 'action', action: b.action })
}

async function handleLine(raw: string) {
  const line = raw.trim()
  if (!line || line.startsWith('#')) return
  // Число в пределах кнопок — нажатие; длинное число (телефон) — обычный текст
  if (/^\d{1,2}$/.test(line) && Number(line) >= 1 && Number(line) <= buttons.length) return press(buttons[Number(line) - 1])
  if (line.startsWith('>')) {
    const q = line.slice(1).trim().toLowerCase()
    return press(buttons.find((b) => b.text.toLowerCase().includes(q)))
  }
  if (line === '!win') {
    const game = (await storage.getSession(user)).data.game as { round: number; rounds: { at: number }[] } | undefined
    if (!game) return console.log('Игра не идёт')
    return send({ type: 'action', action: `g:${game.round}:${game.rounds[game.round].at + 1}` })
  }
  if (line === '!apps') return console.log(JSON.stringify(storage.applications, null, 2))
  if (line === '!state') {
    const s = await storage.getSession(user)
    const key = `${user.channel}:${user.id}`
    return console.log(JSON.stringify({ source: s.source, flow: s.flow, remind: storage.reminds.get(key) ?? null, audience: storage.botUsers.get(key) ?? null }, null, 2))
  }
  if (line === '!adult') {
    // Дата считается от сегодняшнего дня по Москве — в симуляторе нет записанных дат
    const [y, m, d] = mskToday().split('-')
    return send({ type: 'text', text: `${d}.${m}.${Number(y) - 20}` })
  }
  if (line === '!link') {
    const app = storage.applications[0]
    const links = app ? await storage.createBotLink(app.id, { telegram: 'kvasych_sim_bot', max: 'kvasych_sim' }) : null
    const token = /app_([A-Za-z0-9_-]+)$/.exec(links?.telegram ?? '')?.[1]
    if (!token) return console.log('Заявок нет — сначала отправь заявку или !apps')
    return send({ type: 'start', payload: `app_${token}` })
  }
  if (line.startsWith('/start')) return send({ type: 'start', payload: line.slice(6).trim() || undefined })
  return send({ type: 'text', text: line })
}

if (process.stdin.isTTY) {
  await send({ type: 'start' })
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '\x1b[32mты>\x1b[39m ' })
  rl.prompt()
  for await (const line of rl) {
    await handleLine(line)
    rl.prompt()
  }
} else {
  const rl = createInterface({ input: process.stdin })
  for await (const line of rl) {
    if (line.trim() && !line.trim().startsWith('#')) console.log(`\x1b[32mты> ${line}\x1b[39m`)
    await handleLine(line)
  }
}
