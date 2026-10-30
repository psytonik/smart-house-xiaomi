#!/bin/bash
# camera.sh - the one file that runs the whole camera app: go2rtc (motor build) + backend + web app.
#
#   ./camera.sh              start everything, follow the logs; Ctrl+C stops what this script started
#   ./camera.sh up           start everything in the background and return (close the terminal if you like)
#   ./camera.sh stop         stop what this script started
#   ./camera.sh restart      stop, then start in the background
#   ./camera.sh status       what is running, and the addresses
#   ./camera.sh logs         follow the logs of both
#   ./camera.sh motor left|right|up|down     move the camera by hand (go2rtc must be running)
#   ./camera.sh build-motor  build go2rtc-motor from source (needs git and Go >= 1.26)
#   ./camera.sh fetch-model  download the object detection model (YOLOX-Tiny, ~20 MB, Apache-2.0) once
#   ./camera.sh label-clips  label older clips with person / vehicle / animal (after fetch-model)
#   ./camera.sh ble-setup    one-time setup of the Bluetooth helper for the Lotus Lantern strip (run from Terminal.app)
#
# Safe to run twice: a service that is already running (even one you started in another terminal) is
# reused and left alone; only services started by this script are stopped by it.
# Works with the bash that ships with macOS (3.2).

cd "$(dirname "$0")" || exit 1

