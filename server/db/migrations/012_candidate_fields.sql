-- Новые поля заявок и собеседований для обеих волн плана (docs/plan.md, «Миграция 012»).
-- Имена в TypeScript — camelCase в Application и HrApplication (shared/applications.ts).

-- ── Согласие на обработку персональных данных ─────────────────────────────
-- consent_at — когда дано (null — согласия нет), consent_version — версия текста на /consent,
-- consent_source — где дано. Кандидата, добавленного HR без основания, можно пригласить только после подтверждения
alter table applications add column consent_at timestamptz;
alter table applications add column consent_version text not null default '';
alter table applications add column consent_source text not null default 'none'
  constraint applications_consent_source_check
  check (consent_source in ('site_form', 'site_chat', 'telegram', 'max', 'hr_verbal', 'job_board', 'none'));

-- Заявки до отдельного согласия: форма и бот брали его одной отметкой вместе с «мне есть 18 лет».
-- Версия '0', источник — по каналу, время — время заявки. Добавленные HR — без согласия
update applications set
  consent_version = '0',
  consent_source = case channel when 'web' then 'site_form' when 'telegram' then 'telegram' when 'max' then 'max' else 'none' end,
  consent_at = case when channel in ('web', 'telegram', 'max') then created_at end;

-- ── Приглашение друга ─────────────────────────────────────────────────────
-- Личный код кандидата из браузера или чата. При совпадении кода заявка принимается, код не записывается
alter table applications add column ref_code text;
create unique index applications_ref_code_idx on applications (ref_code) where ref_code is not null;

-- ── Практика от вуза и планы после сезона ─────────────────────────────────
alter table applications add column practice_school boolean not null default false;
alter table applications add column wants_to_stay boolean not null default false;

-- ── Ловушка формы: заявка сохраняется с пометкой ──────────────────────────
alter table applications add column suspected_spam boolean not null default false;

-- ── Оформление и первая смена ─────────────────────────────────────────────
alter table applications add column onboarding_at timestamptz;
alter table applications add column first_shift_at timestamptz;
alter table applications add column shift_kind text not null default ''
  constraint applications_shift_kind_check check (shift_kind in ('', 'day', 'night'));
alter table applications add column onboarding_note text not null default '';

-- ── Итог сезона и кадровый резерв ─────────────────────────────────────────
alter table applications add column season_outcome text not null default ''
  constraint applications_season_outcome_check check (season_outcome in ('', 'completed', 'left'));
alter table applications add column season_leave_reason text not null default ''
  constraint applications_season_leave_reason_check
  check (season_leave_reason in ('', 'study', 'schedule', 'commute', 'money', 'personal', 'other'));
alter table applications add column reserve boolean not null default false;

-- ── Привязка заявки с сайта к боту ────────────────────────────────────────
-- channel у такой заявки остаётся web. В базе — только хеш одноразового токена ссылки
alter table applications add column bot_channel text
  constraint applications_bot_channel_check check (bot_channel in ('telegram', 'max'));
alter table applications add column bot_user_id text;
alter table applications add column bot_link_hash text;
alter table applications add column bot_link_expires_at timestamptz;
create unique index applications_bot_link_idx on applications (bot_link_hash) where bot_link_hash is not null;
create index applications_bot_user_idx on applications (bot_channel, bot_user_id) where bot_user_id is not null;

-- ── Собеседования: явка и самозапись ──────────────────────────────────────
alter table interviews add column attended text not null default ''
  constraint interviews_attended_check check (attended in ('', 'yes', 'no'));
alter table interviews add column attended_at timestamptz;
alter table interviews add column attended_by bigint references hr_users (id) on delete set null;
alter table interviews add column self_booked boolean not null default false;
