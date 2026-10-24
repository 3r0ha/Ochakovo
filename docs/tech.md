# Техническое описание

Как устроены сайт, бот и HR-панель, как их запустить и подключить. Обзор для всех в [README](../README.md), развёртывание на сервере в [deploy.md](deploy.md).

## Как запустить

Нужны Node.js 24, pnpm и PostgreSQL 16.

**Локально:**

```bash
pnpm install
cp .env.example .env        # DATABASE_URL: адрес базы
createdb ochakovo
pnpm dev:all                # сайт http://localhost:5180, API http://localhost:8787
```

**Docker.** Один образ с сайтом, API и ботами.

```bash
cp .env.example .env        # POSTGRES_PASSWORD, HR_ADMIN_EMAIL, HR_ADMIN_PASSWORD, SITE_URL=http://localhost:8787
docker compose --profile local-db up -d --build   # база и приложение на http://localhost:8787
```

С управляемой базой нужны `APP_DATABASE_URL` в `.env` и `docker compose up -d --build`. В Docker сервер работает в рабочем режиме: cookie входа в HR-панель только для HTTPS, поэтому на `http://localhost` панель открывается в Chrome, а в Safari только по HTTPS. Про HTTPS, вебхуки, переменные окружения, резервные копии и обновление написано в `docs/deploy.md`.

Медиа из материалов заказчика собирает заново одна команда `node scripts/media.mjs` (нужна папка `archive/case-materials/`, в открытый репозиторий она не входит): логотип без квадрата, пиктограммы и паттерн из брендбука, `favicon.ico` и ролики о профессиях. По частям: `node scripts/media.mjs brand`, `favicon` или `video`. Нужны ffmpeg и PyMuPDF. Фото: исходники в `photos-src/`, адаптивные версии собирает `node scripts/photos.mjs`.

## Что работает на имитациях и что нужно для запуска

Живых ключей у команды нет. Каждая интеграция проверена на имитации внешнего API и включается переменной окружения.

