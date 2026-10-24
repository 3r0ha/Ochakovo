-- Статус заявки для кандидата: ссылка «Моя заявка» с токеном. В базе — только SHA-256 токена
alter table applications add column status_token_hash text;
create unique index applications_status_token_idx on applications (status_token_hash) where status_token_hash is not null;