RUN=.run
LOGS=logs
GO2RTC_API=${GO2RTC_API:-http://127.0.0.1:1984}

say()  { printf '%s\n' "$*"; }
warn() { printf '! %s\n' "$*" >&2; }
die()  { printf 'Ошибка: %s\n' "$*" >&2; exit 1; }

# A value from backend/.env. Only used for non-secret keys (PORT, HOST, STREAM_NAME).
env_value() {
  [ -f backend/.env ] || return 0
  grep -E "^$1=" backend/.env | tail -1 | cut -d= -f2- | sed -e 's/\r$//' -e "s/^['\"]//" -e "s/['\"]\$//"
}

PORT=$(env_value PORT);          PORT=${PORT:-3100}
HOST=$(env_value HOST);          HOST=${HOST:-127.0.0.1}
STREAM=$(env_value STREAM_NAME); STREAM=${STREAM:-psytonik_base}
BLE_PORT=${BLE_HELPER_PORT:-3200}

# Object detection model: YOLOX-Tiny from the official YOLOX release (Apache-2.0). The checksum is pinned, so a
# different or damaged file is refused.
MODEL_FILE=backend/models/yolox_tiny.onnx
MODEL_URL=https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_tiny.onnx
MODEL_SHA256=427cc366d34e27ff7a03e2899b5e3671425c262ea2291f88bb942bc1cc70b0f7

http_up()   { curl -s -o /dev/null --max-time 2 "$1"; }
pid_of()    { cat "$RUN/$1.pid" 2>/dev/null; }
is_ours()   { local p; p=$(pid_of "$1"); [ -n "$p" ] && kill -0 "$p" 2>/dev/null; }
rotate()    { [ -f "$1" ] && [ "$(wc -c < "$1")" -gt 10485760 ] && mv -f "$1" "$1.1"; return 0; }
lan_ip()    { ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null; }

# ---------------------------------------------------------------- checks

preflight() {
  command -v node >/dev/null || die "не найден node. Нужен Node 22 или новее: https://nodejs.org"
  local major; major=$(node -v | sed 's/^v\([0-9]*\).*/\1/')
  [ "$major" -ge 22 ] 2>/dev/null || die "Node $(node -v) слишком старый, нужен 22 или новее"

  [ -x ./go2rtc-motor ] || die "нет ./go2rtc-motor. Соберите его: ./camera.sh build-motor"
  [ -f go2rtc.yaml ]    || die "нет go2rtc.yaml (поток камеры). Он создаётся через веб-интерфейс go2rtc после входа в Mi Home"
  [ -f backend/.env ]   || die "нет backend/.env. Скопируйте backend/.env.example в backend/.env и впишите API_TOKEN (openssl rand -hex 24)"
  local len; len=$(( $(env_value API_TOKEN | tr -d '\n' | wc -c) ))
  [ "$len" -ge 16 ]     || die "в backend/.env нет API_TOKEN или он короче 16 символов (openssl rand -hex 24)"

  command -v ffmpeg >/dev/null || warn "ffmpeg не найден: не будут работать снимки и запись по движению (brew install ffmpeg)"
  [ -f "$MODEL_FILE" ] || say "Подсказка: распознавание людей и машин выключено, нет модели. Скачайте её один раз: ./camera.sh fetch-model"

  if [ ! -d backend/node_modules ]; then
    say "Устанавливаю зависимости бэкенда (один раз)..."
    (cd backend && npm install --no-audit --no-fund) || die "npm install в backend не удался"
  fi
  if [ ! -f backend/public/index.html ]; then
    say "Собираю веб-приложение (один раз)..."
    (cd web && { [ -d node_modules ] || npm install --no-audit --no-fund; } && npm run build) || die "сборка веб-приложения не удалась"
  fi
}

# ---------------------------------------------------------------- start / stop

start_go2rtc() {
  if is_ours go2rtc; then say "go2rtc: уже запущен этим скриптом (pid $(pid_of go2rtc))"; return; fi
  if http_up "$GO2RTC_API/api"; then say "go2rtc: уже работает (запущен не этим скриптом), использую его и не трогаю"; return; fi

  xattr -d com.apple.quarantine ./go2rtc-motor 2>/dev/null
  rotate "$LOGS/go2rtc.log"
  nohup ./go2rtc-motor -config go2rtc.yaml >> "$LOGS/go2rtc.log" 2>&1 &
  echo $! > "$RUN/go2rtc.pid"
  disown $!   # no "Terminated" noise from bash when it is stopped later

  local i
  for i in $(seq 1 40); do
    is_ours go2rtc || { tail -n 15 "$LOGS/go2rtc.log" >&2; rm -f "$RUN/go2rtc.pid"; die "go2rtc сразу завершился (лог выше, полный: $LOGS/go2rtc.log)"; }
    http_up "$GO2RTC_API/api" && { say "go2rtc: запущен (pid $(pid_of go2rtc))"; return; }
    sleep 0.5
  done
  die "go2rtc не ответил за 20 секунд, смотрите $LOGS/go2rtc.log"
}

start_backend() {
  if is_ours backend; then say "бэкенд: уже запущен этим скриптом (pid $(pid_of backend))"; return; fi
  if http_up "http://127.0.0.1:$PORT/health"; then say "бэкенд: уже работает на порту $PORT (запущен не этим скриптом), использую его и не трогаю"; return; fi
  if [ -n "$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null)" ]; then
    die "порт $PORT занят другой программой. Освободите его или поменяйте PORT в backend/.env"
  fi

  rotate "$LOGS/backend.log"
  # exec: the subshell becomes tsx itself, so $! is the pid we can stop later
  (cd backend && exec nohup ./node_modules/.bin/tsx --env-file=.env src/server.ts >> "../$LOGS/backend.log" 2>&1) &
  echo $! > "$RUN/backend.pid"
  disown $!

  local i
  for i in $(seq 1 60); do
    is_ours backend || { tail -n 15 "$LOGS/backend.log" >&2; rm -f "$RUN/backend.pid"; die "бэкенд сразу завершился (лог выше, полный: $LOGS/backend.log)"; }
    http_up "http://127.0.0.1:$PORT/health" && { say "бэкенд: запущен (pid $(pid_of backend)), порт $PORT"; return; }
    sleep 0.5
  done
  die "бэкенд не ответил за 30 секунд, смотрите $LOGS/backend.log"
}

# Optional: the Bluetooth helper for the Lotus Lantern strip (tools/ble_helper.py). Set it up once: ./camera.sh ble-setup
# macOS gives Bluetooth only to apps that declare it, so camera.sh must run from Terminal.app (Warp does not work).
# Not set up, or failing to start: the camera app carries on without it.
start_ble() {
  [ -x ./venv/bin/python ] && [ -f tools/ble_helper.py ] || return 0
  if is_ours ble; then say "Bluetooth-помощник: уже запущен этим скриптом (pid $(pid_of ble))"; return; fi
  if http_up "http://127.0.0.1:$BLE_PORT/state"; then say "Bluetooth-помощник: уже работает (запущен не этим скриптом), использую его и не трогаю"; return; fi
  local token; token=$(env_value BLE_HELPER_TOKEN)
  if [ "${#token}" -lt 16 ]; then warn "Bluetooth-помощник пропущен: в backend/.env нет BLE_HELPER_TOKEN (./camera.sh ble-setup)"; return; fi
  case "${TERM_PROGRAM:-}" in
    Apple_Terminal|iTerm.app) ;;
    *) warn "Bluetooth разрешён только Terminal.app и iTerm, а здесь: ${TERM_PROGRAM:-неизвестно}. Команда ленты может завершить помощника сбоем." ;;
  esac

  rotate "$LOGS/ble.log"
  BLE_HELPER_TOKEN="$token" BLE_HELPER_PORT="$BLE_PORT" nohup ./venv/bin/python tools/ble_helper.py >> "$LOGS/ble.log" 2>&1 &
  echo $! > "$RUN/ble.pid"
  disown $!

  local i
  for i in $(seq 1 10); do
    is_ours ble || { warn "Bluetooth-помощник сразу завершился (лог: $LOGS/ble.log)"; rm -f "$RUN/ble.pid"; return; }
    http_up "http://127.0.0.1:$BLE_PORT/state" && { say "Bluetooth-помощник: запущен (pid $(pid_of ble)), порт $BLE_PORT"; return; }
    sleep 0.5
  done
  warn "Bluetooth-помощник не ответил за 5 секунд, смотрите $LOGS/ble.log"
}

