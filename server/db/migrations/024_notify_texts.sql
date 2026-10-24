-- Тексты сообщений кандидатам без длинных тире: напоминания о собеседовании и первой смене, SMS-напоминание
-- и приглашение после звонка. Меняем только исходные фрагменты: текст, поправленный администратором, остаётся как был

update notify_templates set text = replace(text, 'в {time} — собеседование в «Очаково»', 'в {time} собеседование в «Очаково»')
  where text like '%в {time} — собеседование в «Очаково»%';
update notify_templates set text = replace(text, 'в {time} — первая смена в «Очаково»', 'в {time} первая смена в «Очаково»')
  where text like '%в {time} — первая смена в «Очаково»%';
update notify_templates set text = replace(text, 'напоминаем — завтра в {time} собеседование', 'напоминаем: завтра в {time} собеседование')
  where text like '%напоминаем — завтра в {time} собеседование%';
update notify_templates set text = replace(text, 'Вопросы — rabota@ochakovo.ru или ', 'Вопросы можно задать по почте rabota@ochakovo.ru или по телефону ')
  where text like '%Вопросы — rabota@ochakovo.ru или %';