| Интеграция | Без ключа | Что нужно от «Очаково» |
|---|---|---|
| GigaChat (помощник Квасыч) | офлайн-режим по той же базе знаний | ключ GigaChat API на юрлицо: `GIGACHAT_AUTH_KEY`, `GIGACHAT_SCOPE` |
| Telegram | бот работает в чате на сайте и в `pnpm bot:sim` | бот на аккаунт компании: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` |
| MAX | код адаптера готов, живого бота нет | регистрация бота на юрлицо: `MAX_BOT_TOKEN`, `MAX_BOT_NICK` |
| Яндекс Диск | выгрузка «Заявки.xlsx» по кнопке в браузер | корпоративный Диск Яндекс 360: `YANDEX_DISK_TOKEN` |
| SMS | панель показывает «Позвони кандидату» и готовый текст | договор с SMS.ru или SMSC.ru: `SMS_PROVIDER`, `SMS_API_KEY` |
| hh.ru | предпросмотр вакансии и импорт откликов из файла | доступ работодателя: `HH_ACCESS_TOKEN`, `HH_REFRESH_TOKEN`, `HH_EMPLOYER_ID` |
| Яндекс Метрика и пиксель VK | счётчиков нет, плашки о cookie нет | ID счётчиков: `METRIKA_ID`, `VK_PIXEL_ID`; скрипты грузятся только после согласия в плашке |

Шрифт бренда Proxima Nova платный: на сайте свои шрифты, для печати и продакшена нужна лицензия.

## Структура

| Папка | Что внутри |
|---|---|
| `src/` | сайт на React: страницы `src/pages/`, разделы главной `src/home/`, игра `src/game/`, HR-панель `src/components/hr/` |
| `server/` | API на Hono, PostgreSQL, движок диалогов `server/dialog/`, адаптеры Telegram и MAX `server/channels/`, помощник `server/assistant/` и `server/llm/` |
| `shared/` | общее для сайта, бота и сервера: вакансии, условия, вопросы, проверка анкеты, фильтры HR |
| `public/` | фото, ролики `public/video/`, логотип и пиктограммы `public/brand/` |
| `docs/` | кейс, концепция бренда, стратегия, дорожная карта, HR-панель, помощник, развёртывание |
| `scripts/` | сборка медиа, макетов, презентации и снимков экранов |
| `archive/case-materials/` | материалы заказчика: кейс, описание практики, справочник студента, брендбук, ролики. Внутренние, лежат только локально, в репозиторий не входят |
| `archive/mascot-src/` | исходники поз Квасыча на белом фоне; `scripts/mascot-cutout.py` убирает фон и кладёт позы в `public/mascot/` |
| `docs/brand/stickers/` | стикерпак для Telegram, собирает `scripts/stickers.py` |
| `docs/readme/` | картинки для README, собирает `scripts/readme-images.mjs` |

## Сайт подробно

Тёмная основа, фирменный красный, крупный узкий шрифт, живые фото с ochakovo.ru, логотип и пиктограммы из брендбука. Порядок сверху вниз:

- Первый экран: практика и работа с 18 лет, сумма от 56 000 до 70 000 ₽ до вычета налога, кнопка «Откликнуться» и лента бутылок, на которой можно сразу ловить брак.
- Оплачиваемая практика: 4 отдела и роли с суммами, что даёт компания: наставник, работа без испытательного срока, общежитие, обед, спецодежда и медосмотр.
- «Смена изнутри»: ролики компании о профессиях. До нажатия грузится только постер, звук сам не включается.
- Четыре задания прямо на странице и счётчик «Смена N/4» в шапке (наполняются четыре бутылки). Порядок на странице:
  1. «Собери лето». Выбираешь должность и месяцы, и задание считает заработок до вычета налога и на руки, а для графика 2/2 ещё за смену и в час.
  2. «Подбор работы». 4 вопроса, найденная вакансия сама подставится в заявку.
  3. «Поймай брак». Игра на 20 секунд, та же игра есть отдельной страницей `/game`.
  4. «Правда или миф». 5 карточек о работе и истории завода, повтор даёт новую колоду. Рядом карточка контрольных вопросов.
- Между заданиями стоят «Условия», «Путь кваса» (производство от зерна до полки и кто работает на каждом этапе) и вакансии.
- «Квас делают люди»: легенда, таймлайн 1978, 1996, 1998 и сегодня, «Очаково» сегодня в цифрах и бренды; затем наставники и три шага на старте по справочнику студента.
- «Спросить Квасыча», вопросы и финальная полоса «Откликнуться».

Страницы: `/vacancies`, `/apply` (анкета, после отправки «Моя заявка» со статусом), `/game` («Поймай брак») и `/game?t=quiz` (контрольные вопросы), `/privacy` и `/consent` (политика и текст согласия), `/hr` (панель отдела персонала).

Квасыч, мастер-наставник, нарисован по образу наставников «Очаково». Он ведёт кандидата по сайту и боту. Позы лежат в `public/mascot/`, сайт находит их сам; бриф, имена файлов и стикерпак в `docs/kvasych.md`.

## HR-панель

Заявки со всех каналов в одном списке: возраст, когда может выйти и учёба прямо в строке, статус в один клик, обзвон с клавишами, собеседование со слотом или самозаписью, явка, оформление с первой сменой, наставником и документами по практике, «Как дела на смене» в первые недели, итог сезона и резерв, ответственный и раздача по очереди, «перезвонить», дубли по телефону, фильтр по заданиям и источнику, план найма и список на проходную. Во вкладке «Источники» метки, QR и печать для точек контакта, в «Ботах» состояние и предпросмотр, в «Рассылке» «Напомнить о наборе». «Воронка» показывает путь от входа на сайт до выхода на смену по каждой метке. Выгрузки идут в Excel, CSV, CSV для 1С, JSON и на Яндекс Диск по расписанию. Есть импорт откликов hh.ru, срок хранения данных и удаление по запросу кандидата. Подробно в `docs/hr.md`.

## Откуда данные

Все тексты и цифры для сайта, бота и помощника лежат в `shared/`: вакансии (`shared/content/vacancies.ts`), практика (`shared/content/practice.ts`), справочник студента (`shared/content/handbook.ts`), история и бренды (`shared/content/company.ts`), контрольные вопросы (`shared/content/companyQuiz.ts`), условия, шаги, «Правда или миф» и контакты (`shared/content/content.ts`), вопросы (`shared/content/faq.ts`), «Путь кваса» (`shared/content/production.ts`), статус заявки и срок ответа HR (`shared/candidateStatus.ts`). У каждого факта в коде указаны источник и цитата.

- Оплачиваемая практика, суммы, графики и обязанности взяты из «Описания практики» в материалах заказчика.
- Условия и быт (общежитие, столовая, зарплата 12-го и 27-го, наставник, документы по практике, корпоративный автобус, телефоны) взяты из справочника студента.
- История, «Очаково» сегодня и бренды взяты из каталога продукции, брендбука, ochakovo.ru/istoriya и ochakovo.ru/brands.
- Работа вне практики: живые вакансии «Очаково» в Москве на hh.ru, у каждой суммы ссылка.
- Ролики о профессиях взяты из материалов заказчика, кадры с алкогольной продукцией вырезаны (`public/video/manifest.json`).
- Фото с ochakovo.ru (нужно согласие компании на использование).

## Сервер и боты

Один процесс Node (`server/`) обслуживает сайт, HR-панель и ботов: API на Hono, данные в PostgreSQL, единый движок диалогов для Telegram и MAX.

**База.** Нужен PostgreSQL 16 и база `ochakovo`, адрес задаёт `DATABASE_URL` в `.env` (пример в `.env.example`).

- Homebrew: `brew install postgresql@16 && brew services start postgresql@16 && createdb ochakovo`, тогда `DATABASE_URL=postgres://localhost:5432/ochakovo`.
- Docker: пароль базы задаёт `POSTGRES_PASSWORD` в `.env` (значения по умолчанию нет), затем `docker compose --profile local-db up -d db`, тогда `DATABASE_URL=postgres://ochakovo:<пароль>@localhost:5432/ochakovo`.