stop_one() {
  local name=$1 p i
  p=$(pid_of "$name")
  if [ -z "$p" ] || ! kill -0 "$p" 2>/dev/null; then rm -f "$RUN/$name.pid"; return 1; fi
  pkill -TERM -P "$p" 2>/dev/null   # tsx starts node as a child
  kill -TERM "$p" 2>/dev/null
  for i in $(seq 1 20); do kill -0 "$p" 2>/dev/null || break; sleep 0.5; done
  if kill -0 "$p" 2>/dev/null; then pkill -KILL -P "$p" 2>/dev/null; kill -KILL "$p" 2>/dev/null; fi
  rm -f "$RUN/$name.pid"
  say "$name: остановлен"
}

stop_all() {
  local any=1
  stop_one backend && any=0   # the backend first: it talks to go2rtc while closing
  stop_one ble     && any=0
  stop_one go2rtc  && any=0
  [ "$any" -eq 0 ] || say "Нечего останавливать: этот скрипт ничего не запускал."
}

up() {
  mkdir -p "$RUN" "$LOGS"
  preflight
  start_go2rtc
  start_backend
  start_ble
}

summary() {
  say ""
  say "Приложение:   http://localhost:$PORT"
  if [ "$HOST" = "0.0.0.0" ]; then
    local ip; ip=$(lan_ip)
    [ -n "$ip" ] && say "В сети:        http://$ip:$PORT   (HTTP без шифрования: только домашняя сеть)"
  elif [ "$HOST" = "127.0.0.1" ] || [ "$HOST" = "localhost" ]; then
    say "Доступ:        только с этого Mac (HOST=$HOST в backend/.env)"
  else
    say "Слушает:       http://$HOST:$PORT"
  fi
  say "go2rtc:        $GO2RTC_API   (веб-интерфейс, только на этом Mac)"
  { is_ours ble || http_up "http://127.0.0.1:$BLE_PORT/state"; } && say "Bluetooth:     http://127.0.0.1:$BLE_PORT   (помощник для ленты Lotus Lantern, только на этом Mac)"
  say "Логи:          $LOGS/backend.log, $LOGS/go2rtc.log   (./camera.sh logs)"
  say ""
}

