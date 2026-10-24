-- HR-панель, вторая волна: ответственный, недозвоны и «перезвонить», причины отказа,
-- дубли по телефону, анкета под производство, собеседования со слотом,
-- очередь задач (уведомления с отменой, напоминания), сохранённые виды, интеграции.

alter table applications add column assignee_id bigint references hr_users (id) on delete set null;
alter table applications add column no_answer_count int not null default 0;
alter table applications add column callback_at timestamptz;
alter table applications add column callback_note text not null default '';
alter table applications add column decline_reason text not null default '';
alter table applications add column duplicate_of text references applications (id) on delete set null;

-- Анкета под производство: на стороне кандидата необязательна, HR может дополнить
alter table applications add column last_name text not null default '';
alter table applications add column adult boolean;
alter table applications add column citizenship text not null default '';
alter table applications add column med_book text not null default '';
alter table applications add column shifts text not null default '';

-- Телефон для поиска дублей: только цифры, 8XXXXXXXXXX и 10 цифр приводятся к 7XXXXXXXXXX
alter table applications add column phone_norm text generated always as (
  case
    when length(regexp_replace(phone, '\D', '', 'g')) = 11 and left(regexp_replace(phone, '\D', '', 'g'), 1) = '8'
      then '7' || substr(regexp_replace(phone, '\D', '', 'g'), 2)
    when length(regexp_replace(phone, '\D', '', 'g')) = 10
      then '7' || regexp_replace(phone, '\D', '', 'g')
    else regexp_replace(phone, '\D', '', 'g')
  end
) stored;

create index applications_phone_norm_idx on applications (phone_norm) where duplicate_of is null;
create index applications_assignee_idx on applications (assignee_id);
create index applications_callback_idx on applications (callback_at) where callback_at is not null;

-- Отменённое действие остаётся в истории с пометкой
-- kind: status | comment | message | missed | assign | interview | merge | profile
alter table application_history add column kind text not null default 'status';
alter table application_history add column undone_at timestamptz;
-- Что вернуть при отмене: прежние значения полей заявки
alter table application_history add column undo_data jsonb;

-- Собеседование: последняя запись по заявке — актуальная, отменённые помечаются
create table interviews (
  id bigserial primary key,
  application_id text not null references applications (id) on delete cascade,
  starts_at timestamptz not null,
  address text not null default '',
  bring text not null default '',
  created_at timestamptz not null default now(),
  created_by bigint references hr_users (id) on delete set null,
  cancelled_at timestamptz
);
create index interviews_app_idx on interviews (application_id, created_at desc);

-- Очередь задач сервера. dedupe_key не даёт поставить одну и ту же задачу дважды
create table jobs (
  id bigserial primary key,
  kind text not null,
  run_at timestamptz not null,
  payload jsonb not null default '{}',
  dedupe_key text unique,
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed', 'cancelled', 'skipped')),
  attempts int not null default 0,
  last_error text not null default '',
  locked_at timestamptz,
  done_at timestamptz,
  created_at timestamptz not null default now()
);
create index jobs_due_idx on jobs (run_at) where status = 'pending';

-- Сохранённые виды списка: у каждого сотрудника свои
create table hr_views (
  id bigserial primary key,
  user_id bigint not null references hr_users (id) on delete cascade,
  name text not null,
  filter jsonb not null,
  created_at timestamptz not null default now()
);
create index hr_views_user_idx on hr_views (user_id);

-- Состояние интеграций: время синхронизации, ошибки, обновлённые токены, настройки
create table integration_state (
  key text primary key,
  data jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

-- Тексты уведомлений: собеседование со слотом и без, напоминание накануне
update notify_templates set status = 'interview_call' where status = 'interview';
insert into notify_templates (status, text) values
  ('interview', '{name}, приглашаем на собеседование в «Очаково» по заявке № {id}{vacancy}. Когда: {date}, {time}. Где: {address}. С собой: {bring}. Если время не подходит, позвони +7 495 785-39-30, доб. 1155, 2107 или напиши на rabota@ochakovo.ru.'),
  ('reminder', '{name}, напоминаем: завтра собеседование в «Очаково». {date}, {time}, {address}. С собой: {bring}. Если планы изменились, позвони +7 495 785-39-30, доб. 1155, 2107.')
on conflict (status) do nothing;