Схему задают SQL-миграции в `server/db/migrations/` (файлы `NNN_*.sql` по порядку). Сервер применяет их при старте и записывает в таблицу `schema_migrations`.

| Таблица | Что хранит | Миграция |
|---|---|---|
| `applications` | заявки с сайта, из ботов и добавленные HR: анкета, дата рождения, учёба, готовность выйти, статус, согласие, приглашение, практика, наставник и документы | `server/db/migrations/001_init.sql`, поля до `server/db/migrations/021_case_fields.sql` |
| `sessions` | состояние диалога бота | `server/db/migrations/001_init.sql` |
| `bot_users` | аудитория ботов по каналам и источникам, подписка «Напомнить о наборе» | `server/db/migrations/001_init.sql`, поля в `server/db/migrations/018_bot_remind.sql` и `server/db/migrations/020_platform.sql` |
| `kb_gaps` | вопросы к Квасычу без ответа, без личных данных | `server/db/migrations/002_kb_gaps.sql` |
| `kb_answers` | ответы HR на вопросы к Квасычу, он сразу отвечает ими | `server/db/migrations/016_kb_answers.sql` |
| `hr_users`, `hr_sessions` | сотрудники HR и их сессии | `server/db/migrations/004_hr.sql`, пароли и срок сессии в `server/db/migrations/015_admin.sql` |
| `application_history` | история действий по заявке | `server/db/migrations/004_hr.sql` |
| `notify_templates` | тексты сообщений кандидатам | `server/db/migrations/004_hr.sql` |
| `funnel_events` | анонимные события воронки с сайта | `server/db/migrations/004_hr.sql` |
| `interviews` | собеседования и явка | `server/db/migrations/005_hr_workflow.sql` |
| `jobs` | очередь задач: уведомления, напоминания, вопросы новичкам | `server/db/migrations/005_hr_workflow.sql` |
| `hr_views` | сохранённые виды списка | `server/db/migrations/005_hr_workflow.sql` |
| `integration_state` | состояние выгрузки на Яндекс Диск и токены интеграций | `server/db/migrations/005_hr_workflow.sql` |
| `retention_log` | журнал удаления по сроку и по запросу | `server/db/migrations/009_retention.sql` |
| `hiring_plan` | план найма по вакансиям и месяцам | `server/db/migrations/010_hr_round3.sql` |
| `hr_sources`, `source_costs` | реестр меток источников и расходы по меткам | `server/db/migrations/014_sources.sql` |
| `hr_assign_queue` | раздача новых заявок по очереди | `server/db/migrations/015_admin.sql` |
| `vacancy_overrides`, `vacancy_override_history` | правки вакансий из панели и их история | `server/db/migrations/015_admin.sql` |
| `booking_offers`, `hiring_days` | предложения выбрать время собеседования и дни найма | `server/db/migrations/017_booking.sql` |
| `recruit_state`, `broadcasts` | состояние набора и журнал рассылок | `server/db/migrations/019_broadcast.sql` |
| `access_log` | журнал выгрузок и чтения данных: кто, с какой ролью и что забрал | `server/db/migrations/020_platform.sql` |
| `focus_responses` | анонимные ответы анкеты фокус-группы по меткам | `server/db/migrations/022_focus.sql` |
| `application_checkins` | «Как дела на смене»: когда спросили новичка и что он ответил, без свободного текста | `server/db/migrations/023_checkins.sql` |

