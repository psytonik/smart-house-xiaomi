# Веб-приложение камеры

React 19 + Vite 7 + TypeScript. Показывает живое видео (WebRTC, HLS или кадры раз в секунду), джойстик PTZ, снимки и клипы по движению.
Работает с API бэкенда (`../backend`), токен вводится на экране входа и хранится в `localStorage`.

## Команды

```bash
npm install
npm run dev        # http://localhost:5173, запросы /api проксируются на бэкенд :3100
npm test           # Vitest + Testing Library (jsdom)
npm run typecheck
npm run build      # собирает в ../backend/public, бэкенд отдаёт сборку на /
```

## Устройство

| Файл | Что делает |
|------|------------|
| `src/App.tsx` | экран мониторинга: статус, режимы видео, клавиши (стрелки двигают камеру, `C` делает снимок) |
| `src/api.ts` | запросы к бэкенду с заголовком `Authorization`; типы ответов |
| `src/components/Player.tsx` | WebRTC, HLS и Frames; автопереподключение ([ADR 0004](../docs/adr/0004-ptz-queue-and-auto-reconnect.md)) |
| `src/reconnect.ts` | паузы между автоматическими переподключениями |
| `src/components/JogDial.tsx` | джойстик: удержание повторяет поворот, при уходе экрана повтор снимается |
| `src/components/SystemPanel.tsx` | раздел «System»: состояние go2rtc, картинки, диска и пушей, обновляется раз в 10 секунд ([ADR 0009](../docs/adr/0009-system-panel.md)) |
| `src/components/PrivacyOverlay.tsx` | чёрные блоки приватных зон поверх живого видео и превью ([ADR 0011](../docs/adr/0011-privacy-zones.md)) |
| `src/components/ZoneEditor.tsx`, `src/zones.ts` | окно «Motion zones»: рисование зон движения на картинке с камеры и живая шкала уровня ([ADR 0008](../docs/adr/0008-motion-zones.md)) |
| `src/components/Clips.tsx`, `src/episodes.ts` | клипы, сгруппированные в эпизоды, фильтры по дню и по найденным объектам, плеер с листанием ([ADR 0010](../docs/adr/0010-episodes-and-day-filter.md), [ADR 0012](../docs/adr/0012-object-detection.md)) |
| `src/components/VacuumPage.tsx`, `vacuumText.ts` | страница `/vacuum`: робот, настройки, карта, уход, станция, комнаты, расписание ([`docs/vacuum.md`](../docs/vacuum.md)) |
| `src/components/TvPage.tsx`, `tvText.ts` | страница `/tv`: пульт, источники, приложения, запущенные приложения, сопряжение ([`docs/tv.md`](../docs/tv.md)) |
| `src/components/Voice.tsx`, `src/assistant.ts` | микрофон на каждой странице: распознавание речи, ответ помощника, озвучка (Piper или голос браузера), выбор голоса, «Remember this phrase» ([`docs/assistant.md`](../docs/assistant.md)) |
| `src/route.ts`, `src/components/Nav.tsx`, `Shell.tsx` | адреса страниц (`/`, `/vacuum`, `/lights`, `/tv`) и общая рамка с навигацией |
| `src/components/Gallery.tsx` | снимки; файлы открываются по подписанным ссылкам ([ADR 0001](../docs/adr/0001-signed-media-urls.md)) |

## Важно

- Бэкенд отдаёт строгую CSP без `unsafe-inline` ([ADR 0002](../docs/adr/0002-auth-lockout-and-security-headers.md)):
  не добавляйте в `index.html` и компоненты инлайновые скрипты и `<style>`. Тест в `backend/test/security.test.ts` проверяет собранный `index.html`.
- Код ссылок на клипы и снимки приходит из API и протухает: список снимков обновляется раз в 5 минут, клипов раз в 10 секунд.
