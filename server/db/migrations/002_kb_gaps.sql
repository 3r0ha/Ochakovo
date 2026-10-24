-- Вопросы, на которые помощник не нашёл ответа в базе знаний. HR видит их в панели и дописывает базу.
-- Текст уже очищен от телефонов, почты и ников; имени и id пользователя здесь нет.
create table kb_gaps (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  channel text not null,
  topic text not null default '',
  question text not null,
  resolved boolean not null default false
);
create index kb_gaps_created_at_idx on kb_gaps (created_at desc);