**Запуск по отдельности.**

```bash
pnpm server      # API на http://localhost:8787 (tsx watch)
pnpm dev         # сайт на http://localhost:5180, /api проксируется на сервер
pnpm build       # проверка типов и сборка сайта в dist/, после неё сервер отдаёт и сайт
```

Без сервера заявка не отправится, и кандидат увидит честное сообщение и запасные контакты. Для показа без бэкенда есть демо-режим `VITE_DEMO_LOCAL=1`: заявки и HR-панель живут в localStorage браузера.

**API.**

| Метод | Путь | Что делает |
|---|---|---|
| GET | `/api/health` | состояние базы, версия, подключённые боты, режим помощника; секретов не отдаёт |
| GET | `/api/health/live`, `/api/health/ready` | жив ли процесс и готов ли принимать трафик (для оркестратора) |
| GET | `/api/config` | имена ботов и режим помощника для сайта |
| GET | `/api/content` | вакансии, направления, подбор работы, «Правда или миф», условия, шаги, «Путь кваса», контакты |
| GET | `/api/privacy` | какие обработчики данных подключены (Яндекс 360, SMS), для страницы политики |
| POST | `/api/applications` | новая заявка; 422 при ошибках в полях с кодами (`underage`, если моложе 18) или без согласия, 409, если заявка с этого номера уже принята, 429 при превышении лимита |
| GET | `/api/applications/:id/status` | статус для «Моей заявки», заголовок `x-status-token` |
| POST | `/api/applications/:id/withdraw` | кандидат отзывает согласие: личные данные заявки стираются сразу, задачи HR снимаются; заголовок `x-status-token` |
| GET, POST, DELETE | `/api/applications/:id/booking`, `/api/applications/:id/booking/none` | самозапись по предложению HR: свободные часы, запись или перенос, отмена, «Ни одно время не подходит, позвоните мне»; заголовок `x-status-token` |
| GET, POST | `/api/applications/:id/checkin`, `/api/applications/:id/checkin/call` | «Как дела на смене»: вопрос, который ждёт ответа, ответ и «Пусть HR позвонит»; заголовок `x-status-token` |
| GET | `/api/vacancy-overrides` | правки вакансий от HR для сайта: открыта ли вакансия, сумма, срок |
| POST | `/api/applications/:id/bot-link` | ссылки «Получать ответ HR в Telegram или MAX» с одноразовым кодом привязки на сутки, только для подключённых ботов |
| POST | `/api/events` | анонимное событие воронки: `visit`, `task_done`, `apply_open`, `application`, `game_start`, `share`; без личных данных |
| GET, POST | `/api/focus` | анкета фокус-группы: вопросы и ответ; один ответ с устройства, без личных данных и IP |
| POST | `/api/dialog` | единый диалоговый API |
| GET | `/api/media/:root/*` | картинки для чата на сайте |
| POST | `/bots/telegram`, `/bots/max` | вебхуки мессенджеров |
| POST, GET | `/api/hr/login`, `/api/hr/logout`, `/api/hr/me` | вход в HR-панель по учётной записи, сессия в cookie |
| GET | `/api/hr/desk` | плитки и очередь на сегодня |
| GET, POST, PATCH | `/api/hr/applications`, `/api/hr/applications/:id` | заявки; карточка с историей и дублями; статус, явка, собеседование, ответственный, «перезвонить», анкета, наставник и документы по практике, заметки; «+ Кандидат» |
| POST, GET, DELETE | `/api/hr/booking/offer`, `/api/hr/booking`, `/api/hr/booking/:id` | «Предложить выбрать время», открытые предложения, отзыв предложения |
| GET, POST, DELETE | `/api/hr/booking/days`, `/api/hr/booking/days/:id` | дни найма: часы и места; заявка по ссылке с меткой дня сразу выбирает час этого дня |
| POST | `/api/hr/undo`, `/api/hr/bulk`, `/api/hr/applications/:id/message` | отмена действий, массовые действия, сообщение кандидату |
| GET, POST | `/api/hr/duplicates`, `/api/hr/applications/:id/merge`, `/api/hr/applications/:id/unmerge` | дубли по телефону и склейка |
| GET, POST | `/api/hr/applications/:id/erase` | что будет стёрто и удаление данных по запросу кандидата |
| POST, GET | `/api/hr/import/parse`, `/api/hr/import/commit`, `/api/hr/import/vacancy-map` | импорт откликов hh.ru и таблиц |
| POST, GET | `/api/hr/export`, `/api/hr/export/:file` | выгрузка отфильтрованного списка; файл `applications.xlsx`, `applications.csv`, `applications.json` или `applications.1c.csv` |
| GET | `/api/hr/funnel?from=&to=` | воронка по источникам и неделям, причины отказов, время первого ответа |
| GET, PUT | `/api/hr/plan`, `/api/hr/pass`, `/api/hr/pass.xlsx` | план найма и список на проходную |
| GET, POST, DELETE | `/api/hr/views`, `/api/hr/views/:id` | сохранённые виды списка |
| GET, POST | `/api/hr/kb-gaps`, `/api/hr/kb-gaps/:id/resolve`, `/api/hr/audience`, `/api/hr/staff` | вопросы к Квасычу, аудитория ботов, сотрудники для назначения |
| GET, POST, PATCH | `/api/hr/kb-answers`, `/api/hr/kb-answers/check`, `/api/hr/kb-answers/:id` | ответы HR на «Вопросы к Квасычу»: проверка текста, сохранение, правка и выключение; Квасыч отвечает ими сразу, без перезапуска |
| GET, PUT | `/api/hr/templates`, `/api/hr/templates/:key`, `/api/hr/settings` | тексты сообщений и рабочее время (правит админ) |
| GET, POST, PATCH | `/api/hr/users`, `/api/hr/users/:id` | сотрудники, старый вариант (админ) |
| GET, POST | `/api/hr/me/account`, `/api/hr/me/password` | своя учётная запись и смена пароля |
| GET, POST, PATCH, PUT | `/api/hr/accounts`, `/api/hr/accounts/:id`, `/api/hr/accounts/:id/password`, `/api/hr/accounts/queue` | сотрудники, сброс пароля, раздача новых заявок по очереди (админ) |
| GET | `/api/hr/admin/state`, `/api/hr/admin/access-log` | проваленные задачи и журнал выгрузок (админ) |
| GET, PUT, DELETE | `/api/hr/content/vacancies`, `/api/hr/content/vacancies/:id`, `/api/hr/content/history` | правки вакансий без программиста и их история (админ) |
| GET, POST, PATCH, DELETE | `/api/hr/sources`, `/api/hr/sources/:code`, `/api/hr/sources/:code/costs`, `/api/hr/source-costs/:id` | реестр меток источников и расходы по меткам |
| GET, DELETE | `/api/hr/focus`, `/api/hr/focus/export`, `/api/hr/focus/responses`, `/api/hr/focus/responses/:id` | результаты фокус-группы по меткам, выгрузка CSV; удалить ответ или ответы метки может администратор |
| GET, POST, DELETE | `/api/hr/bots`, `/api/hr/bots/preview`, `/api/hr/bots/outbox` | состояние ботов и предпросмотр ленты в виде Telegram или MAX; в мессенджер ничего не уходит |
| GET, PUT, POST | `/api/hr/broadcast`, `/api/hr/broadcast/recruit`, `/api/hr/broadcast/preview`, `/api/hr/broadcast/:id` | рассылка подписавшимся на «Напомнить о наборе»: набор открыт или закрыт, предпросмотр, отправка, журнал доставки (админ) |
| GET, PUT, POST | `/api/hr/integrations`, `/api/hr/integrations/yandex-disk`, `/api/hr/integrations/yandex-disk/check`, `/api/hr/integrations/yandex-disk/sync` | Яндекс Диск: настройки, проверка, выгрузка по кнопке (админ) |
| GET, POST | `/api/hr/hh`, `/api/hr/hh/check`, `/api/hr/hh/vacancies/:id`, `/api/hr/hh/vacancies/:id/responses` | hh.ru: предпросмотр, черновик, публикация, архив, отклики (админ) |
| GET, POST | `/api/hr/retention`, `/api/hr/retention/run` | срок хранения: журнал и запуск обезличивания (админ) |
| POST, DELETE | `/api/hr/applications/seed`, `/api/hr/applications` | демо-данные и очистка базы, только на демо-стенде (админ) |

