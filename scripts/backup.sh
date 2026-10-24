#!/usr/bin/env sh
# Резервная копия базы: pg_dump в сжатом формате + удаление старых копий.
# Запуск: sh scripts/backup.sh  (или pnpm db:backup)
#   DATABASE_URL       — какую базу копировать (по умолчанию из .env)
#   BACKUP_DIR         — куда складывать (по умолчанию backups/)
#   BACKUP_KEEP_DAYS   — сколько дней хранить копии (по умолчанию 14)
# Для Docker: docker compose exec -T db pg_dump -U ochakovo -Fc ochakovo > backups/ochakovo.dump
set -eu
cd "$(dirname "$0")/.."

if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then
  DATABASE_URL=$(grep -E '^DATABASE_URL=' .env | tail -1 | cut -d= -f2-)
fi
: "${DATABASE_URL:?Не задан DATABASE_URL}"

dir="${BACKUP_DIR:-backups}"
keep="${BACKUP_KEEP_DAYS:-14}"
mkdir -p "$dir"
chmod 700 "$dir"

file="$dir/ochakovo-$(date +%Y%m%d-%H%M%S).dump"
pg_dump --format=custom --no-owner --no-privileges --dbname="$DATABASE_URL" --file="$file"
chmod 600 "$file"
echo "Копия: $file ($(du -h "$file" | cut -f1))"

# Старые копии — в корзину; свежая остаётся всегда
find "$dir" -name 'ochakovo-*.dump' -type f -mtime "+$keep" -print -delete | sed 's/^/Удалена старая копия: /'