# ---------------------------------------------------------------- commands

cmd_start() {
  up
  summary
  if ! is_ours go2rtc && ! is_ours backend; then
    say "Всё уже работало без этого скрипта, поэтому управлять нечем. Остановите это там, где оно запущено."
    return
  fi
  say "Работает. Ctrl+C остановит то, что запустил этот скрипт."
  local stop=0 name
  trap 'stop=1' INT TERM
  tail -n 5 -F "$LOGS/go2rtc.log" "$LOGS/backend.log" 2>/dev/null &
  local tail_pid=$!
  disown $tail_pid
  while [ "$stop" -eq 0 ]; do
    for name in go2rtc backend; do
      if [ -f "$RUN/$name.pid" ] && ! is_ours "$name"; then
        warn "$name неожиданно завершился. Последние строки лога:"
        tail -n 15 "$LOGS/$name.log" >&2
        stop=1
      fi
    done
    [ "$stop" -eq 0 ] && sleep 2
  done
  kill "$tail_pid" 2>/dev/null
  trap - INT TERM
  say ""
  stop_all
}

cmd_status() {
  local name label url
  for name in go2rtc backend; do
    if [ "$name" = go2rtc ]; then label="go2rtc "; url="$GO2RTC_API/api"; else label="бэкенд "; url="http://127.0.0.1:$PORT/health"; fi
    if is_ours "$name"; then say "$label работает (запущен этим скриптом, pid $(pid_of "$name"))"
    elif http_up "$url"; then say "$label работает (запущен не этим скриптом)"
    else say "$label не запущен"; fi
  done
  if [ -x ./venv/bin/python ] && [ -f tools/ble_helper.py ]; then
    if is_ours ble; then say "Bluetooth работает (запущен этим скриптом, pid $(pid_of ble))"
    elif http_up "http://127.0.0.1:$BLE_PORT/state"; then say "Bluetooth работает (запущен не этим скриптом)"
    else say "Bluetooth не запущен"; fi
  fi
  http_up "http://127.0.0.1:$PORT/health" && summary
  return 0
}

cmd_motor() {
  local op
  case "${1:-}" in left) op=1;; right) op=2;; up) op=3;; down) op=4;; *) die "использование: ./camera.sh motor left|right|up|down";; esac
  curl -s -X POST "$GO2RTC_API/api/xiaomi/motor?src=$STREAM&operation=$op" -w "HTTP %{http_code}\n"
}

# Builds go2rtc v1.9.15 + the Xiaomi pan/tilt motor patch (from go2rtc PR #2531, Xiaomi part only).
cmd_build_motor() {
  command -v git >/dev/null || die "нужен git"
  command -v go  >/dev/null || die "нужен Go >= 1.26 (brew install go)"
  [ -f motor-xiaomi.patch ] || die "нет motor-xiaomi.patch"
  rm -rf src-motor
  git clone --depth 1 --branch v1.9.15 https://github.com/AlexxIT/go2rtc.git src-motor || die "не удалось скачать go2rtc"
  (cd src-motor && git apply ../motor-xiaomi.patch && CGO_ENABLED=0 go build -ldflags "-s -w" -trimpath -o ../go2rtc-motor) || { rm -rf src-motor; die "сборка не удалась"; }
  rm -rf src-motor
  say "Собрано: $(pwd)/go2rtc-motor"
}

