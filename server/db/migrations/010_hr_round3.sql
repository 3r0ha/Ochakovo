-- Отчество и ссылка на резюме hh.ru (импорт откликов), план найма по вакансиям и месяцам,
-- тексты уведомлений с подстановками {ref} и {request}: «по заявке № …» или «по отклику на hh.ru»
alter table applications add column middle_name text not null default '';
alter table applications add column resume_url text not null default '';
create index applications_contact_lower_idx on applications (lower(contact)) where duplicate_of is null and contact <> '';
create index applications_resume_idx on applications (resume_url) where resume_url <> '';

create table hiring_plan (
  season int not null,
  vacancy_id text not null,
  month int not null check (month between 1 and 12),
  target int not null check (target >= 0 and target <= 10000),
  updated_at timestamptz not null default now(),
  primary key (season, vacancy_id, month)
);

update notify_templates
set text = '{name}, приглашаем на собеседование в «Очаково» {ref}{vacancy}. Когда: {date}, {time}. Где: {address}. С собой: {bring}. Если время не подходит, позвони +7 495 785-39-30, доб. 1155, 2107 или напиши на rabota@ochakovo.ru.'
where status = 'interview'
  and text = '{name}, приглашаем на собеседование в «Очаково» по заявке № {id}{vacancy}. Когда: {date}, {time}. Где: {address}. С собой: {bring}. Если время не подходит, позвони +7 495 785-39-30, доб. 1155, 2107 или напиши на rabota@ochakovo.ru.';

update notify_templates
set text = '{name}, в отделе персонала «Очаково» посмотрели {request}{vacancy} и приглашают на собеседование. В ближайшие дни тебе позвонят или напишут, чтобы договориться о времени. Вопросы — rabota@ochakovo.ru или +7 495 785-39-30, доб. 1155, 2107.'
where status = 'interview_call'
  and text = '{name}, в отделе персонала «Очаково» посмотрели заявку № {id}{vacancy} и приглашают на собеседование. В ближайшие дни тебе позвонят или напишут, чтобы договориться о времени. Вопросы — rabota@ochakovo.ru или +7 495 785-39-30, доб. 1155, 2107.';

update notify_templates
set text = '{name}, спасибо за {request}. Сейчас подходящего места нет. Заявка остаётся в базе: если появится смена, которая подойдёт, отдел персонала может связаться с тобой снова.'
where status = 'declined'
  and text = '{name}, спасибо за заявку № {id}. Сейчас подходящего места нет. Заявка остаётся в базе: если появится смена, которая подойдёт, отдел персонала может связаться с тобой снова.';
