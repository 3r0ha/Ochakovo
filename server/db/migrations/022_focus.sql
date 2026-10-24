-- w2-focus: онлайн-анкета фокус-группы на странице /focus?s=<метка> (docs/brand/focus-group.md, раздел 5).
-- Анкета анонимная: ни имени, ни телефона, ни даты рождения, ни IP. Вопросы и варианты — server/db/focus.ts,
-- результаты по вопросам и меткам — во вкладке «Фокус-группа» HR-панели и в выгрузке CSV.

create table if not exists focus_responses (
  id bigserial primary key,
  -- Метка из ссылки: fg-a и fg-b — очные встречи, остальные — каналы кампании. Пусто — ссылка без метки
  tag text not null default '' check (tag = '' or tag ~ '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$'),
  -- Отпечаток (sha256) случайной cookie браузера: один ответ с одного устройства. Саму cookie не храним
  voter text check (voter is null or voter ~ '^[0-9a-f]{64}$'),
  -- Версия анкеты: при новых вопросах ответы разных версий не смешиваются
  version smallint not null default 1 check (version > 0),
  -- 1. «Какой слоган понятнее?» и 2. «После какого слогана хочется узнать о практике?»
  --    teach — «Сначала научим, потом доверим», natural — «Я делаю натуральные напитки», people — «Квас делают люди»
  clear text not null check (clear in ('teach', 'natural', 'people', 'none')),
  interest text not null check (interest in ('teach', 'natural', 'people', 'none')),
  -- 3. «Что зацепило больше всего?»
  hook text not null check (hook in ('pay', 'mentor', 'no_probation', 'dorm', 'kvass', 'history', 'nothing')),
  -- 4. «Подать заявку на оплачиваемую практику в „Очаково“?»
  intent text not null check (intent in ('yes', 'maybe', 'no')),
  -- 5. «Чего не хватает, чтобы решиться?» — свободный ответ, телефоны, почта, ники и ссылки вырезаются до записи
  missing text not null default '' check (length(missing) <= 300),
  -- 6. «Где ты сейчас учишься?»
  study text not null check (study in ('college', 'uni_junior', 'uni_senior', 'graduated')),
  created_at timestamptz not null default now()
);

create unique index if not exists focus_responses_voter_key on focus_responses (voter) where voter is not null;
create index if not exists focus_responses_tag_idx on focus_responses (tag, created_at desc);