В HR-панель (`/hr`) входят по учётным записям сотрудников: первого администратора задают `HR_ADMIN_EMAIL` и `HR_ADMIN_PASSWORD`, в разработке без них создаётся демо-вход (он печатается в журнал сервера). Статусы заявок, уведомления в ботах, воронка, фильтр по заданиям и роли описаны в `docs/hr.md`. Старые адреса `/api/applications` (список и очистка), `/api/applications.csv`, `/api/hr/applications.csv`, `/api/applications/seed`, `/api/kb-gaps`, `/api/bots/audience` работают, но тоже только после входа.

**Что умеет бот.** Те же разделы, что на сайте: вакансии, «Практика», «Собери лето», подбор работы, «Поймай брак», «Правда или миф», «Что ты знаешь об „Очаково“» (контрольные вопросы), «Напомнить о наборе» и вопросы Квасычу. Заявка в боте собирает поля кейса: дата рождения (с 18 лет), ФИО, контакт, вуз или колледж (или «Уже не учусь»), месяцы, когда можешь выйти, вакансия; перед отправкой можно нажать «Исправить». «Моя заявка» показывает статус, первую смену и что подготовить, а если HR предложил, то и выбор часа собеседования. После первой смены, через неделю и через месяц бот спрашивает «Как дела на смене»: на «Тяжело» отвечает советом из справочника студента по причине и передаёт HR задачу перезвонить. Команда «/stop» отвязывает заявку с сайта и выключает напоминания, «/delete» удаляет свои данные. Ссылка `start=app_<код>` привязывает заявку с сайта к боту, `start=remind` подписывает на набор, `start=<метка>` задаёт источник, как `?src=` на сайте. В `pnpm bot:sim` есть служебные команды `!adult`, `!link`, `!state`.