cmd_fetch_model() {
  mkdir -p "$(dirname "$MODEL_FILE")"
  if [ -f "$MODEL_FILE" ] && [ "$(shasum -a 256 "$MODEL_FILE" | cut -d' ' -f1)" = "$MODEL_SHA256" ]; then
    say "Модель уже на месте и проверена: $MODEL_FILE"
    return
  fi
  say "Скачиваю YOLOX-Tiny (~20 МБ) с github.com/Megvii-BaseDetection/YOLOX..."
  curl -fL --max-time 300 -o "$MODEL_FILE.part" "$MODEL_URL" || { rm -f "$MODEL_FILE.part"; die "не удалось скачать модель"; }
  if [ "$(shasum -a 256 "$MODEL_FILE.part" | cut -d' ' -f1)" != "$MODEL_SHA256" ]; then
    rm -f "$MODEL_FILE.part"
    die "контрольная сумма не совпала: файл не тот, что ожидался, он удалён"
  fi
  mv "$MODEL_FILE.part" "$MODEL_FILE"
  say "Готово: $MODEL_FILE. Перезапустите приложение (./camera.sh restart), затем при желании ./camera.sh label-clips"
}

cmd_label_clips() {
  [ -f "$MODEL_FILE" ] || die "нет модели. Сначала: ./camera.sh fetch-model"
  [ -f backend/.env ] || die "нет backend/.env"
  [ -d backend/node_modules ] || die "нет зависимостей бэкенда: запустите ./camera.sh один раз"
  (cd backend && npm run --silent label)
}

# One-time setup of the Bluetooth helper: a Python environment with bleak, and a token shared with the backend.
cmd_ble_setup() {
  command -v python3 >/dev/null || die "нужен python3 (brew install python)"
  command -v openssl >/dev/null || die "нужен openssl"
  [ -f tools/ble_helper.py ] || die "нет tools/ble_helper.py"
  [ -f backend/.env ]        || die "нет backend/.env"
  mkdir -p "$RUN" "$LOGS"
  [ -x ./venv/bin/python ] || python3 -m venv venv || die "не удалось создать окружение venv"
  ./venv/bin/python -c 'import bleak' 2>/dev/null || ./venv/bin/python -m pip install --quiet bleak || die "не удалось установить bleak"
  grep -qx 'venv/' .gitignore 2>/dev/null || { [ -n "$(tail -c1 .gitignore 2>/dev/null)" ] && printf '\n' >> .gitignore; printf 'venv/\n' >> .gitignore; }
  if [ "$(( $(env_value BLE_HELPER_TOKEN | tr -d '\n' | wc -c) ))" -ge 16 ]; then
    say "Токен помощника уже есть в backend/.env"
  else
    local t; t=$(openssl rand -hex 16) && [ -n "$t" ] || die "не удалось создать токен"
    [ -n "$(tail -c1 backend/.env)" ] && printf '\n' >> backend/.env
    printf 'BLE_HELPER_TOKEN=%s\n' "$t" >> backend/.env
    say "Токен помощника записан в backend/.env (на экран не выводится)"
  fi
  say "Готово. Запускайте ./camera.sh из Terminal.app (не из Warp); при первой команде ленты macOS спросит про Bluetooth."
}

case "${1:-start}" in
  start|"")      cmd_start ;;
  up)            up; summary ;;
  stop)          stop_all ;;
  restart)       stop_all; up; summary ;;
  status)        cmd_status ;;
  logs)          if [ -f "$LOGS/ble.log" ]; then tail -n 50 -F "$LOGS/go2rtc.log" "$LOGS/backend.log" "$LOGS/ble.log"; else tail -n 50 -F "$LOGS/go2rtc.log" "$LOGS/backend.log"; fi ;;
  motor)         cmd_motor "${2:-}" ;;
  build-motor)   cmd_build_motor ;;
  fetch-model)   cmd_fetch_model ;;
  label-clips)   cmd_label_clips ;;
  ble-setup)     cmd_ble_setup ;;
  -h|--help|help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//' ;;
  *)             die "неизвестная команда: $1 (./camera.sh help)" ;;
esac
