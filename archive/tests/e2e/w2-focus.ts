// Фокус-группа в браузере, пакет w2-focus: анонимная анкета /focus?s=<метка> на телефоне — слоганы и факты до вопросов,
// шесть вопросов по одному, проверка, отправка, повтор с того же устройства — «Ответ уже записан»; клавиатура
// на ноутбуке; вкладка «Фокус-группа» в HR — счёт по метке без процентов (меньше 30 ответов), свободный ответ
// без телефона, выгрузка CSV. Нужны маршрут /focus (src/App.tsx), слот server/api/focus.ts и вкладка в src/pages/Hr.tsx.
// Свои строки сценарий в конце удаляет. Только он: E2E_ONLY=w2-focus pnpm test:e2e

import { readFileSync } from 'node:fs'
import type { E2eHarness } from './_harness'

export default async (h: E2eHarness) => {
  const { expect, sql } = h
  const tag = `e2e-${Math.random().toString(36).slice(2, 8)}`
  const cleanup = () => sql`delete from focus_responses where tag = ${tag}`
  const contrast = (list: { text: string; ratio: number; need: number; where: string }[]) => list.map((c) => `${c.where}: «${c.text}» ${c.ratio}:1 < ${c.need}:1`)
  /** Текст без неразрывных пробелов и склеек типографа */
  const plain = (t: string) => t.replace(/\u2060/g, '').replace(/\s+/g, ' ').trim()

  const phone = new h.Scenario('w2-focus: анкета на телефоне, 390 px')
  {
    const { context, page, problems } = await h.open(phone, h.MOBILE)
    await phone.step('до вопросов — три слогана в порядке концепции, факты практики и «Мне есть 18, начать»', async () => {
      const api = await page.request.get('/api/focus')
      expect(api.status(), 'GET /api/focus: слот server/api/focus.ts подключён в server/api/index.ts').toBe(200)
      await page.goto(`/focus?s=${tag}`)
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Помоги выбрать')
      const slogans = page.locator('section[aria-labelledby="focus-slogans"] li')
      await expect(slogans).toHaveText([/Квас делают люди/, /Я делаю натуральные напитки/, /Сначала научим, потом доверим/])
      await expect(page.getByText('Наставник', { exact: true })).toBeVisible()
      await expect(page.getByText('Без испытательного срока', { exact: true })).toBeVisible()
      // Типограф ставит неразрывные пробелы после коротких слов — в шаблонах \s
      await expect(page.getByText(/без\sимени,\sтелефона\sи\sдаты\sрождения/).first()).toBeVisible()
      const o = await h.overflow(page)
      expect(o.scrolled, `горизонтальная прокрутка: ${o.out.join(', ')}`).toBe(0)
      h.none(contrast(await h.contrastProblems(page)), 'контраст ниже AA')
    })
    await phone.step('шесть вопросов по одному: нажатие выбирает и ведёт дальше, «Назад» помнит ответ', async () => {
      // Вопрос сменяется анимацией: сначала ждём нужный, потом нажимаем
      const answer = async (question: string, option: string) => {
        await expect(page.locator(`[data-focus-question="${question}"]`)).toBeVisible()
        await page.locator(`[data-focus-option="${option}"]`).tap()
      }
      await page.getByRole('button', { name: 'Мне есть 18, начать' }).tap()
      await expect(page.locator('[data-focus-question]')).toContainText('Какой слоган понятнее?')
      await expect(page.locator('[data-focus-option]')).toHaveCount(4)
      await answer('clear', 'teach')
      await expect(page.locator('[data-focus-question="interest"]')).toContainText('После какого слогана')
      await page.getByRole('button', { name: /Назад/ }).tap()
      await expect(page.locator('[data-focus-question="clear"]')).toBeVisible()
      await expect(page.locator('[data-focus-option="teach"]')).toHaveAttribute('aria-pressed', 'true')
      await answer('clear', 'teach')
      await answer('interest', 'people')
      await answer('hook', 'mentor')
      await answer('intent', 'maybe')
      await expect(page.locator('[data-focus-question="missing"]')).toContainText('Чего не хватает')
      await page.locator('textarea').fill('Как совмещать смены с учёбой. Телефон +7 916 123-45-67')
      await expect(page.getByText(/Похоже\sна\sконтакт/)).toBeVisible()
      await page.getByRole('button', { name: 'Дальше' }).tap()
      await answer('study', 'college')
      await expect(page.getByRole('heading', { name: 'Проверь ответы' })).toBeVisible()
      const review = (await page.locator('[data-focus-review] dd').allTextContents()).map(plain)
      expect(review).toEqual([
        '«Сначала научим, потом доверим»',
        '«Квас делают люди»',
        'Наставник у каждого новичка',
        'Может быть',
        'Как совмещать смены с учёбой. Телефон +7 916 123-45-67',
        'Колледж',
      ])
    })
    await phone.step('отправка: в базе метка и ответы, телефона нет; повтор с этого телефона — «Ответ уже записан»', async () => {
      await page.getByRole('button', { name: 'Отправить' }).tap()
      await expect(page.getByRole('heading', { name: /ответ записан/i })).toBeVisible()
      await expect(page.getByRole('link', { name: 'Оплачиваемая практика' })).toHaveAttribute('href', '/vacancies#paid')
      const rows = await sql<{ clear: string; interest: string; hook: string; intent: string; study: string; missing: string }[]>`
        select clear, interest, hook, intent, study, missing from focus_responses where tag = ${tag}`
      expect(rows).toEqual([{ clear: 'teach', interest: 'people', hook: 'mentor', intent: 'maybe', study: 'college', missing: 'Как совмещать смены с учёбой. Телефон [телефон скрыт]' }])
      await page.reload()
      await expect(page.getByRole('heading', { name: /Ответ уже записан/ })).toBeVisible()
      h.none(problems, 'ошибки на странице анкеты')
    })
    await context.close()
  }

  const keys = new h.Scenario('w2-focus: анкета с клавиатуры, 1440 px')
  {
    const { context, page, problems } = await h.open(keys, h.DESKTOP)
    await keys.step('Enter на «начать», фокус на вопросе, цифры выбирают, в поле цифры — это текст', async () => {
      await page.goto(`/focus?s=${tag}`)
      await page.getByRole('button', { name: 'Мне есть 18, начать' }).focus()
      await page.keyboard.press('Enter')
      await expect(page.locator('[data-focus-question="clear"]')).toBeFocused()
      for (const [key, next] of [
        ['3', 'interest'],
        ['1', 'hook'],
        ['1', 'intent'],
        ['1', 'missing'],
      ] as const) {
        await page.keyboard.press(key)
        await expect(page.locator(`[data-focus-question="${next}"]`)).toBeFocused()
      }
      await page.locator('textarea').focus()
      await page.keyboard.type('2/2 и 12 часов')
      await expect(page.locator('textarea')).toHaveValue('2/2 и 12 часов')
      await page.getByRole('button', { name: 'Дальше' }).click()
      await expect(page.locator('[data-focus-question="study"]')).toBeFocused()
      await page.keyboard.press('4')
      await expect(page.getByRole('heading', { name: 'Проверь ответы' })).toBeFocused()
      // Правка из проверки возвращает к проверке
      await page.getByRole('button', { name: 'Изменить ответ на вопрос 1' }).click()
      await expect(page.locator('[data-focus-question="clear"]')).toBeFocused()
      await page.keyboard.press('4')
      await expect(page.getByRole('heading', { name: 'Проверь ответы' })).toBeFocused()
      await expect(page.locator('[data-focus-review] dd').first()).toHaveText('Ни один')
      await page.getByRole('button', { name: 'Отправить' }).click()
      await expect(page.getByRole('heading', { name: /ответ записан/i })).toBeFocused()
      h.none(await h.unnamedControls(context, page), 'элементы без имени')
      h.none(problems, 'ошибки на странице анкеты')
    })
    await context.close()
  }

  const desk = new h.Scenario('w2-focus: вкладка «Фокус-группа» в HR, 1440 px')
  {
    const { context, page, problems } = await h.open(desk, h.DESKTOP)
    // Страница входа (w2-hr-admin) без сессии спрашивает /api/hr/me/account и получает 401 — это не ошибка вкладки
    const ours = () => problems.filter((p) => p !== '401 GET /api/hr/me/account')
    await desk.step('счёт по метке: числа без процентов, свободный ответ без телефона, ссылка с меткой', async () => {
      await h.loginHr(page)
      await page.goto('/hr?tab=focus')
      await expect(page.getByRole('heading', { name: 'Фокус-группа', level: 1 })).toBeVisible()
      await page.getByRole('button', { name: new RegExp(`^${tag}\\s·\\s2$`) }).click()
      const clear = page.locator('[data-focus-result="clear"]')
      await expect(clear).toContainText('«Сначала научим, потом доверим»')
      await expect(clear).not.toContainText('%')
      await expect(page.locator('[data-focus-texts]')).toContainText('Телефон [телефон скрыт]')
      await expect(page.locator('[data-focus-texts]')).not.toContainText('916')
      h.none(contrast(await h.contrastProblems(page)), 'контраст ниже AA во вкладке')
      await page.getByLabel('Метка', { exact: true }).fill(tag)
      await expect(page.locator('[data-focus-url]')).toHaveText(new RegExp(`/focus\\?s=${tag}$`))
    })
    await desk.step('CSV: шапка с вопросами дословно, две строки метки', async () => {
      const download = page.waitForEvent('download')
      await page.getByRole('button', { name: new RegExp(`Скачать CSV\\s·\\s${tag}`) }).click()
      const file = await download
      const text = readFileSync(await file.path(), 'utf8')
      const lines = text.replace(/^﻿/, '').split('\r\n')
      expect(lines[0]).toContain('"1. Какой слоган понятнее?"')
      expect(lines.length).toBe(3)
      h.none(ours(), 'ошибки во вкладке')
    })
    await context.close()
  }

  await cleanup()
  return [phone, keys, desk]
}
