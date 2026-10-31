# Xiaomi camera backend

Тонкий слой между мобильным приложением и go2rtc: авторизация по токену, PTZ, снимки, прокси видео.
go2rtc остаётся на `127.0.0.1`, наружу смотрит только этот сервис.

## Запуск

```bash
cd backend
npm install
cp .env.example .env        # впиши API_TOKEN (openssl rand -hex 24)
npm run dev                 # http://localhost:3100 (порт из .env)
npm test                    # тесты на имитации go2rtc
```

Перед этим должен работать go2rtc **motor-сборка** (`../start-motor.sh`) с потоком `psytonik_base`.

## Веб-приложение

Исходники в `../web`. Готовая сборка лежит в `backend/public`, бэкенд отдаёт её на `/`:

```bash
npm install            # один раз: подтянет @fastify/static
npm run dev            # открой http://localhost:3100 и введи API_TOKEN
```

Если меняешь интерфейс: `cd ../web && npm install && npm run build` (сборка обновит `backend/public`)
или `npm run dev` в `web/` для живой разработки на http://localhost:5173 (запросы к API проксируются на :3100).

## API

Все `/api/*` требуют заголовок `Authorization: Bearer <API_TOKEN>`. Токен в адресе не принимается.
Клипы, превью и снимки открываются подписанными ссылками `?exp=…&sig=…` (ADR 0001); после `AUTH_MAX_FAILURES` неверных токенов адрес блокируется (ADR 0002).

