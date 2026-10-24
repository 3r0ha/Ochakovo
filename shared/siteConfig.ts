// Настройки сайта, которые знает только сервер во время работы: GET /api/config.
// Секретов здесь нет и быть не должно — ответ открыт всем.

export type SiteConfig = {
  /**
   * Имена ботов для диплинков: Telegram — username без @ (t.me/<имя>), MAX — ник (max.ru/<ник>).
   * null — бот не работает или имя не задано: кнопку бота на сайте не показываем
   */
  bots: { telegram: string | null; max: string | null }
  /** Кто отвечает в чате: GigaChat по ключу или офлайн-движок без ключа */
  assistant: 'gigachat' | 'offline'
}
