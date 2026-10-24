#!/usr/bin/env sh
# Восстановление базы из копии scripts/backup.sh. Перезаписывает данные — спрашивает подтверждение.
# Запуск: sh scripts/restore.sh backups/ochakovo-<время>.dump  (или pnpm db:restore -- <файл>)
#   DATABASE_URL — куда восстанавливать (по умолчанию из .env); FORCE=1 — без вопроса
set -eu
cd "$(dirname "$0")/.."

file="${1:-}"
if [ -z "$file" ] || [ ! -f "$file" ]; then
  echo "Укажите файл копии: sh scripts/restore.sh backups/ochakovo-….dump"
  ls -1t backups/ochakovo-*.dump 2>/dev/null | head -5 | sed 's/^/  /'
  exit 1
fi

if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then
  DATABASE_URL=$(grep -E '^DATABASE_URL=' .env | tail -1 | cut -d= -f2-)
fi
: "${DATABASE_URL:?Не задан DATABASE_URL}"

target=$(printf '%s' "$DATABASE_URL" | sed -E 's#//[^@]*@#//***@#')
if [ "${FORCE:-0}" != "1" ]; then
  printf 'Восстановить %s в %s? Текущие данные будут заменены. [y/N] ' "$file" "$target"
  read -r answer
  [ "$answer" = "y" ] || [ "$answer" = "Y" ] || { echo "Отменено"; exit 1; }
fi

pg_restore --clean --if-exists --no-owner --no-privileges --dbname="$DATABASE_URL" "$file"
echo "Готово: база восстановлена из $file"
