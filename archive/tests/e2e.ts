// Сквозные проверки в браузере — то, что ревьюеры проверяют руками, одной командой: pnpm test:e2e
//
// Что делает: пересобирает сайт, если исходники новее dist; создаёт одноразовую базу ochakovo_e2e_<случайное>;
// поднимает сервер на свободном порту (NODE_ENV=production, без ботов и GigaChat); прогоняет сценарии в Chromium
// (E2E_BROWSER=webkit — в движке Safari): сначала встроенные, затем сценарии-плагины scripts/e2e/*.ts по алфавиту
// (контракт — E2eHarness в scripts/e2e/_harness.ts); всё останавливает и удаляет базу.
// Стенд ревью (порт 8790, база ochakovo_review) не трогается.
//
// Настройки: E2E_PG_URL — адрес служебной базы PostgreSQL для create/drop database (по умолчанию postgres://localhost:5432/postgres),
// E2E_HEADED=1 — показать браузер, E2E_ONLY=hr-desk,pages-chat — только эти плагины (builtin — встроенные сценарии),
// E2E_PORT — порт сервера прогона (по умолчанию свободный; 8790 стенда ревью не берётся никогда),
// E2E_DIST — своя папка сборки вместо dist (собирается, если исходники новее).
// Снимки упавших шагов — во временной папке, путь печатается в конце.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import postgres from 'postgres'
import { chromium, webkit, type Browser, type BrowserContextOptions, type Page } from 'playwright'
import { unzip } from '../server/export/xlsxWriter'
import { CONSENT_VERSION } from '../shared/applications'
import {
  contrastProblems,
  DESKTOP,
  doGame,
  doMoney,
  doMyth,
  doQuiz,
  expect,
  hrLogin,
  isWebkit,
  MOBILE,
  none,
  openPage,
  overflow,
  pluginScenarios,
  readThrough,
  Scenario,
  sec,
  shiftCount,
  shiftLink,
  shots,
  TAB,
  unnamedControls,
  type E2eHarness,
} from './e2e/_harness'

const root = new URL('..', import.meta.url).pathname
const started = Date.now()
const FORBIDDEN_PORT = 8790

/** Контекст браузера со страницей на сервере этого прогона */
const open = (browser: Browser, s: Scenario, options: BrowserContextOptions) => openPage(browser, base, s, options)

// ── Инфраструктура: сборка, база, сервер ────────────────────────────────

function newestMtime(path: string): number {
  if (!existsSync(path)) return 0
  const st = statSync(path)
  if (!st.isDirectory()) return st.mtimeMs
  let max = 0
  for (const name of readdirSync(path)) if (!name.startsWith('.')) max = Math.max(max, newestMtime(join(path, name)))
  return max
}

/** E2E_DIST — своя папка сборки вместо dist (несколько прогонов на одной машине не мешают друг другу) */
const distDir = process.env.E2E_DIST ? resolve(process.env.E2E_DIST) : join(root, 'dist')

function buildIfStale() {
  const sources = ['src', 'shared', 'public', 'index.html', 'vite.config.ts', 'package.json', 'pnpm-lock.yaml'].map((p) => newestMtime(join(root, p)))
  const dist = newestMtime(join(distDir, 'index.html'))
  if (dist && dist >= Math.max(...sources)) return console.log(`Сборка: ${distDir} свежая, используем её`)
  console.log(`Сборка: исходники новее ${distDir} — собираем`)
  const run = spawnSync('pnpm', ['exec', 'vite', 'build', '--outDir', distDir, '--emptyOutDir'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] })
  if (run.status !== 0) throw new Error('vite build упал')
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const srv = createServer()
    srv.once('error', fail)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number }
      srv.close(() => (port === FORBIDDEN_PORT ? freePort().then(done, fail) : done(port)))
    })
  })
}

const adminUrl = process.env.E2E_PG_URL || 'postgres://localhost:5432/postgres'
const dbName = `ochakovo_e2e_${randomBytes(4).toString('hex')}`
const dbUrl = (() => {
  const u = new URL(adminUrl)
  u.pathname = `/${dbName}`
  return u.toString()
})()
const admin = { email: 'e2e-admin@ochakovo.test', password: `e2e-${randomBytes(9).toString('base64url')}` }
let base = ''
let server: ChildProcess | null = null
const serverLog: string[] = []

