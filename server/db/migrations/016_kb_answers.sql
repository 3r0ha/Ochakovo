-- Ответы отдела персонала на «Вопросы к Квасычу». HR отвечает на вопрос, на который в данных не было ответа,
-- и Квасыч дальше отвечает этим текстом на тот же вопрос и его формулировки. Ответ можно выключить и поправить.
-- Текст уже проверен: без «!», без дат, без личных телефонов, почты и имён.
create table kb_answers (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Вопрос, на который ответили, — обычно текст из kb_gaps
  question text not null,
  -- Другие формулировки того же вопроса
  variants text[] not null default '{}',
  answer text not null,
  enabled boolean not null default true,
  -- Вопрос из «Вопросов к Квасычу», с которого начался ответ; вопрос может удалить срок хранения
  gap_id bigint references kb_gaps(id) on delete set null,
  author_id bigint references hr_users(id) on delete set null,
  author_name text not null default ''
);
create index kb_answers_enabled_idx on kb_answers (enabled);

-- Какой ответ HR закрыл вопрос: «Разобрано» с ответом отличается от «Разобрано» без него
alter table kb_gaps add column answer_id bigint references kb_answers(id) on delete set null;
