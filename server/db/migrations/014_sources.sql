-- w2-hr-sources: реестр меток источников и расходы по меткам.
-- Метка — то, что стоит в ссылке ?src= и в ?start= ботов: fair-misis, tour-mgupp, edu-kolledzh-1.
-- HR видит в «Воронке», карточке и списке название из реестра вместо кода. Правит реестр и расходы администратор.

-- ── Реестр меток ───────────────────────────────────────────────────────────
-- code: новые метки — латиница в нижнем регистре, цифры и дефис, до 40 знаков (проверка в shared/sources.ts);
-- встроенные метки из прежнего словаря (walk_in и др.) могут содержать «_», поэтому в базе правило шире.
-- kind — тип точки контакта: экскурсия, музей, инженерный класс, вуз или колледж, ярмарка, работные сайты, соцсети,
-- друг или амбассадор, свои каналы (сайт, боты, отдел персонала), другое. builtin — метка из словаря кода: не удаляется
create table if not exists hr_sources (
  code text primary key check (code ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  name text not null check (length(btrim(name)) between 1 and 80),
  kind text not null default 'other'
    check (kind in ('excursion', 'museum', 'eng_class', 'school', 'fair', 'job_board', 'social', 'friend', 'own', 'other')),
  note text not null default '' check (length(note) <= 300),
  builtin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text not null default ''
);
create index if not exists hr_sources_kind_idx on hr_sources (kind);

-- Начальные данные — словарь меток из shared/hr.ts (sourceNames и manualSources)
insert into hr_sources (code, name, kind, builtin) values
  ('fair-mgupp', 'Ярмарка МГУПП', 'fair', true),
  ('fair-mospolytech', 'Ярмарка Мосполитеха', 'fair', true),
  ('vk', 'ВКонтакте', 'social', true),
  ('telegram', 'Telegram', 'own', true),
  ('max', 'MAX', 'own', true),
  ('site', 'Чат на сайте', 'own', true),
  ('hr', 'Добавлено вручную', 'own', true),
  ('phone', 'Звонок в отдел персонала', 'own', true),
  ('walk_in', 'Визит на завод', 'own', true),
  ('hh', 'hh.ru', 'job_board', true),
  ('superjob', 'SuperJob', 'job_board', true),
  ('avito', 'Авито Работа', 'job_board', true),
  ('employee', 'Рекомендация сотрудника', 'friend', true),
  ('fair', 'Ярмарка вакансий', 'fair', true),
  ('other', 'Другое', 'other', true)
on conflict (code) do nothing;

-- ── Расходы по меткам ──────────────────────────────────────────────────────
-- Сумма в рублях, комментарий и необязательный срок (дни по Москве, включительно). В «Воронке» за выбранный период
-- считаются расходы, срок которых с ним пересекается, целиком, без деления по дням; расход без срока — в любом периоде.
-- demo — строка из «Демо-данных»: повторный посев заменяет её, настоящие расходы не трогает
create table if not exists source_costs (
  id bigserial primary key,
  code text not null references hr_sources (code) on delete restrict,
  amount integer not null check (amount > 0 and amount <= 100000000),
  comment text not null default '' check (length(comment) <= 200),
  period_from date,
  period_to date,
  demo boolean not null default false,
  created_at timestamptz not null default now(),
  author_id bigint references hr_users (id) on delete set null,
  author_name text not null default '',
  check (period_from is null or period_to is null or period_from <= period_to)
);
create index if not exists source_costs_code_idx on source_costs (code);