async function startServer() {
  // E2E_PORT — свой порт прогона, когда на машине одновременно работают несколько проверок; иначе — свободный
  const port = process.env.E2E_PORT && Number(process.env.E2E_PORT) !== FORBIDDEN_PORT ? Number(process.env.E2E_PORT) : await freePort()
  base = `http://localhost:${port}`
  server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: root,
    env: {
      ...process.env,
      // Safari не принимает cookie с флагом Secure по http://localhost, а в продакшн-режиме сервер ставит его всегда.
      // На сайте с HTTPS это работает; для прогона в WebKit сервер — не в продакшн-режиме
      NODE_ENV: isWebkit ? 'test' : 'production',
      PORT: String(port),
      DIST_DIR: distDir,
      DATABASE_URL: dbUrl,
      SITE_URL: base,
      PUBLIC_URL: '',
      HR_ADMIN_EMAIL: admin.email,
      HR_ADMIN_PASSWORD: admin.password,
      HR_ADMIN_NAME: 'Проверка',
      HR_TOKEN: '',
      // Пустые значения не даёт перезаписать server/index.ts из .env: никаких настоящих ботов, GigaChat и Диска
      TELEGRAM_BOT_TOKEN: '',
      MAX_BOT_TOKEN: '',
      GIGACHAT_AUTH_KEY: '',
      YANDEX_DISK_TOKEN: '',
      YANDEX_DISK_REFRESH_TOKEN: '',
      METRIKA_ID: '',
      TRUST_PROXY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const keep = (b: Buffer) => serverLog.push(...b.toString().split('\n').filter(Boolean))
  server.stdout?.on('data', keep)
  server.stderr?.on('data', keep)
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Сервер завершился с кодом ${server.exitCode}:\n${serverLog.slice(-15).join('\n')}`)
    const ok = await fetch(`${base}/api/health/ready`).then((r) => r.ok, () => false)
    if (ok) return
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`Сервер не ответил за 30 секунд:\n${serverLog.slice(-15).join('\n')}`)
}

async function stopServer() {
  if (!server || server.exitCode !== null) return
  const done = new Promise((r) => server!.once('exit', r))
  server.kill('SIGTERM')
  await Promise.race([done, new Promise((r) => setTimeout(r, 12_000))])
  if (server.exitCode === null) server.kill('SIGKILL')
}

// ── Сценарии ────────────────────────────────────────────────────────────

/** Дата рождения ДД.ММ.ГГГГ — ровно years лет назад от текущего момента (по Москве) */
function birthDaysAgo(years: number) {
  const msk = new Date(Date.now() + 3 * 3600e3)
  msk.setUTCFullYear(msk.getUTCFullYear() - years)
  const p = (n: number) => String(n).padStart(2, '0')
  return { typed: `${p(msk.getUTCDate())}.${p(msk.getUTCMonth() + 1)}.${msk.getUTCFullYear()}`, iso: msk.toISOString().slice(0, 10) }
}

const candidate = {
  // Двойное имя из букв: уникальное, чтобы найти заявку в панели и базе (в списке HR — по имени)
  name: `Ева-${Array.from(randomBytes(4), (b, i) => (i ? 'абвгдежзиклмнопрстуф' : 'АБВГДЕЖЗИКЛМНОПРСТУФ')[b % 20]).join('')}`,
  lastName: 'Проверкина',
  birth: birthDaysAgo(20),
  school: 'МГУПП',
  phone: '+7 916 555-01-23',
  vacancyId: '',
  vacancyTitle: '',
  /** Номер заявки из базы — по нему ищем строку в выгрузках */
  id: '',
  /** Что браузер кандидата запомнил после отправки (с ключом статуса) — чтобы вернуться на «Мою заявку» */
  saved: '',
}

async function homeScenario(browser: Browser) {
  const s = new Scenario('1. Главная', true)
  for (const [label, options] of [['390×844', MOBILE], ['1440×900', DESKTOP]] as const) {
    await s.step(`${label}: без ошибок консоли и ответов 4xx/5xx`, async () => {
      const { context, page, problems } = await open(browser, s, options)
      await page.goto('/', { waitUntil: 'networkidle' })
      await readThrough(page)
      await page.waitForLoadState('networkidle')
      none(problems, 'ошибки консоли и ответы 4xx/5xx')
      await context.close()
    })
  }
  for (const width of [360, 390, 768, 1440]) {
    await s.step(`${width} px: нет горизонтальной прокрутки и вылезающих блоков`, async () => {
      const mobile = width < 1024
      const { context, page } = await open(browser, s, { viewport: { width, height: mobile ? 800 : 900 }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 })
      await page.goto('/', { waitUntil: 'networkidle' })
      await readThrough(page)
      const r = await overflow(page)
      expect(r.innerWidth, 'ширина окна раздулась — что-то шире экрана').toBe(width)
      expect(r.scrolled, 'страница прокручивается вбок').toBe(0)
      none(r.out, 'за краем экрана')
      await context.close()
    })
  }
  await s.step('уменьшение движения: ширина заголовка не меняется', async () => {
    const { context, page } = await open(browser, s, { ...MOBILE, reducedMotion: 'reduce' })
    await page.addInitScript(() => {
      const w = window as unknown as { __h1: number[] }
      w.__h1 = []
      const tick = () => {
        const h = document.querySelector('h1')
        if (h) w.__h1.push(Math.round(h.getBoundingClientRect().width * 10) / 10)
        if (performance.now() < 4000) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForFunction(() => performance.now() > 4000)
    const widths = await page.evaluate(() => (window as unknown as { __h1: number[] }).__h1)
    expect(widths.length, 'заголовок так и не появился').toBeGreaterThan(5)
    const spread = Math.max(...widths) - Math.min(...widths)
    expect(spread, `ширина h1 менялась: ${[...new Set(widths)].slice(0, 8).join(', ')}`).toBeLessThanOrEqual(1)
    await context.close()
  })
  return s
}

/** Задания → заявка → HR-панель: одна цепочка, каждый шаг опирается на предыдущий */
async function candidateChain(browser: Browser) {
  const tasks = new Scenario('2. Задания')
  const apply = new Scenario('3. Заявка')
  const hr = new Scenario('5. HR-панель')
  const { context, page, problems } = await open(browser, tasks, MOBILE)

  await tasks.step('главная открылась, смена 0/4', async () => {
    await page.goto('/')
    await expect(shiftLink(page)).toHaveAttribute('aria-label', /^Смена 0 из 4/)
  })
  await tasks.step('«Собери лето»: май + «Подставить в заявку» → 1/4', async () => {
    await doMoney(page)
    await expect.poll(() => shiftCount(page)).toBe(1)
  })
  await tasks.step('«Подбор работы»: 4 ответа → вакансия → 2/4', async () => {
    candidate.vacancyTitle = await doQuiz(page)
    expect(candidate.vacancyTitle).not.toBe('')
    await expect.poll(() => shiftCount(page)).toBe(2)
  })
  await tasks.step('«Правда или миф»: 5 ответов → 3/4', async () => {
    await doMyth(page)
    await expect.poll(() => shiftCount(page)).toBe(3)
  })
  await tasks.step('«Поймай брак»: тренировка и смена 20 с → шапка 4/4', async () => {
    await doGame(page)
    expect(await shiftCount(page)).toBe(4)
  })
  await tasks.step('по ходу заданий нет ошибок и ответов 4xx/5xx', async () => {
    none(problems, 'ошибки консоли и ответы 4xx/5xx')
  })

  apply.pages.push(page)
  apply.problems.set(page, problems)
  if (!tasks.ok) apply.skip('задания не пройдены')
  await apply.step('вакансия из подбора и месяцы из «Собери лето» подставлены', async () => {
    await page.goto('/apply')
    const form = page.locator('form')
    await expect(form).toContainText(candidate.vacancyTitle, { ignoreCase: true })
    await form.getByRole('button', { name: /^Необязательно/ }).click()
    const select = page.locator('#apply-vacancy')
    await expect(select).not.toHaveValue('')
    candidate.vacancyId = await select.inputValue()
    expect((await select.evaluate((el: HTMLSelectElement) => el.selectedOptions[0]?.text ?? '')).toLowerCase()).toBe(candidate.vacancyTitle.toLowerCase())
    for (const [label, on] of [['Мар', false], ['Май', true], ['Июн', true], ['Июл', true], ['Авг', true], ['Сен', false]] as const)
      await expect(form.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-pressed', String(on))
  })
  await apply.step('ФИО, дата рождения, контакт, учёба, когда выйти, свёрнутые вопросы и согласие → отправка', async () => {
    // Поля кейса: фамилия, имя, дата рождения (с 18 лет), контакт, вуз или колледж, готовность выйти
    await page.getByRole('textbox', { name: 'Фамилия', exact: true }).fill(candidate.lastName)
    await page.getByRole('textbox', { name: 'Имя', exact: true }).fill(candidate.name)
    // Дату набираем цифрами, как на телефоне: точки ставит маска
    const birth = page.getByRole('textbox', { name: 'Дата рождения', exact: true })
    await birth.pressSequentially(candidate.birth.typed.replace(/\D/g, ''))
    await expect(birth).toHaveValue(candidate.birth.typed)
    await page.getByRole('textbox', { name: /^Телефон или Telegram/ }).fill(candidate.phone)
    await page.getByRole('textbox', { name: /^Вуз или колледж/ }).fill(candidate.school)
    const start = page.getByRole('group', { name: /^Когда сможешь выйти/ }).getByRole('radio', { name: 'Сразу' })
    await start.locator('xpath=ancestor::label[1]').click()
    await expect(start).toBeChecked()
    // Необязательные вопросы — один свёрнутый блок «Необязательно»; его уже открыли на прошлом шаге
    const more = page.getByRole('button', { name: /^Необязательно/ })
    if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click()
    await expect(more).toHaveAttribute('aria-expanded', 'true')
    // Обязательная отметка — согласие на обработку данных (consent, версия текста); возраст — по дате рождения
    const marks = page.locator('form').getByRole('checkbox', { name: /согласие на обработку/i })
    expect(await marks.count(), 'нет отметки согласия').toBeGreaterThan(0)
    for (const agree of await marks.all()) {
      if (await agree.isChecked()) continue
      // Как человек: нажатием на подпись — само поле визуально скрыто, рядом нарисованный квадрат.
      // Подпись — ближайший label вокруг отметки: filter({ has }) искал бы внутри label ещё и form из локатора отметки
      await agree.locator('xpath=ancestor::label[1]').click({ position: { x: 12, y: 12 } })
      await expect(agree).toBeChecked()
    }
    await page.getByRole('button', { name: 'Отправить заявку' }).click()
    await expect(page.getByRole('heading', { level: 1, name: /Заявка\s*отправлена/ })).toBeVisible()
    await expect(page.locator('header').getByRole('link', { name: /^Моя заявка, номер/ })).toHaveCount(1)
    candidate.saved = (await page.evaluate(() => localStorage.getItem('ochakovo.application'))) ?? ''
    expect(candidate.saved, 'браузер не запомнил ключ статуса заявки').toMatch(/"token":"[\w-]{20,}"/)
  })
  await apply.step('заявка в базе: вакансия, месяцы, прогресс заданий и поля кейса', async () => {
    const sql = postgres(dbUrl, { max: 1, onnotice: () => {} })
    try {
      const rows = await sql<
        {
          id: string
          vacancy_id: string
          months: number[]
          game: { activities?: number; quizResult: string | null; conveyorBest: number }
          channel: string
          status: string
          phone: string
          consent_at: Date | null
          consent_version: string
          consent_source: string
          suspected_spam: boolean
          last_name: string
          birth_date: string
          school: string
          start_ready: string
        }[]
      >`select id, vacancy_id, months, game, channel, status, phone, consent_at, consent_version, consent_source, suspected_spam,
               last_name, to_char(birth_date, 'YYYY-MM-DD') as birth_date, school, start_ready
        from applications where name = ${candidate.name}`
      expect(rows.length, 'заявки нет в базе').toBe(1)
      const [row] = rows
      candidate.id = row.id
      expect(row.vacancy_id).toBe(candidate.vacancyId)
      expect([...row.months].sort((a, b) => a - b)).toEqual([5, 6, 7, 8])
      expect(row.game.activities, 'смена в заявке').toBe(4)
      expect(row.game.quizResult, 'итог подбора в заявке').toBeTruthy()
      expect(typeof row.game.conveyorBest).toBe('number')
      expect(row.channel).toBe('web')
      expect(row.status).toBe('new')
      expect(row.phone, 'телефон в международном виде').toBe(`+${candidate.phone.replace(/\D/g, '')}`)
      expect(row.consent_at, 'время согласия').toBeTruthy()
      expect(row.consent_version, 'версия текста согласия').toBe(CONSENT_VERSION)
      expect(row.consent_source, 'источник согласия').toBe('site_form')
      expect(row.suspected_spam, 'человек не попадает в ловушку формы').toBe(false)
      expect(row.last_name, 'фамилия').toBe(candidate.lastName)
      expect(row.birth_date, 'дата рождения из маски ДД.ММ.ГГГГ').toBe(candidate.birth.iso)
      expect(row.school, 'вуз или колледж').toBe(candidate.school)
      expect(row.start_ready, 'когда может выйти').toBe('now')
    } finally {
      await sql.end({ timeout: 5 })
    }
  })
  await apply.step('без ошибок и ответов 4xx/5xx', async () => {
    none(problems, 'ошибки консоли и ответы 4xx/5xx')
  })
  await context.close()

  if (!apply.ok) hr.skip('заявка не отправилась')
  else await hrScenario(browser, hr)
  return [tasks, apply, hr]
}

/** Вход администратора этого прогона: первый — формой, следующие — той же сессией (лимит входов с одного адреса) */
const loginHr = hrLogin(admin)

async function hrScenario(browser: Browser, s: Scenario) {
  const { context, page, problems } = await open(browser, s, { ...DESKTOP, acceptDownloads: true })
  const status = () => page.getByRole('combobox', { name: `Статус: ${candidate.name}` })
  await s.step('вход администратора', () => loginHr(page))
  await s.step('новая заявка в списке со статусом «Новая»', async () => {
    // В панели две раскладки (карточки для узкого экрана и таблица) — берём видимую
    await expect(page.getByText(candidate.name).filter({ visible: true })).toHaveCount(1)
    await expect(status()).toHaveValue('new')
  })
  await s.step('статус прямо в списке: «Связались», потом «Отменить»', async () => {
    await status().selectOption('contacted')
    await expect(status()).toHaveValue('contacted')
    await page.getByRole('button', { name: 'Отменить' }).click()
    await expect(status()).toHaveValue('new')
    const sql = postgres(dbUrl, { max: 1, onnotice: () => {} })
    try {
      await expect.poll(async () => (await sql`select status from applications where name = ${candidate.name}`)[0]?.status).toBe('new')
    } finally {
      await sql.end({ timeout: 5 })
    }
  })
  await s.step('выгрузка Excel: файл открывается, строка кандидата на месте', async () => {
    await page.getByRole('button', { name: 'Выгрузить' }).click()
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /^Excel \(\.xlsx\)/ }).click()])
    const file = readFileSync((await download.path())!)
    const parts = unzip(file)
    const sheets = [...parts.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    expect(sheets.length, 'в книге нет листов').toBeGreaterThan(0)
    const text = [...parts.entries()].filter(([k]) => k.startsWith('xl/')).map(([, v]) => v.toString('utf8')).join('')
    expect(text.includes(candidate.name), 'имени кандидата нет в книге').toBe(true)
    expect(download.suggestedFilename()).toMatch(/\.xlsx$/)
  })
  await s.step('CSV для 1С: Windows-1251, строка кандидата на месте', async () => {
    await page.getByRole('button', { name: 'Выгрузить' }).click()
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /^CSV для 1С/ }).click()])
    const csv = new TextDecoder('windows-1251').decode(readFileSync((await download.path())!))
    const [head, ...lines] = csv.trim().split(/\r\n/).map((l) => l.split(';'))
    const col = (label: string) => head.indexOf(label)
    expect(col('Номер заявки'), `нет колонки «Номер заявки»: ${head.join(';')}`).toBeGreaterThanOrEqual(0)
    const row = lines.find((l) => l[col('Номер заявки')] === candidate.id)
    expect(row, `строки заявки ${candidate.id} нет в CSV (или кодировка не та)`).toBeTruthy()
    // Как имя разложено по колонкам ФИО — решает выгрузка; проверяем, что ни одно слово не потерялось
    const fio = ['Фамилия', 'Имя', 'Отчество'].map((l) => row![col(l)] ?? '').join(' ')
    for (const word of [candidate.lastName, candidate.name]) expect(fio, `в ФИО нет «${word}»`).toContain(word)
    expect(row![col('Телефон')].replace(/\D/g, '')).toContain('9165550123')
    expect(download.suggestedFilename()).toMatch(/1С.*\.csv$/)
  })
  await s.step('собеседование назначено — кандидат видит его на «Моей заявке»', async () => {
    // Ближайший рабочий день, 11:00 по Москве: с понедельника по пятницу, без праздников в ближайшие дни
    const day = new Date(Date.now() + 3 * 3600e3)
    do day.setUTCDate(day.getUTCDate() + 1)
    while ([0, 6].includes(day.getUTCDay()))
    const startsAt = new Date(`${day.toISOString().slice(0, 10)}T11:00:00+03:00`).toISOString()
    const code = await page.evaluate(
      async ([id, startsAt]) =>
        (
          await fetch(`/api/hr/applications/${id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json', 'x-hr-request': '1' },
            body: JSON.stringify({ status: 'interview', slot: { startsAt, address: 'Москва, ул. Рябиновая, 44', bring: 'паспорт' }, allowOffHours: true }),
          })
        ).status,
      [candidate.id, startsAt] as const,
    )
    expect(code, 'HR не смог назначить собеседование').toBe(200)

    const visit = await open(browser, s, MOBILE)
    await visit.context.addInitScript((saved) => localStorage.setItem('ochakovo.application', saved), candidate.saved)
    await visit.page.goto('/apply')
    await expect(visit.page.getByRole('heading', { level: 1, name: /Моя\s*заявка/ })).toBeVisible()
    await expect(visit.page.getByText('Собеседование назначено')).toBeVisible()
    await expect(visit.page.getByText('Москва, ул. Рябиновая, 44', { exact: false }).first()).toBeVisible()
    await expect(visit.page.getByRole('button', { name: 'Добавить в календарь' })).toBeVisible()
    none(visit.problems, 'ошибки на «Моей заявке»')
    await visit.context.close()
  })
  await s.step('без ошибок и ответов 4xx/5xx', async () => {
    none(problems, 'ошибки консоли и ответы 4xx/5xx')
  })
  await context.close()
}

