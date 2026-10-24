// Вкладка «Источники», плакат A3 и листовка A5 в браузере, пакет w2-hr-sources: незнакомая метка из заявки получает
// название кнопкой «Дать название» и уходит из списка, QR и ссылки — SVG и PNG 1024 px, расход записывается;
// плакат печатается в PDF A3 на одной странице, листовка — A5 на двух, цифры — из shared; роль hr только смотрит.
// На телефоне вкладка и макеты не уезжают вбок. Свои строки сценарий в конце удаляет.
// Только он: E2E_ONLY=w2-hr-sources pnpm test:e2e

import { practicePrint } from '../../shared/sources'
import { hashPassword } from '../../server/auth/password'
import type { E2eHarness } from './_harness'

export default async (h: E2eHarness) => {
  const { expect, sql } = h
  const code = `fair-e2e-${Math.random().toString(36).slice(2, 7)}`
  const appId = `e2e-src-${code}`
  const hrEmail = `${code}@sources.test`
  const password = 'proverka-parol-12'
  const print = practicePrint()
  // Страница входа (HrLogin, пакет w2-hr-admin) без сессии спрашивает /api/hr/me/account и получает 401 —
  // это не ошибка вкладки «Источники»
  const ours = (problems: string[]) => problems.filter((p) => p !== '401 GET /api/hr/me/account')
  const plain = (t: string) => t.replace(/[ ‑⁠]/g, (c) => (c === '‑' ? '-' : c === '⁠' ? '' : ' '))

  // Заявка с меткой, которой нет в реестре: так метки приходят с QR, напечатанного до реестра
  await sql`
    insert into applications (id, created_at, channel, name, phone, game, source, status, status_updated_at, consent_at, consent_version, consent_source)
    values (${appId}, now(), 'web', 'Проверка Источников', '', ${sql.json({ quizResult: null, conveyorBest: 0, activities: 0 })}, ${code}, 'new', now(), now(), '1', 'site_form')`
  const cleanup = async () => {
    await sql`delete from applications where id = ${appId}`
    await sql`delete from source_costs where code = ${code}`
    await sql`delete from hr_sources where code = ${code}`
    await sql`delete from hr_users where email = ${hrEmail}`
  }

  const desk = new h.Scenario('w2-hr-sources: реестр меток, QR, расход, 1440 px')
  {
    const { context, page, problems } = await h.open(desk, h.DESKTOP)
    await desk.step('вкладка «Источники»: сводка по типам точек и метка без названия', async () => {
      await h.loginHr(page)
      await page.getByRole('button', { name: 'Источники', exact: true }).filter({ visible: true }).click()
      await expect(page).toHaveURL(/tab=sources/)
      await expect(page.getByRole('heading', { name: 'Источники', level: 1 })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Точки контакта' })).toBeVisible()
      await expect(page.getByRole('rowheader', { name: 'Ярмарка вакансий' })).toBeVisible()
      await expect(page.getByRole('button', { name: `Дать название метке ${code}` })).toBeVisible()
    })
    await desk.step('«Дать название»: «Ярмарка МИСИС» — метка уходит из незнакомых, название в реестре', async () => {
      await page.getByRole('button', { name: `Дать название метке ${code}` }).click()
      const dialog = page.getByRole('dialog', { name: 'Дать название' })
      await expect(dialog.getByLabel('Тип точки')).toHaveValue('fair')
      await dialog.getByLabel('Название').fill('Ярмарка МИСИС')
      await dialog.getByRole('button', { name: 'Сохранить название' }).click()
      await expect(dialog).toHaveCount(0)
      await expect(page.getByRole('button', { name: `Дать название метке ${code}` })).toHaveCount(0)
      const [row] = await sql<{ name: string; kind: string }[]>`select name, kind from hr_sources where code = ${code}`
      expect(row).toEqual({ name: 'Ярмарка МИСИС', kind: 'fair' })
      await page.getByRole('searchbox', { name: 'Найти метку' }).fill(code)
      await expect(page.getByText('Ярмарка МИСИС', { exact: true })).toBeVisible()
    })
    await desk.step('QR и ссылки: адрес с меткой, SVG для печати и PNG 1024 px', async () => {
      await page.getByRole('button', { name: 'QR и ссылки' }).first().click()
      const dialog = page.getByRole('dialog', { name: 'Ярмарка МИСИС' })
      await expect(dialog.getByRole('img', { name: new RegExp(`QR: .*\\?src=${code}$`) })).toBeVisible()
      await expect(dialog.getByRole('link', { name: new RegExp(`\\?src=${code}$`) })).toBeVisible()
      const [svg] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'SVG для печати' }).click()])
      expect(svg.suggestedFilename()).toBe(`qr-${code}.svg`)
      const svgText = await (await svg.createReadStream()).toArray().then((c) => Buffer.concat(c).toString('utf8'))
      expect(svgText).toMatch(/^<svg [^>]*width="30mm" height="30mm" shape-rendering="crispEdges">/)
      const [png] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'PNG 1024 px' }).click()])
      const bytes = await (await png.createReadStream()).toArray().then((c) => Buffer.concat(c))
      expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG')
      expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([1024, 1024])
      await expect(dialog.getByRole('link', { name: 'Плакат A3' })).toHaveAttribute('href', `/hr/poster?src=${code}`)
      await expect(dialog.getByRole('link', { name: 'Листовка A5' })).toHaveAttribute('href', `/hr/poster?src=${code}&format=a5`)
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
    })
    await desk.step('доступность вкладки: у кнопок есть имена, контраст текста по AA', async () => {
      if (!h.isWebkit) h.none(await h.unnamedControls(context, page), 'элементы без имени')
      const low = (await h.contrastProblems(page)).filter((p) => p.where !== 'header')
      h.none(low.map((p) => `${p.where}: «${p.text}» ${p.ratio} < ${p.need}`), 'низкий контраст')
    })
    await desk.step('расход по метке записывается и виден в списке', async () => {
      const form = page.locator('form').filter({ has: page.getByRole('heading', { name: 'Новый расход' }) })
      await form.getByLabel('Метка').selectOption(code)
      await form.getByLabel('Сумма, ₽').fill('25 000')
      await form.getByLabel('Комментарий').fill('Стенд и печать листовок')
      await form.getByRole('button', { name: 'Записать расход' }).click()
      await expect(page.getByText('Расход записан')).toBeVisible()
      const [cost] = await sql<{ amount: number }[]>`select amount from source_costs where code = ${code}`
      expect(cost.amount).toBe(25000)
    })
    await desk.step('плакат A3: цифры из shared, QR с меткой, печать — одна страница A3', async () => {
      await page.goto(`/hr/poster?src=${code}`)
      const sheet = page.getByRole('region', { name: 'Плакат A3' })
      await expect(sheet.getByText(/Квас делают\s*люди/)).toBeVisible()
      expect(plain(await sheet.innerText())).toContain(`ОТ ${plain(String(print.min.toLocaleString('ru-RU')))}`)
      await expect(sheet.getByRole('img', { name: new RegExp(`QR: .*\\?src=${code}$`) })).toBeVisible()
      await expect(page.getByRole('status')).toHaveCount(0)
      if (!h.isWebkit) {
        const pdf = (await page.pdf({ preferCSSPageSize: true, printBackground: true })).toString('latin1')
        expect(pdf.match(/\/Type\s*\/Page(?!s)/g)?.length, 'страниц в PDF').toBe(1)
        const box = /\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/.exec(pdf)
        expect(box && [Math.round((Number(box[1]) / 72) * 25.4), Math.round((Number(box[2]) / 72) * 25.4)]).toEqual([297, 420])
      }
    })
    await desk.step('листовка A5: роли и суммы из shared, печать — две страницы A5', async () => {
      await page.getByRole('button', { name: 'Листовка A5' }).click()
      await expect(page).toHaveURL(/format=a5/)
      const back = page.getByRole('region', { name: 'Листовка, оборотная сторона' })
      for (const r of print.roles) await expect(back.getByText(r.title, { exact: true })).toBeVisible()
      await expect(back.getByRole('img', { name: new RegExp(`QR: .*\\?src=${code}$`) })).toBeVisible()
      if (!h.isWebkit) {
        const pdf = (await page.pdf({ preferCSSPageSize: true, printBackground: true })).toString('latin1')
        expect(pdf.match(/\/Type\s*\/Page(?!s)/g)?.length, 'страниц в PDF').toBe(2)
      }
    })
    await desk.step('без ошибок и ответов 4xx/5xx', async () => h.none(ours(problems), 'ошибки консоли и ответы 4xx/5xx'))
    await context.close()
  }

  const readonly = new h.Scenario('w2-hr-sources: роль hr видит реестр и расходы, править не может')
  {
    const { context, page, problems } = await h.open(readonly, h.DESKTOP)
    await readonly.step('сотрудник hr: 403 на изменения, в интерфейсе нет форм правки', async () => {
      // Сотрудник с ролью hr — сразу в базе: выход администратора закрыл бы общую сессию для следующих сценариев
      await sql`insert into hr_users (email, name, role, password_hash) values (${hrEmail}, 'Проверка HR', 'hr', ${await hashPassword(password)})`
      const login = await page.request.post('/api/hr/login', { data: { email: hrEmail, password } })
      expect(login.status()).toBe(200)
      expect((await page.request.post('/api/hr/sources', { headers: { 'x-hr-request': '1' }, data: { code: `${code}-x`, name: 'X', kind: 'fair' } })).status()).toBe(403)
      expect((await page.request.post(`/api/hr/sources/${code}/costs`, { headers: { 'x-hr-request': '1' }, data: { amount: 100 } })).status()).toBe(403)
      await page.goto('/hr?tab=sources')
      await expect(page.getByRole('heading', { name: 'Источники', level: 1 })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Новая метка' })).toHaveCount(0)
      await expect(page.getByRole('heading', { name: 'Новый расход' })).toHaveCount(0)
      await expect(page.getByText('25 000 ₽').first()).toBeVisible()
    })
    await readonly.step('без ошибок и ответов 4xx/5xx', async () => h.none(ours(problems), 'ошибки консоли и ответы 4xx/5xx'))
    await context.close()
  }

  const phone = new h.Scenario('w2-hr-sources: вкладка и макеты на телефоне, 390 px')
  {
    const { context, page, problems } = await h.open(phone, h.MOBILE)
    for (const [title, path] of [
      ['«Источники»', '/hr?tab=sources'],
      ['плакат A3', `/hr/poster?src=${code}`],
      ['листовка A5', `/hr/poster?src=${code}&format=a5`],
    ] as const) {
      await phone.step(`${title}: страница не уезжает вбок`, async () => {
        // После входа даём панели догрузиться: переход посреди загрузки чанка WebKit считает ошибкой импорта
        if (path.startsWith('/hr?')) await h.loginHr(page).then(() => page.waitForLoadState('networkidle'))
        await page.goto(path)
        await page.waitForLoadState('networkidle')
        const o = await h.overflow(page)
        expect(o.scrolled, `горизонтальная прокрутка страницы: ${o.out.join(', ')}`).toBe(0)
        h.none(o.out, 'за краем экрана')
      })
    }
    await phone.step('без ошибок и ответов 4xx/5xx', async () => h.none(ours(problems), 'ошибки консоли и ответы 4xx/5xx'))
    await context.close()
  }

  await cleanup()
  return [desk, readonly, phone]
}
