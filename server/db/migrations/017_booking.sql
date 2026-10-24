-- w2-booking: самозапись на собеседование. HR предлагает кандидату выбрать время — кандидат на сайте или в боте
-- видит свободные часы (рабочие дни и часы отдела, не выше нормы на час) и записывается сам.
-- Без предложения HR выбора нет. Собеседование ставят существующие действия HR-панели (статус, слот, напоминание),
-- у собеседования interviews.self_booked = true.
-- День найма: особая дата с адресом, часами и местами в каждом часе. Кандидат приходит по ссылке с меткой дня
-- (/?src=<метка>, в боте start=<метка>) и после заявки сам выбирает час.

create table if not exists hiring_days (
  id bigserial primary key,
  -- день по Москве и часы начала собеседований по Москве
  day date not null,
  hours int[] not null,
  -- сколько кандидатов принимаем в каждый час
  capacity int not null check (capacity between 1 and 100),
  address text not null default '',
  -- метка источника: hiringday или hiringday-<что-то>; по ней заявка попадает на день найма
  label text not null,
  note text not null default '',
  created_by bigint references hr_users (id) on delete set null,
  created_by_name text not null default '',
  created_at timestamptz not null default now(),
  -- день отменили: новые записи не принимаются, назначенные собеседования остаются
  closed_at timestamptz
);

-- Одна метка — один открытый день найма
create unique index if not exists hiring_days_label_idx on hiring_days (label) where closed_at is null;

create table if not exists booking_offers (
  id bigserial primary key,
  application_id text not null references applications (id) on delete cascade,
  created_at timestamptz not null default now(),
  -- кто предложил: сотрудник HR; имя остаётся, даже если учётную запись удалят
  created_by bigint references hr_users (id) on delete set null,
  created_by_name text not null default '',
  -- до какого момента можно выбрать время, пока запись не сделана
  expires_at timestamptz not null,
  -- статус заявки до первой записи: отмена записи кандидатом возвращает его
  status_before text not null default '',
  -- запись сделана: когда и какое собеседование
  used_at timestamptz,
  interview_id bigint references interviews (id) on delete set null,
  -- «Ни одно время не подходит — позвоните»: когда нажали
  none_at timestamptz,
  -- предложение закрыто: HR отозвал его или предложил заново
  closed_at timestamptz,
  -- место в часе на время записи: пока собеседование создаётся, этот час не отдаётся второму кандидату
  hold_at timestamptz,
  hold_until timestamptz,
  -- предложение выбрать час на дне найма: часы и места — из дня, а не из рабочего календаря
  hiring_day_id bigint references hiring_days (id) on delete set null
);

-- У заявки одно открытое предложение
create unique index if not exists booking_offers_open_idx on booking_offers (application_id) where closed_at is null;
create index if not exists booking_offers_hold_idx on booking_offers (hold_at) where hold_until is not null;
