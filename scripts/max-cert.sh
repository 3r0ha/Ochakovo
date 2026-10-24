#!/usr/bin/env sh
# Скачивает корневой сертификат «Russian Trusted Root CA» (Минцифры) для MAX Bot API.
# Без него Node не доверяет platform-api2.max.ru. Запуск: sh scripts/max-cert.sh
set -e
cd "$(dirname "$0")/.."
mkdir -p certs
curl -fsSL https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt -o certs/russian_trusted_root_ca.pem
openssl x509 -in certs/russian_trusted_root_ca.pem -noout -subject -enddate
echo "Готово. Запускайте сервер с NODE_EXTRA_CA_CERTS=certs/russian_trusted_root_ca.pem"
