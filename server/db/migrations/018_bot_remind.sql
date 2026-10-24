-- w2-bot: подписка «Напомнить о наборе» в аудитории ботов.
-- remind_at — когда человек нажал «Напомнить» (это и есть согласие на такие сообщения), remind_source — метка источника
-- в момент подписки (start=remind-<метка>), remind_dept — направление: id из shared/content/departments.ts или 'any'.
-- remind_off_at — когда нажал «Не присылать»: подписка выключена, пока человек сам не включит её снова.
-- last_broadcast_at — когда ушло последнее напоминание; заполняет рассылка.
-- Обезличивание по сроку стирает имя и ник, но подписку не включает обратно: её меняют только кнопки бота.
alter table bot_users add column if not exists remind_at timestamptz;
alter table bot_users add column if not exists remind_source text;
alter table bot_users add column if not exists remind_dept text;
alter table bot_users add column if not exists remind_off_at timestamptz;
alter table bot_users add column if not exists last_broadcast_at timestamptz;

-- Кому слать напоминание: подписан и не отписался
create index if not exists bot_users_remind_idx on bot_users (channel, remind_dept) where remind_at is not null and remind_off_at is null;
