-- w2-platform: права кандидата, аудитория ботов без личных строк, новые события воронки, журнал выгрузок.

-- ── Журнал удаления: кто попросил ─────────────────────────────────────────
-- auto — истёк срок хранения, request — HR по запросу кандидата, candidate — сам кандидат:
-- «Отозвать согласие и удалить заявку» на сайте или «Удалить мои данные» в боте
alter table retention_log drop constraint if exists retention_log_kind_check;
alter table retention_log add constraint retention_log_kind_check check (kind in ('auto', 'request', 'candidate'));

-- ── Аудитория ботов ───────────────────────────────────────────────────────
-- Строку человека (канал и id в мессенджере, имя, ник, подписка) удаляем по запросу и по сроку хранения.
-- Чтобы «Пришли» в воронке и аудитория по каналам не менялись задним числом, на её место встаёт обезличенная
-- строка-счётчик: канал, метка источника, час прихода и день последнего визита, id — случайный, erased = true
alter table bot_users add column if not exists erased boolean not null default false;

-- ── События воронки сайта ─────────────────────────────────────────────────
-- game_start — нажали «Играть», share — поделились; вид (game, money, invite) — в колонке task.
-- Очков, телефонов и номеров заявок в событиях нет
alter table funnel_events drop constraint if exists funnel_events_type_check;
alter table funnel_events add constraint funnel_events_type_check
  check (type in ('visit', 'task_done', 'apply_open', 'application', 'game_start', 'share'));

-- ── Журнал выгрузок и чтения данных ───────────────────────────────────────
-- Кто, с какой ролью и что выгрузил: файл из панели, выгрузка на Яндекс Диск, чтение служебным токеном.
-- Номера заявок — чтобы ответить кандидату, кому и когда ушли его данные; самих данных здесь нет
create table if not exists access_log (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  user_id bigint references hr_users (id) on delete set null,
  user_name text not null default '',
  role text not null default '',
  action text not null,
  format text not null default '',
  rows int not null default 0,
  filter text not null default '',
  application_ids text[] not null default '{}'
);
create index if not exists access_log_created_idx on access_log (created_at desc);
create index if not exists access_log_apps_idx on access_log using gin (application_ids);