| Метод | Путь | Что делает |
|-------|------|------------|
| GET | `/health` | проверка живости, без токена |
| GET | `/api/status` | состояние потока в go2rtc и диск (`storage`) |
| GET | `/api/system` | сводка здоровья простыми словами: go2rtc, картинка, распознавание, диск, хранилище, push; `uptimeSec` |
| POST | `/api/ptz` | `{"direction":"left\|right\|up\|down","steps":1}` — поворот на шаг(и), steps 1..5 |
| GET | `/api/snapshot` | текущий кадр JPEG |
| POST | `/api/snapshots` | сохранить кадр в `data/snapshots/` |
| GET | `/api/snapshots` | список сохранённых снимков, у каждого подписанная ссылка `url` |
| GET | `/api/snapshots/:name` | файл снимка |
| GET, PUT | `/api/zones` | зоны движения и скрытые области (`watch` / `ignore` / `privacy`), список целиком |
| GET | `/api/push` | `{devices, minIntervalSec}` |
| POST | `/api/push/register`, `/api/push/unregister` | `{token}` Expo-токена телефона |
| POST | `/api/push/test` | тестовое уведомление (409, если нет телефонов) |
| GET | `/api/cameras` | потоки go2rtc (имена, без источников) и аккаунты Mi Home |
| POST | `/api/xiaomi/login` | `{username,password}` или `{captcha}` или `{verify}` |
| GET | `/api/xiaomi/devices?account&region` | камеры аккаунта в регионе |
| POST | `/api/cameras` | `{account,region,did,name}`: добавить камеру в go2rtc (источник берёт бэкенд, ADR 0013) |
| GET | `/api/stream.m3u8` | HLS-плейлист (сегменты: `/api/hls/*`) |
| POST | `/api/stream/reset` | сбросить поток: остановить запись, дождаться, пока go2rtc отпустит камеру (до 6 с), запустить снова; ответ `{ok, otherViewers}` |
| POST | `/api/webrtc` | WebRTC-offer (SDP или JSON) → answer |
| GET | `/api/motion` | состояние записи: `enabled`, `state`, `recording`, `level` (% изменившегося кадра) |
| GET | `/api/events?limit=50` | клипы по движению, новые сверху; у каждого `clipUrl` и `thumbUrl` (подписанные ссылки), `objects` |
| GET | `/api/events/:id/clip` | mp4 (поддерживает Range) |
| GET | `/api/events/:id/thumb` | JPEG-превью |
| DELETE | `/api/events/:id` | удалить клип |
| GET | `/api/light` | состояние ленты CozyLife: `on`, `brightness` 0-100, `hue` 0-360, `saturation` 0-100, `temperature` 0-100 (или `configured:false`, `reachable:false`) |
| POST | `/api/light` | любые из `on`, `brightness`, `hue`, `saturation`, `temperature`; ответ - новое состояние |
| | `/api/vacuum/…` | пылесос: состояние, команды, настройки, уход, карта, комнаты, расписание, история; полный список в [`docs/vacuum.md`](../docs/vacuum.md#api) |
| | `/api/tv/…` | телевизор: сопряжение, клавиши, приложения, источники, запущенные приложения; полный список в [`docs/tv.md`](../docs/tv.md#api) |

Прокси пропускает только перечисленные эндпоинты go2rtc и всегда подставляет имя потока из `STREAM_NAME`.

## Проверка руками

```bash
T=<твой API_TOKEN>
curl -s localhost:3000/health
curl -s -H "Authorization: Bearer $T" localhost:3000/api/status
curl -s -X POST -H "Authorization: Bearer $T" -H 'content-type: application/json' \
     -d '{"direction":"left"}' localhost:3000/api/ptz
curl -s -H "Authorization: Bearer $T" localhost:3000/api/snapshot -o snap.jpg
```

## Важно

- Камера держит **одну** P2P-сессию. Перед PTZ бэкенд сам открывает на ~15 с «потребителя» потока, чтобы go2rtc был на связи.
- Снимок (`frame.jpeg`) go2rtc делает через **ffmpeg** — он должен быть в PATH (`brew install ffmpeg`).
- HTTPS здесь нет: только домашняя сеть. Наружу — только через VPN (например Tailscale) или reverse proxy с TLS.
- Не проверено на реальной камере: пути HLS (`/api/hls/*`) и WebRTC — тесты идут на имитации go2rtc.

## Запись по движению

Бэкенд сам запускает один ffmpeg, который читает RTSP go2rtc (`rtsp://127.0.0.1:8554/<STREAM_NAME>`):
пишет сегменты без перекодирования в кольцо `data/ring` и параллельно считает движение по мелким серым кадрам.
Когда движение заканчивается, сегменты склеиваются в `data/events/<id>.mp4` (с запасом до и после) и появляется превью.
Клипы старше `RETENTION_DAYS` (по умолчанию 7) удаляются сами.

- Нужен `ffmpeg` в PATH (`brew install ffmpeg`), go2rtc должен быть запущен.
- Пока рекордер подключён, камера занята им: **Xiaomi Home не покажет видео** (одна P2P-сессия). Отключить: `MOTION_ENABLED=false`.
- Чувствительность: `MOTION_THRESHOLD` (% кадра). Много ложных срабатываний - увеличь (2-3), пропускает движение - уменьши (0.5).
- После команд PTZ движение игнорируется на пару секунд: картинка двигается из-за самой камеры.
- Звук не пишется.

## Настройки (`.env`)

| Переменная | По умолчанию | Смысл |
|------------|--------------|-------|
| `PORT`, `HOST` | `3100`, `127.0.0.1` | где слушает бэкенд |
| `MOTION_THRESHOLD` | `1.2` | % кадра для движения |
| `MOTION_LIGHT_CHANGE` | `60` | % кадра, с которого смена света не считается движением |
| `MOTION_STALL_SEC` | `15` | через сколько секунд без кадров перезапускать ffmpeg |
| `RETENTION_DAYS`, `MAX_STORAGE_GB` | `7`, `20` | сколько хранить клипы |
| `DETECT_ENABLED`, `DETECT_MODEL`, `DETECT_MIN_SCORE` | `true`, `models/yolox_tiny.onnx`, `40` | распознавание объектов |
| `DETECT_DISCARD_EMPTY` | `true` | не сохранять клип, в котором ничего не распознано (`false`: сохранять) |
| `PUSH_MIN_INTERVAL_SEC`, `EXPO_ACCESS_TOKEN`, `EXPO_PUSH_URL` | `120`, пусто, Expo | push-уведомления |
| `AUTH_MAX_FAILURES`, `AUTH_WINDOW_SEC` | `10`, `60` | блокировка подбора токена |
| `SIGNED_URL_TTL_SEC` | `3600` | срок подписанных ссылок |
| `VACUUM_IP`, `VACUUM_TOKEN` | пусто | пылесос; без них блок скрыт. Остальные `VACUUM_*` в [`docs/vacuum.md`](../docs/vacuum.md#настройка) |
| `TV_IP` | пусто | телевизор (Google TV); без него страница `/tv` пишет, как настроить |
| `TV_ADB`, `TV_ADB_PATH` | пусто | меню источников, источники, приложения вроде Prisma и запущенные приложения через ADB ([`docs/tv.md`](../docs/tv.md#настройка)) |

## Лента CozyLife

Лента управляется напрямую по локальной сети, без облака: UDP-поиск на порту 6095 и JSON по TCP на порту 5555.
Включается переменной `LIGHT_IP` в `.env` (адрес ленты); без неё блок «Light strip» в вебе скрыт.

- Закрепи за лентой постоянный адрес в роутере (DHCP reservation), иначе IP может смениться.
- Бэкенд открывает короткое соединение на каждый запрос, чтобы оставался слот для приложения CozyLife.
- Найти ленту и посмотреть её состояние, ничего не меняя: `node ../tools/cozylife-probe.cjs`.
- Режим «музыка» и сцены пока не поддерживаются: в списке параметров ленты их нет, их, видимо, ведёт само приложение.

## Пылесос

Dreame L10 Plus по локальной сети (miIO), облако Xiaomi только для карты, позиции и истории. Подробно: [`docs/vacuum.md`](../docs/vacuum.md), решения: [ADR 0019](../docs/adr/0019-vacuum-page-and-safe-writes.md). Включается `VACUUM_IP` и `VACUUM_TOKEN`. Вход в Xiaomi для карты: `node_modules/.bin/tsx --env-file=.env ../tools/xiaomi-cloud.ts login`.

## Телевизор

TCL (Google TV) по локальной сети: свой клиент Android TV Remote v2 и ADB для меню источников. Подробно: [`docs/tv.md`](../docs/tv.md), решения: [ADR 0017](../docs/adr/0017-tv-remote-own-client.md), [ADR 0018](../docs/adr/0018-tv-source-choice-over-adb.md). Включается `TV_IP`; сопряжение один раз со страницы `/tv`; ADB (`TV_ADB`) необязателен, но без него нет меню источников. Нужен `openssl` для сертификата клиента.

После правок бэкенда его нужно перезапустить, иначе новые маршруты отвечают 404: `launchctl kickstart -k gui/$(id -u)/com.psytonik.xiaomi-camera` (при включённом автозапуске).

## Дальше

Пуш-уведомления и мобильное приложение (React Native / Expo).
