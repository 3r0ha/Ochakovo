-- w2-hr-admin: пароли сотрудников, срок сессии, раздача новых заявок по очереди, правки вакансий из панели.
-- Миграция применяется и на чистую базу, и на базу, где уже есть 016–021: всё через if not exists и or replace.

-- ── Пароли сотрудников ────────────────────────────────────────────────────
-- must_change_password — пароль задал администратор (при заведении или сбросе): при входе сотрудник задаёт свой.
-- Старые сотрудники и созданные напрямую в базе (bootstrap, проверки) менять пароль не обязаны: по умолчанию false.
-- password_changed_at — когда сотрудник сам сменил пароль
alter table hr_users add column if not exists must_change_password boolean not null default false;
alter table hr_users add column if not exists password_changed_at timestamptz;

-- Сброс пароля из любого места (панель, старый маршрут, ручной update): хеш поменялся, а сотрудник сам пароль
-- не менял (password_changed_at тот же) — значит, пароль знает тот, кто его задал, и при входе его нужно сменить
create or replace function hr_users_password_reset() returns trigger language plpgsql as $$
begin
  if new.password_hash is distinct from old.password_hash and new.password_changed_at is not distinct from old.password_changed_at then
    new.must_change_password := true;
  end if;
  return new;
end $$;
drop trigger if exists hr_users_password_reset on hr_users;
create trigger hr_users_password_reset before update on hr_users
  for each row execute function hr_users_password_reset();

-- ── Сессии: не дольше 7 дней от входа ─────────────────────────────────────
-- Сессия продлевается при работе в панели, но не дальше created_at + 7 дней: украденный токен не живёт вечно
create or replace function hr_sessions_cap() returns trigger language plpgsql as $$
begin
  new.expires_at := least(new.expires_at, new.created_at + interval '7 days');
  return new;
end $$;
drop trigger if exists hr_sessions_cap on hr_sessions;
create trigger hr_sessions_cap before insert or update on hr_sessions
  for each row execute function hr_sessions_cap();
update hr_sessions set expires_at = expires_at;

-- ── Раздача новых заявок по очереди ───────────────────────────────────────
-- in_queue — сотрудник получает новые заявки по очереди. null — по роли: HR получают, администраторы — нет, пока их
-- не поставят в очередь. Выключенные сотрудники не получают никогда
alter table hr_users add column if not exists in_queue boolean;

-- Одна строка: включена ли раздача, кто получил последнюю заявку, сколько раздано с включения
create table if not exists hr_assign_queue (
  id int primary key default 1 check (id = 1),
  enabled boolean not null default false,
  last_user_id bigint references hr_users (id) on delete set null,
  assigned int not null default 0,
  updated_at timestamptz not null default now(),
  updated_by text not null default ''
);
insert into hr_assign_queue (id) values (1) on conflict do nothing;

-- Новая заявка без ответственного получает следующего по кругу активного сотрудника из очереди.
-- Кто попадает: заявки с сайта и из ботов (канал не hr). Добавленные и загруженные в панели (канал hr) — только
-- если сервер явно попросил в этой транзакции: set_config('ochakovo.assign_queue', '1', true). Явный выбор
-- сотрудника («мне», «никому», «поровну между…») очередь не трогает. Спам и дубли очередь не получает.
-- Строка очереди блокируется (for update): две одновременные заявки не попадут одному и тому же сотруднику
create or replace function applications_assign_queue() returns trigger language plpgsql as $$
declare
  q hr_assign_queue%rowtype;
  next_id bigint;
begin
  if new.assignee_id is not null or new.duplicate_of is not null or coalesce(new.suspected_spam, false) or new.status <> 'new' then
    return new;
  end if;
  if new.channel = 'hr' and coalesce(current_setting('ochakovo.assign_queue', true), '') <> '1' then
    return new;
  end if;
  if not exists (select 1 from hr_assign_queue where id = 1 and enabled) then
    return new;
  end if;
  select * into q from hr_assign_queue where id = 1 for update;
  if not found or not q.enabled then
    return new;
  end if;
  select id into next_id from hr_users
    where not disabled and coalesce(in_queue, role = 'hr') and id > coalesce(q.last_user_id, 0)
    order by id limit 1;
  if next_id is null then
    select id into next_id from hr_users where not disabled and coalesce(in_queue, role = 'hr') order by id limit 1;
  end if;
  if next_id is null then
    return new;
  end if;
  new.assignee_id := next_id;
  update hr_assign_queue set last_user_id = next_id, assigned = assigned + 1 where id = 1;
  -- Для записи в историю после вставки: эту заявку раздала очередь
  perform set_config('ochakovo.assigned_by_queue', new.id, true);
  return new;
end $$;
drop trigger if exists applications_assign_queue on applications;
create trigger applications_assign_queue before insert on applications
  for each row execute function applications_assign_queue();

-- Запись в историю заявки: «Ведёт: Анна. Раздача по очереди» — от имени системы, без отмены
create or replace function applications_assign_queue_log() returns trigger language plpgsql as $$
declare
  who text;
begin
  if new.assignee_id is null or coalesce(current_setting('ochakovo.assigned_by_queue', true), '') <> new.id then
    return null;
  end if;
  select name into who from hr_users where id = new.assignee_id;
  insert into application_history (application_id, user_id, user_name, kind, from_status, to_status, comment)
  values (new.id, null, 'Система', 'assign', new.status, new.status, 'Ведёт: ' || coalesce(who, '—') || '. Раздача по очереди');
  perform set_config('ochakovo.assigned_by_queue', '', true);
  return null;
end $$;
drop trigger if exists applications_assign_queue_log on applications;
create trigger applications_assign_queue_log after insert on applications
  for each row execute function applications_assign_queue_log();

-- ── Правки вакансий из панели ─────────────────────────────────────────────
-- Строка — полное состояние правки поверх данных компании (shared/content/vacancies.ts): открыта ли вакансия,
-- зарплата от–до и ориентир ли она, «Срочный набор», период. Нет строки — как в данных компании.
-- pay_from null — без оплаты: так только у бесплатной практики (проверяет сервер)
create table if not exists vacancy_overrides (
  vacancy_id text primary key,
  open boolean not null default true,
  pay_from int check (pay_from is null or pay_from > 0),
  pay_to int check (pay_to is null or pay_to > 0),
  pay_estimate boolean not null default false,
  hot boolean not null default false,
  period text not null default '',
  updated_at timestamptz not null default now(),
  updated_by bigint references hr_users (id) on delete set null,
  updated_by_name text not null default ''
);

-- История правок: кто, когда, что было и что стало (before/after — состояние вакансии в виде JSON)
create table if not exists vacancy_override_history (
  id bigserial primary key,
  vacancy_id text not null,
  created_at timestamptz not null default now(),
  user_id bigint references hr_users (id) on delete set null,
  user_name text not null default '',
  before jsonb not null,
  after jsonb not null
);
create index if not exists vacancy_override_history_idx on vacancy_override_history (created_at desc);