async function chatScenario(browser: Browser) {
  const s = new Scenario('4. Чат')
  const ask = async (page: Page, text: string) => {
    const dialog = page.getByRole('dialog', { name: /Квасыч/ })
    const entries = dialog.locator('[data-entry]')
    const before = await entries.count()
    await dialog.getByRole('textbox').fill(text)
    await dialog.getByRole('button', { name: 'Отправить' }).click()
    await expect.poll(() => entries.count()).toBeGreaterThan(before + 1)
    await expect(dialog.getByRole('status', { name: 'Квасыч печатает' })).toHaveCount(0)
    const all = await entries.allInnerTexts()
    return all.slice(before + 1).join('\n')
  }
  const money = /\d[\d\s  ]*\s?₽/

  await s.step('компьютер: вкладка «Квасыч» открывает чат, ответ про деньги с суммой в ₽', async () => {
    const { page, problems } = await open(browser, s, DESKTOP)
    await page.goto('/')
    await doMoney(page)
    await expect.poll(() => shiftCount(page)).toBe(1)
    const tab = page.getByRole('button', { name: /^Спросить Квасыча — чат/ })
    // Вкладка прячется, когда под ней ссылка или кнопка, — листаем до места, где её ничто не закрывает
    for (let i = 0; i < 12 && !(await tab.isVisible().catch(() => false) && !(await tab.evaluate((el) => (el as HTMLElement).inert))); i++) {
      await page.mouse.wheel(0, 450)
      await page.waitForTimeout(500)
    }
    await expect(tab).not.toHaveAttribute('inert', /.*/)
    await tab.click()
    const answer = await ask(page, 'сколько на руки без опыта')
    expect(answer, `ответ без суммы: ${answer.slice(0, 200)}`).toMatch(money)
    const shift = await ask(page, 'сколько заданий я прошёл')
    expect(shift, `в чате другая смена: ${shift.slice(0, 200)}`).toContain(`Смена ${await shiftCount(page)}/4`)
    none(problems, 'ошибки консоли и ответы 4xx/5xx')
  })
  await s.step('телефон: полоса «Спросить Квасыча» внизу, тот же ответ и та же смена', async () => {
    const { page, problems } = await open(browser, s, MOBILE)
    await page.goto('/', { waitUntil: 'networkidle' })
    // Полоса чата внизу экрана; в блоке о наставниках на главной есть своя кнопка с тем же названием
    const bar = page.getByRole('complementary', { name: 'Чат с Квасычем' }).getByRole('button', { name: 'Спросить Квасыча', exact: true })
    // Сайт при открытии возвращает страницу наверх — прокручиваем, пока полоса не появится
    await expect
      .poll(async () => {
        await page.evaluate(() => window.scrollTo(0, window.innerHeight * 1.6))
        return bar.isVisible()
      })
      .toBe(true)
    await bar.click()
    const answer = await ask(page, 'сколько на руки без опыта')
    expect(answer, `ответ без суммы: ${answer.slice(0, 200)}`).toMatch(money)
    const shift = await ask(page, 'сколько заданий я прошёл')
    expect(shift, `в чате другая смена: ${shift.slice(0, 200)}`).toContain(`Смена ${await shiftCount(page)}/4`)
    none(problems, 'ошибки консоли и ответы 4xx/5xx')
  })
  return s
}