**Единый диалоговый API.** Сценарии бота не знают про мессенджеры: движок получает пользователя и событие и возвращает сообщения в нейтральном формате (`server/dialog/types.ts`). Адаптеры Telegram и MAX вызывают движок внутри процесса, а любой новый канал может ходить в HTTP:

```bash
curl -X POST localhost:8787/api/dialog -H 'content-type: application/json' \
  -d '{"user":{"channel":"web","id":"demo-1"},"event":{"type":"start","payload":"fair-mgupp"}}'
```

Ответ: `{"messages":[{"text":"…","image":{"path":"…"},"buttons":[[{"kind":"action","text":"…","action":"…"}]]}],"notice":"…"}`. События: `start` (с меткой из диплинка), `action` (нажатие кнопки), `text`, `contact`. Кнопки: `action`, `link`, `contact` и `app`. Кнопка `app` открывает игры сайта (`/play`) во весь экран: в Telegram это web_app, мини-приложение внутри мессенджера, только для https-адреса сайта; в MAX это ссылка; в чат на сайте её не отправляем.

**Боты.** Бот запускается, только если задан его токен (`TELEGRAM_BOT_TOKEN`, `MAX_BOT_TOKEN`); адаптеры лежат в `server/channels/telegram.ts` и `server/channels/max.ts`. С пустым `PUBLIC_URL` бот работает через long polling, это удобно локально; вебхуки тогда отвечают 403. С `PUBLIC_URL` сервер ставит вебхуки `PUBLIC_URL/bots/telegram` и `PUBLIC_URL/bots/max` и принимает только запросы с секретом (`TELEGRAM_WEBHOOK_SECRET`, `MAX_WEBHOOK_SECRET`); если секрет не задан, сервер создаёт его сам. `/api/dialog` принимает не больше 40 нажатий в минуту из одного чата и код приглашения `refCode`. Бот в MAX может завести только самозанятый, ИП или компания: код адаптера готов, живого бота нет.

**Помощник.** Квасыч отвечает на свободные вопросы через GigaChat, а без ключа работает в офлайн-режиме по той же базе знаний (`docs/llm.md`).

**Защита.** Все запросы проходят общие проверки (`server/middleware/`): лимиты частоты (заявки, вход в HR, диалог, картинки), заголовки безопасности и CSP, отказ изменяющим запросам с чужих сайтов, номер запроса `X-Request-Id` и журнал в JSON без IP, тел и параметров. За прокси задайте `TRUST_PROXY=1`, иначе `X-Forwarded-For` игнорируется. На повтор заявки с того же телефона или ника за 10 минут сервер отвечает 409, а если заявок за час больше трёх, 429 `phone_limit`. Скрытое поле-ловушка `website` заявку не отклоняет, только помечает «похоже на спам». В рабочей версии сервер не стартует без администратора HR-панели.

## Развёртывание

Хостинг в России, HTTPS, вебхуки Telegram и MAX, переменные окружения, резервные копии (`pnpm db:backup`) и обновление описаны в `docs/deploy.md`. CI (`.github/workflows/ci.yml`) проверяет типы, собирает сайт и Docker-образ.
