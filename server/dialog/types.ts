// Единый формат диалога. Сценарии бота знают только эти типы — ни Telegram, ни MAX.
// Адаптер канала переводит входящее обновление в DialogEvent, а OutMessage — в вызовы API мессенджера.

export type Channel = 'telegram' | 'max' | 'web'

export type DialogUser = {
  channel: Channel
  /** id пользователя внутри канала */
  id: string
  firstName?: string
  username?: string
}

export type DialogEvent =
  /** Первый запуск или /start; payload — метка из диплинка (?start=fair-mgupp) */
  | { type: 'start'; payload?: string }
  /** Нажатие кнопки; action — строка из Button.action, не длиннее 64 байт */
  | { type: 'action'; action: string }
  | { type: 'text'; text: string }
  /** Пользователь поделился номером через кнопку «Отправить контакт» */
  | { type: 'contact'; phone: string }

export type Button =
  | { kind: 'action'; text: string; action: string }
  | { kind: 'link'; text: string; url: string }
  /** Запрос номера телефона — в Telegram это reply-кнопка, в MAX — request_contact */
  | { kind: 'contact'; text: string }

export type OutMessage = {
  /** Текст без разметки, кроме **жирного** — адаптер сам переводит в HTML или markdown канала */
  text: string
  /** Картинка из public/ (например 'photos/lab-960.webp' или сгенерированный файл) */
  image?: { path: string }
  /** Ряды кнопок под сообщением */
  buttons?: Button[][]
  /** Заменить последнее сообщение бота вместо отправки нового, если канал это умеет */
  replace?: boolean
  /**
   * Чего бот ждёт в поле ввода после этого сообщения: name — имя, phone — телефон или ник, free — любой текст,
   * date — дата рождения ДД.ММ.ГГГГ (цифровая клавиатура, autocomplete=bday, маска maskBirthDate из shared/birthDate).
   * Сайт ставит подсказку и клавиатуру (inputmode=tel), Telegram — input_field_placeholder.
   * date бот начнёт присылать, когда его поддержат чат на сайте и адаптеры (BIRTH_INPUT в flows/apply.ts); до того — free
   */
  input?: 'name' | 'phone' | 'free' | 'date'
}

/** Заявка, только что отправленная из чата на сайте: браузер запоминает её для «Моей заявки» */
export type DialogApplication = {
  id: string
  /** Токен для «Моей заявки» — приходит один раз, в базе только хеш */
  token: string
  name: string
  phone: string
  contact: string
  vacancyId: string
  friend: string
}

export type DialogReply = {
  messages: OutMessage[]
  /** Короткое всплывающее уведомление в ответ на нажатие кнопки */
  notice?: string
  /** Заявка сохранена в этом ответе. Только для канала web: ботам в мессенджерах её не отдаём */
  application?: DialogApplication
}

/** Задания, пройденные на странице сайта, — чат на сайте показывает ту же «Смену», что и страница */
export type SiteProgress = {
  game?: boolean
  money?: boolean
  quiz?: boolean
  myth?: boolean
  /** Вакансия из подбора работы на сайте */
  quizVacancy?: string
  /** Месяцы из «Собери лето» на сайте */
  months?: number[]
  /** Лучший счёт в «Поймай брак» на сайте */
  conveyorBest?: number
}

/** Дополнительные данные запроса веб-чата: прогресс заданий, заявка и код приглашения этого браузера */
export type HandleMeta = {
  siteProgress?: SiteProgress
  /** Чат на сайте знает номер и токен заявки этого браузера — бот может показать её статус (storage.statusForToken) */
  application?: { id: string; token: string }
  /** Личный код приглашения браузера (REF_CODE_RE из shared/applicationInput.ts): «Позвать друга» в веб-чате и заявка из чата берут его */
  refCode?: string
}

export interface DialogEngine {
  handle(user: DialogUser, event: DialogEvent, meta?: HandleMeta): Promise<DialogReply>
}

/** Общий интерфейс адаптера: запуск в режиме long polling (локально) или приём вебхука (прод) */
export interface ChannelAdapter {
  channel: Exclude<Channel, 'web'>
  /** Опрос обновлений без публичного адреса — для локальной разработки */
  startPolling(engine: DialogEngine, signal: AbortSignal): Promise<void>
  /** Обработать тело вебхука; вызывается HTTP-сервером */
  handleWebhook(engine: DialogEngine, body: unknown): Promise<void>
}
