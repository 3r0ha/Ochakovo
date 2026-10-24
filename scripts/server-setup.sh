#!/usr/bin/env bash
# Стенд на чистой Ubuntu 22.04 одной командой: Docker, проект с GitHub, база, сайт, HR-панель и HTTPS через Caddy.
# Запуск в веб-консоли облака или по SSH (нужен sudo):
#
#   curl -fsSL https://raw.githubusercontent.com/3r0ha/Ochakovo/main/scripts/server-setup.sh | bash
#
# Скрипт спросит ключ GigaChat (можно пропустить: Квасыч ответит готовыми ответами из базы), сам создаст пароль базы
# и вход в HR-панель и в конце покажет их. Повторный запуск обновляет проект и перезапускает контейнеры,
# .env и база остаются. Домен и папку можно поменять: DOMAIN=example.ru DIR=/opt/site bash server-setup.sh
set -euo pipefail

DOMAIN="${DOMAIN:-antihype.best}"
DIR="${DIR:-$HOME/ochakovo}"
REPO="${REPO:-https://github.com/3r0ha/Ochakovo.git}"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
# Скрипт приходит через curl | bash: stdin занят самим скриптом, вопросы задаём через терминал
ask() { local v=""; if [ -r /dev/tty ]; then read -r -p "$1" v </dev/tty || true; fi; printf '%s' "$v"; }
ask_secret() { local v=""; if [ -r /dev/tty ]; then read -r -s -p "$1" v </dev/tty || true; echo >&2; fi; printf '%s' "$v"; }

say "1/6 Пакеты: Docker, Compose, git"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates curl git openssl docker.io >/dev/null
# Compose v2 и buildx в Ubuntu 22.04 лежат в jammy-updates под этими именами
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker-compose-v2 docker-buildx >/dev/null 2>&1 \
  || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker-compose-plugin >/dev/null 2>&1 || true
sudo docker compose version >/dev/null || { echo "Не нашёлся docker compose. Поставьте пакет docker-compose-v2 и запустите скрипт ещё раз"; exit 1; }

# Docker Hub из российских облаков отвечает с перебоями: образы node, postgres и caddy берём через зеркала,
# если их нет — Docker сам пойдёт на Docker Hub. Свой daemon.json не трогаем
if [ ! -f /etc/docker/daemon.json ]; then
  echo '{ "registry-mirrors": ["https://mirror.gcr.io", "https://dockerhub.timeweb.cloud"] }' | sudo tee /etc/docker/daemon.json >/dev/null
fi
sudo systemctl enable --now docker >/dev/null
sudo systemctl restart docker
sudo usermod -aG docker "$USER" || true
DOCKER="sudo docker"

say "2/6 Проект с GitHub в $DIR"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only
else
  git clone --depth 1 "$REPO" "$DIR"
fi
cd "$DIR"

say "3/6 Сертификат Минцифры для GigaChat"
sh scripts/max-cert.sh >/dev/null && echo "certs/russian_trusted_root_ca.pem на месте" || echo "Не скачался: GigaChat не подключится, Квасыч ответит из базы"

say "4/6 Настройки в .env"
if [ -f .env ]; then
  echo ".env уже есть, оставляю как есть"
else
  KEY="$(ask_secret 'Ключ авторизации GigaChat (Enter, чтобы пропустить): ')"
  EMAIL="$(ask "Почта для входа в HR-панель [jury@$DOMAIN]: ")"
  EMAIL="${EMAIL:-jury@$DOMAIN}"
  HR_PASS="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 16)"
  umask 077
  cat >.env <<ENV
# Стенд $DOMAIN, создан scripts/server-setup.sh. Все переменные описаны в .env.example
DOMAIN=$DOMAIN
SITE_URL=https://$DOMAIN
TRUST_PROXY=1
POSTGRES_PASSWORD=$(openssl rand -hex 24)
HR_ADMIN_EMAIL=$EMAIL
HR_ADMIN_PASSWORD=$HR_PASS
# Демо-стенд для жюри: «Демо-данные» и «Очистить базу» в HR-панели
HR_DEMO_TOOLS=1
GIGACHAT_AUTH_KEY=$KEY
GIGACHAT_SCOPE=GIGACHAT_API_PERS
# Боты: Telegram из России недоступен, см. docs/deploy.md («Telegram: профиль, мини-приложение и доступ из России»)
TELEGRAM_BOT_TOKEN=
TELEGRAM_BOT_USERNAME=
TELEGRAM_API_BASE=
ENV
  umask 022
  echo "Создан .env (права 600)"
fi

say "5/6 Сборка и запуск: база, сайт, HTTPS"
$DOCKER compose --profile local-db --profile https up -d --build

say "6/6 Проверка"
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8787/api/health/ready >/dev/null 2>&1; then break; fi
  sleep 2
done
if curl -fsS http://127.0.0.1:8787/api/health/ready >/dev/null 2>&1; then
  echo "Сервер готов: http://127.0.0.1:8787"
  curl -fsS http://127.0.0.1:8787/api/health | head -c 300; echo
else
  echo "Сервер не ответил за 2 минуты. Журнал: cd $DIR && sudo docker compose logs app --tail 80"
fi
IP="$(curl -4 -fsS -m 5 http://icanhazip.com 2>/dev/null || true)"
DNS="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}')"
if [ -n "$IP" ] && [ "$DNS" = "$IP" ]; then
  echo "Домен $DOMAIN смотрит на эту машину ($IP). Сертификат Caddy получит сам, обычно за минуту."
else
  echo "Домен $DOMAIN смотрит на ${DNS:-нигде}, а машина выходит с ${IP:-неизвестного адреса}."
  echo "Пропишите у регистратора A-записи @ и www на ${IP:-адрес машины}, Caddy получит сертификат, как только они разойдутся."
fi

say "Готово"
echo "Сайт:       https://$DOMAIN"
echo "Материалы:  https://$DOMAIN/materials"
echo "HR-панель:  https://$DOMAIN/hr"
grep -E '^HR_ADMIN_(EMAIL|PASSWORD)=' .env | sed 's/^HR_ADMIN_EMAIL=/  почта:    /; s/^HR_ADMIN_PASSWORD=/  пароль:   /'
echo "Журналы:    cd $DIR && sudo docker compose logs -f app caddy"
echo "Обновить:   запустите эту же команду ещё раз"