async function a11yScenario(browser: Browser) {
  const s = new Scenario('6. Доступность', true)
  s.lines.push('  · axe-core не установлен — свои проверки: имена элементов, контраст, клавиатура')
  await s.step('Tab с начала: первая — «К содержанию», Enter переносит фокус в содержимое', async () => {
    const { page } = await open(browser, s, DESKTOP)
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.keyboard.press(TAB)
    const skip = page.getByRole('link', { name: 'К содержанию' })
    await expect(skip).toBeFocused()
    await page.keyboard.press('Enter')
    await expect.poll(() => page.evaluate(() => document.activeElement?.closest('main') !== null)).toBe(true)
    await page.keyboard.press(TAB)
    await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('main')) && document.activeElement !== document.querySelector('main'))).toBe(true)
  })
  await s.step('Tab с начала доходит до «Откликнуться» в шапке', async () => {
    const { page } = await open(browser, s, DESKTOP)
    await page.goto('/', { waitUntil: 'networkidle' })
    const target = page.locator('header').getByRole('link', { name: 'Откликнуться', exact: true })
    let reached = false
    for (let i = 0; i < 20 && !reached; i++) {
      await page.keyboard.press(TAB)
      reached = await target.evaluate((el) => el === document.activeElement)
    }
    expect(reached, 'за 20 нажатий Tab фокус не дошёл до «Откликнуться»').toBe(true)
  })
  for (const [path, options, label] of [['/', DESKTOP, 'главная 1440'], ['/', MOBILE, 'главная 390'], ['/apply', DESKTOP, 'заявка 1440']] as const) {
    await s.step(`${label}: у кнопок, ссылок и полей есть имена`, async () => {
      const { context, page } = await open(browser, s, options)
      await page.goto(path, { waitUntil: 'networkidle' })
      // Имена берём из дерева доступности через CDP — он есть только в Chromium; разметка от движка не зависит
      if (isWebkit) return
      const bad = await unnamedControls(context, page)
      none(bad, 'без доступного имени')
    })
    await s.step(`${label}: контраст текста по WCAG AA`, async () => {
      const page = s.pages.at(-1)!
      await readThrough(page)
      const bad = await contrastProblems(page)
      none(bad.map((b) => `${b.where}: «${b.text}» ${b.ratio}:1 (нужно ${b.need}:1)`), 'низкий контраст')
    })
  }
  return s
}

