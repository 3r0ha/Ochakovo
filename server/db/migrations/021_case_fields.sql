-- Поля анкеты по полному кейсу «Очаково» (docs/case-delta.md, пакет c2-fields): дата рождения, когда может выйти,
-- учёба, наставник и документы по практике. Имена в TypeScript — в Application и HrApplication (shared/applications.ts).
-- Все колонки с пустыми значениями по умолчанию: старые заявки остаются как были, их adult без даты не меняется.

-- ── Дата рождения ─────────────────────────────────────────────────────────
-- Возраст и 18+ считаются от неё по Москве (shared/birthDate.ts). Опечатки и возраст отсекает проверка заявки
alter table applications add column birth_date date;

-- ── Когда может выйти на работу ───────────────────────────────────────────
-- now — сразу, two_weeks — через 1–2 недели, after_session — после сессии, month — с месяца start_month
alter table applications add column start_ready text not null default ''
  constraint applications_start_ready_check check (start_ready in ('', 'now', 'two_weeks', 'after_session', 'month'));
alter table applications add column start_month smallint
  constraint applications_start_month_check check (start_month between 1 and 12);
alter table applications add constraint applications_start_month_ready_check check (start_month is null or start_ready = 'month');

-- ── Учёба ─────────────────────────────────────────────────────────────────
-- Вуз или колледж — в school, как раньше. «Уже не учусь» — отдельной отметкой
alter table applications add column not_studying boolean not null default false;

-- ── Оформление практиканта ────────────────────────────────────────────────
-- Наставник из сотрудников, прошедших обучение в Учебном центре, и отметки документов по практике:
-- contract — договор с вузом или колледжем, order — приказ, diary — дневник или отчёт, reference — характеристика
alter table applications add column mentor_name text not null default '';
alter table applications add column practice_docs text[] not null default '{}'
  constraint applications_practice_docs_check check (practice_docs <@ array['contract', 'order', 'diary', 'reference']::text[]);
