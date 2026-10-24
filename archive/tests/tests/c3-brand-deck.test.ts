// Презентация HR-бренда: основная (docs/brand/deck/index.html, рассказ на 5–10 минут) и приложение с подробностями
// (docs/brand/deck/appendix.html). Основная проходит по всем семи требованиям кейса, в ней идея, цель, слоган
// и ключевые образы, снимки продукта на месте и лёгкие. Тексты по правилам: без «!», многоточий, длинных тире и дат.
// Запуск: pnpm test c3-brand-deck (без базы и браузера)

import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { test } from "node:test";
import { dorm } from "../../shared/content/handbook";
import { maxEntryPay, minMonthlyPay } from "../../shared/content/vacancies";

const root = join(import.meta.dirname, "..", "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const rub = (n: number) => n.toLocaleString("ru-RU").replace(/\s/g, " ");

/** Все ссылки страницы на файлы существуют, внешних адресов нет */
function localRefs(rel: string) {
  const src = read(rel);
  assert.ok(
    !/https?:\/\//.test(src.replace(/<!--[\s\S]*?-->/g, "")),
    `${rel}: внешний адрес`,
  );
  const refs = [...src.matchAll(/(?:src|href)="([^"#$]+)"/g)].map((m) => m[1]);
  for (const ref of refs)
    assert.ok(
      existsSync(join(root, normalize(join(dirname(rel), ref)))),
      `${rel}: нет файла ${ref}`,
    );
  return src;
}

/** Видимый текст слайдов */
const visible = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/[  ]/g, " ");

/** Общие правила текста: без «!», многоточий и дат; из годов только история завода */
function textRules(text: string, where: string) {
  assert.ok(!/!|\.\.\.|…/.test(text), `${where}: «!» или многоточие`);
  const noSizes = text.replace(/\d+(?:[,.]\d+)?\s?×\s?\d+(?:[,.]\d+)?/g, "");
  assert.deepEqual(
    noSizes.match(/(?<!\d)20\d{2}(?!\d)/g) ?? [],
    [],
    `${where}: год текущего века`,
  );
  for (const y of noSizes.match(/(?<!\d)19\d{2}(?!\d)/g) ?? [])
    assert.ok(["1978", "1996", "1998"].includes(y), `${where}: год ${y}`);
}

test("основная презентация: семь требований кейса за 14 слайдов, идея, цель, слоган, образы", () => {
  const html = localRefs("docs/brand/deck/index.html");
  const slides = html.match(/<section class="slide\b/g) ?? [];
  assert.ok(
    slides.length >= 12 && slides.length <= 16,
    `слайдов ${slides.length}: рассказ на 5–10 минут`,
  );
  // Требования кейса — подписи разделов над слайдами
  for (const part of [
    "Концепция HR-бренда",
    "Цифровой инструмент",
    "Визуальные материалы",
    "Мерч",
    "Сторителлинг",
    "Видеоролик о компании",
    "Обоснование концепции",
  ])
    assert.ok(html.includes(`<div class="top"><span>${part}`), part);
  // Концепция продвижения в презентации: идея, цель, слоган, ключевые образы; проверка на фокус-группе
  for (const part of [
    ">Идея</p>",
    ">Цель</p>",
    ">Слоган</p>",
    ">Ключевые образы</p>",
    ">Посылы для молодёжи</p>",
    "фокус-группа",
  ])
    assert.ok(html.includes(part), part);
  assert.ok(html.includes("Квас делают люди"), "слоган");
  assert.ok(
    html.includes('<span class="team">группировка antihype</span>'),
    "название группировки",
  );
  // Показ и анимации — отдельным файлом: CSP сайта запрещает встроенные скрипты
  assert.match(html, /<script src="deck\.js" defer><\/script>/);
  const text = visible(html);
  textRules(text, "index.html");
  assert.equal(
    (text.match(/—/g) ?? []).length,
    0,
    "длинное тире в тексте слайдов",
  );
  assert.ok(!/(?:^|[\s«(])не\s+[^\s,]+,\s+а\s/m.test(text), "«не X, а Y»");
  // Суммы практики — официальные
  for (const s of [
    rub(minMonthlyPay),
    rub(maxEntryPay),
    rub(dorm.priceStudent),
  ])
    assert.ok(text.includes(s), s);
});

test("основная презентация: снимки продукта на месте и лёгкие", () => {
  const html = read("docs/brand/deck/index.html");
  const shots = [
    ...new Set(
      [...html.matchAll(/src="(shots\/[a-z-]+\.webp)"/g)].map((m) => m[1]),
    ),
  ];
  assert.ok(shots.length >= 8, "экраны сайта, игры, заявки, чата и HR-панели");
  for (const s of shots) {
    const file = join(root, "docs/brand/deck", s);
    assert.ok(existsSync(file), s);
    assert.ok(statSync(file).size < 170_000, `${s} тяжелее 170 КБ`);
  }
});

test("приложение: подробности по критериям оценки, аудитории и смете", () => {
  const html = localRefs("docs/brand/deck/appendix.html");
  const slides = html.match(/<section class="slide\b/g) ?? [];
  assert.ok(slides.length >= 20, `слайдов ${slides.length}`);
  for (const part of [
    "<span>Критерии оценки</span>",
    "<span>Новаторские идеи</span>",
    "<span>Второстепенные проблемы</span>",
    "<span>Прототип</span>",
    "<span>Аудитория</span>",
    "<span>Обоснование</span>",
  ])
    assert.ok(html.includes(part), part);
  assert.ok(
    html.includes('<span class="team">группировка antihype</span>'),
    "название группировки",
  );
  assert.match(html, /<script src="deck\.js" defer><\/script>/);
  // Номера слайдов идут подряд
  const nums = [
    ...html.matchAll(
      /<div class="top"><span>[^<]+<\/span><span class="n">(\d\d)<\/span>/g,
    ),
  ].map((m) => Number(m[1]));
  nums.forEach((n, i) => assert.equal(n, i + 2, `номер слайда ${n}`));
  textRules(visible(html), "appendix.html");
});
