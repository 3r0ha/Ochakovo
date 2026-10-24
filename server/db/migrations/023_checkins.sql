-- «Как дела на смене»: короткий вопрос новичку после первой смены, через неделю и через месяц (shared/adaptation.ts).
-- Кейс: 38% отсеиваются на испытательном сроке. Ответ «Тяжело» ставит HR задачу поговорить, пока человек не ушёл.
-- В строке нет личных данных: только шаг, ответ из списка и причина из списка. Строки удаляются вместе с заявкой,
-- при обезличивании остаются — по ним «Воронка» считает, связаны ли ответы с уходом до конца сезона.

create table if not exists application_checkins (
  application_id text not null references applications (id) on delete cascade,
  -- shift1 — после первой смены, week1 — через неделю, month1 — через месяц
  step text not null check (step in ('shift1', 'week1', 'month1')),
  -- Когда спросили: сообщением в бот (bot) или задачей HR спросить при звонке (call)
  asked_at timestamptz,
  asked_via text not null default '' check (asked_via in ('', 'bot', 'call')),
  answer text not null default '' check (answer in ('', 'ok', 'question', 'hard')),
  -- Что тяжелее всего — только при answer = 'hard'
  reason text not null default '' check (reason in ('', 'schedule', 'work', 'team', 'commute', 'study', 'money', 'other')),
  answered_at timestamptz,
  -- Где ответили: в боте, на странице «Моя заявка», в чате на сайте или со слов кандидата при звонке (hr)
  answered_via text not null default '' check (answered_via in ('', 'telegram', 'max', 'web', 'site', 'hr')),
  primary key (application_id, step),
  check (answer = 'hard' or reason = ''),
  check ((answer = '') = (answered_at is null))
);

create index if not exists application_checkins_hard_idx on application_checkins (answered_at desc) where answer = 'hard';
