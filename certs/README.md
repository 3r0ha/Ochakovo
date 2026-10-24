# Сертификаты

MAX Bot API (`platform-api2.max.ru`) использует сертификат, выпущенный «Russian Trusted Root CA» Минцифры. Node по умолчанию ему не доверяет, и запросы к API падают с ошибкой TLS.

1. Скачать корневой сертификат:

   ```bash
   sh scripts/max-cert.sh
   ```

   Файл появится в `certs/russian_trusted_root_ca.pem`.

2. Запускать сервер с переменной окружения:

   ```bash
   NODE_EXTRA_CA_CERTS=certs/russian_trusted_root_ca.pem pnpm server
   ```

   Для Telegram сертификат не нужен.

Сам `.pem` в репозиторий не кладём — его всегда можно скачать скриптом.
