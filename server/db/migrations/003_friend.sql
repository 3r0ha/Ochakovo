-- «Устройтесь вдвоём»: имя и контакт друга, с которым кандидат хочет работать в одной смене
alter table applications add column if not exists friend text not null default '';