// ── Сценарии-плагины scripts/e2e/*.ts ───────────────────────────────────

/** E2E_ONLY=hr-desk,pages-chat — только эти плагины; builtin — встроенные сценарии. Пусто — всё */
const only = new Set((process.env.E2E_ONLY ?? '').split(',').map((x) => x.trim()).filter(Boolean))
const wanted = (name: string) => !only.size || only.has(name)

// ── Запуск ──────────────────────────────────────────────────────────────

// Движок Safari скачивается отдельно; без него прогон в WebKit пропускаем с подсказкой, а не падаем
if (isWebkit && !existsSync(webkit.executablePath())) {
  console.log('WebKit не установлен — прогон в движке Safari пропущен. Установить один раз: npx playwright install webkit')
  process.exit(0)
}

let browser: Browser | null = null
let sqlAdmin: ReturnType<typeof postgres> | null = null
let sqlRun: ReturnType<typeof postgres> | null = null
let results: Scenario[] = []
let fatal: Error | null = null

try {
  buildIfStale()
  sqlAdmin = postgres(adminUrl, { max: 1, onnotice: () => {} })
  await sqlAdmin.unsafe(`create database "${dbName}"`)
  console.log(`База: ${dbName} (будет удалена)`)
  await startServer()
  console.log(`Сервер: ${base}`)
  browser = await (isWebkit ? webkit : chromium).launch({ headless: process.env.E2E_HEADED !== '1' })
  const b = browser
  if (wanted('builtin')) {
    const groups = await Promise.all([
      candidateChain(b),
      homeScenario(b).then((s) => [s]),
      chatScenario(b).then((s) => [s]),
      a11yScenario(b).then((s) => [s]),
    ])
    results = groups.flat().sort((a, z) => a.name.localeCompare(z.name, 'ru', { numeric: true }))
  }
  sqlRun = postgres(dbUrl, { max: 2, onnotice: () => {} })
  const harness: E2eHarness = {
    browser: b,
    baseUrl: base,
    sql: sqlRun,
    dbUrl,
    admin,
    Scenario,
    open: (s, options) => open(b, s, options),
    loginHr,
    expect,
    MOBILE,
    DESKTOP,
    TAB,
    isWebkit,
    doMoney,
    doQuiz,
    doMyth,
    doGame,
    shiftCount,
    shiftLink,
    overflow,
    unnamedControls,
    contrastProblems,
    readThrough,
    none,
  }
  results.push(...(await pluginScenarios(harness, join(root, 'scripts/e2e'), wanted)))
  if (!results.length) throw new Error(`по E2E_ONLY=${process.env.E2E_ONLY} нет ни одного сценария`)
} catch (e) {
  fatal = e as Error
} finally {
  await browser?.close().catch(() => {})
  await sqlRun?.end({ timeout: 5 }).catch(() => {})
  await stopServer()
  if (sqlAdmin) {
    await sqlAdmin.unsafe(`drop database if exists "${dbName}" with (force)`).catch((e) => console.error(`Базу ${dbName} удалить не вышло: ${e.message}`))
    await sqlAdmin.end({ timeout: 5 })
  }
}

for (const s of results) {
  console.log(`\n━━ ${s.name} ━━`)
  for (const line of s.lines) console.log(line)
}
console.log('\nИтог:')
for (const s of results) console.log(`  ${s.ok ? '✓' : '✗'} ${s.name} (${sec(s.ms)} с)`)
console.log(`\nВремя: ${sec(Date.now() - started)} с`)
if (fatal) {
  console.log(`\nНе запустилось: ${fatal.message}`)
  process.exit(1)
}
const failed = results.filter((s) => !s.ok)
if (failed.length) {
  console.log(`Упало: ${failed.map((s) => s.name).join(', ')}. Снимки: ${shots()}`)
  process.exit(1)
}
console.log('Все сценарии пройдены')
