-- Заявки кандидатов: с сайта и из ботов
create table applications (
  id text primary key,
  created_at timestamptz not null default now(),
  channel text not null default 'web',
  name text not null,
  phone text not null default '',
  contact text not null default '',
  school text not null default '',
  course text not null default '',
  department text not null default '',
  vacancy_id text not null default '',
  format text not null default '',
  months jsonb not null default '[]',
  comment text not null default '',
  game jsonb not null default '{}',
  source text
);
create index applications_created_at_idx on applications (created_at desc);
create index applications_source_idx on applications (source);

-- Состояние диалога бота для каждого пользователя канала
create table sessions (
  channel text not null,
  user_id text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (channel, user_id)
);

-- Аудитория ботов: кто пришёл, откуда и когда был последний раз
create table bot_users (
  channel text not null,
  user_id text not null,
  first_name text,
  username text,
  source text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (channel, user_id)
);
create index bot_users_source_idx on bot_users (source);
