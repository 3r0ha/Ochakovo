-- w2-channels: рассылка подписавшимся на «Напомнить о наборе» (018) и журнал доставки.
--
-- recruit_state — одна строка: набор закрыт или открыт и срок окончания приёма. Срок нужен для сообщения
-- «До конца приёма неделя»: без срока такое сообщение не отправить.
--
-- broadcasts — журнал рассылок: что, кому (сегмент) и итог по счётчикам. Кому именно ушло, здесь не хранится:
-- id людей в мессенджерах остаются только в bot_users и удаляются вместе с ней по сроку хранения.
--   recipients     — сколько подходило под сегмент, когда рассылку запустили;
--   delivered      — мессенджер принял сообщение;
--   blocked        — человек заблокировал бота (Telegram и MAX ответили 403);
--   failed         — другая ошибка мессенджера;
--   skipped_recent — уже получал рассылку меньше недели назад: чаще раза в неделю не пишем;
--   skipped_offline — бот этого мессенджера не подключён.
-- «Отписались» считается по bot_users: нажали «Не присылать» после этой рассылки (last_broadcast_id).
create table if not exists recruit_state (
  id smallint primary key default 1 check (id = 1),
  state text not null default 'closed' check (state in ('closed', 'open')),
  ends_on date,
  updated_at timestamptz not null default now(),
  updated_by text not null default ''
);
insert into recruit_state (id) values (1) on conflict (id) do nothing;

create table if not exists broadcasts (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  user_id bigint references hr_users (id) on delete set null,
  user_name text not null default '',
  kind text not null check (kind in ('open', 'deadline')),
  segment text not null check (segment in ('all', 'dept', 'tasks')),
  dept text,
  text text not null,
  status text not null default 'sending' check (status in ('sending', 'done', 'interrupted')),
  recipients int not null default 0,
  delivered int not null default 0,
  blocked int not null default 0,
  failed int not null default 0,
  skipped_recent int not null default 0,
  skipped_offline int not null default 0
);
create index if not exists broadcasts_created_idx on broadcasts (created_at desc);
-- Одна рассылка за раз: вторая не начнётся, пока первая отправляется
create unique index if not exists broadcasts_one_sending on broadcasts ((true)) where status = 'sending';

-- Последняя рассылка человека (для «отписались после рассылки») и когда он заблокировал бота.
-- Заблокировавшему не пишем, пока он сам не вернётся в бота (last_seen_at позже blocked_at)
alter table bot_users add column if not exists last_broadcast_id bigint;
alter table bot_users add column if not exists blocked_at timestamptz;
