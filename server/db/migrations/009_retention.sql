-- Срок хранения персональных данных (152-ФЗ): обезличенные заявки остаются в воронке без личных полей.
-- reason: retention — истёк срок хранения, request — по запросу кандидата
alter table applications add column anonymized_at timestamptz;
alter table applications add column anonymized_reason text not null default '';
create index applications_retention_idx on applications (status_updated_at) where anonymized_at is null;
create index bot_users_seen_idx on bot_users (last_seen_at);
create index sessions_updated_idx on sessions (updated_at);

-- Журнал удаления: что, сколько, кто, почему. Персональных данных здесь нет
create table retention_log (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  kind text not null check (kind in ('auto', 'request')),
  scope text not null check (scope in ('applications', 'bot_users', 'sessions', 'kb_gaps')),
  count int not null,
  user_id bigint references hr_users (id) on delete set null,
  user_name text not null default 'автоматически',
  reason text not null default '',
  application_id text
);
create index retention_log_created_idx on retention_log (created_at desc);
