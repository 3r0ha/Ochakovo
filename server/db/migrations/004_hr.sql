-- Сотрудники отдела персонала и их сессии. Пароль хранится только как scrypt-хеш,
-- токен сессии — только в cookie браузера, в базе лежит его sha256.
create table hr_users (
  id bigserial primary key,
  email text not null unique,
  name text not null,
  role text not null check (role in ('hr', 'admin')),
  password_hash text not null,
  disabled boolean not null default false,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

create table hr_sessions (
  id text primary key,
  user_id bigint not null references hr_users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index hr_sessions_user_idx on hr_sessions (user_id);
create index hr_sessions_expires_idx on hr_sessions (expires_at);

-- Путь заявки: статус, заметки и id пользователя в мессенджере для уведомлений
alter table applications add column status text not null default 'new'
  check (status in ('new', 'contacted', 'interview', 'hired', 'started', 'declined', 'no_answer'));
alter table applications add column status_updated_at timestamptz not null default now();
alter table applications add column notes text not null default '';
alter table applications add column channel_user_id text;
create index applications_status_idx on applications (status);

-- История статусов: кто, когда, откуда и куда, комментарий и что стало с уведомлением кандидату
create table application_history (
  id bigserial primary key,
  application_id text not null references applications (id) on delete cascade,
  created_at timestamptz not null default now(),
  user_id bigint references hr_users (id) on delete set null,
  user_name text not null default '',
  from_status text,
  to_status text not null,
  comment text not null default '',
  -- sent | skipped | failed | null (уведомление не положено)
  notify text,
  notify_detail text not null default ''
);
create index application_history_app_idx on application_history (application_id, created_at);

-- Тексты уведомлений кандидатам в ботах. Подстановки: {name}, {id}, {vacancy}
create table notify_templates (
  status text primary key,
  text text not null,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);
insert into notify_templates (status, text) values
  ('interview', '{name}, в отделе персонала «Очаково» посмотрели заявку № {id}{vacancy} и приглашают на собеседование. В ближайшие дни тебе позвонят или напишут, чтобы договориться о времени. Вопросы — rabota@ochakovo.ru или +7 495 785-39-30, доб. 1155, 2107.'),
  ('hired', '{name}, отдел персонала «Очаково» готов принять тебя{vacancy}. Дальше оформление: медкомиссия, договор и инструктаж. HR свяжется и назовёт дату.'),
  ('declined', '{name}, спасибо за заявку № {id}. Сейчас подходящего места нет. Заявка остаётся в базе: если появится смена, которая подойдёт, отдел персонала может связаться с тобой снова.');

-- Анонимные события воронки сайта: без имён и контактов, только случайный id браузера
create table funnel_events (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  visitor text not null,
  channel text not null default 'web',
  type text not null check (type in ('visit', 'task_done', 'apply_open', 'application')),
  task text,
  source text
);
create index funnel_events_created_idx on funnel_events (created_at);
create index funnel_events_type_idx on funnel_events (type, created_at);
-- Одно и то же задание считаем один раз на посетителя
create unique index funnel_events_task_once_idx on funnel_events (visitor, task) where type = 'task_done';
