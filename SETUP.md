# claude-auto — автоматический re-login для Claude Code

Обёртка над `claude` CLI. Когда авторизация слетает (401) — автоматически проходит OAuth заново через сохранённую Google-сессию. Без участия человека.

---

## Что нужно

- Node.js >= 18 на сервере
- `claude` CLI установлен на сервере и работает
- Claude подписка

---

## Установка на сервер

```bash
# Склонировать/скопировать проект на сервер
git clone <repo-url> claude-auto
cd claude-auto

# Установить зависимости (скачает Chromium ~400MB)
npm install

# Только для Linux-серверов: установить системные зависимости для Chromium
npx playwright install-deps chromium

# Собрать
npm run build

# Сделать доступным глобально
npm link
```

После этого команда `claude-auto` будет доступна из любой папки.

---

## Настройка Google-сессии (один раз)

Это нужно сделать **на компьютере где есть браузер** (твой Mac/ноут). Не на сервере.

### Вариант А: на Mac/ноуте

```bash
cd claude-auto
node dist/index.js setup
```

Откроется браузер Chromium → залогинься в Google-аккаунт который используешь для Claude → когда в терминале появится "Google session saved" — закрой браузер.

Файл сессии сохранится в `~/.claude-auto/google-state.json`.

Скопируй его на сервер:

**Mac / Linux:**
```bash
scp ~/.claude-auto/google-state.json root@твой-сервер:~/.claude-auto/google-state.json
```

**Windows (PowerShell):**
```powershell
scp $env:USERPROFILE\.claude-auto\google-state.json root@твой-сервер:~/.claude-auto/google-state.json
```

> На Windows 10+ `scp` есть из коробки. Если нет — просто скопируй файл любым способом (FileZilla, WinSCP, etc). Файл лежит в `C:\Users\ТвоёИмя\.claude-auto\google-state.json`.

### Вариант Б: прямо на сервере (если есть VNC/X11)

```bash
claude-auto setup
```

Откроется браузер → залогинься → закрой. Всё.

---

## Использование

### Вместо `claude -p` используй `claude-auto -p`

Работает для скриптового режима (`-p` / `--print`):

```bash
# Было:
claude -p 'explain this code'

# Стало:
claude-auto -p 'explain this code'
```

Если auth живой — работает как обычный `claude`. Если 401 — автоматически re-auth и повтор.

### В скриптах

Просто замени `claude -p` на `claude-auto -p`:

```bash
#!/bin/bash
RESULT=$(claude-auto -p "Review this PR: $(git diff main)")
echo "$RESULT"
```

> **Примечание:** `claude-auto` предназначен для скриптового режима (`claude -p`). Для интерактивной работы (`claude` без `-p`) используй обычный `claude` — если auth слетит, просто набери `/login`.

### Принудительный refresh

Если хочешь обновить токен прямо сейчас:

```bash
claude-auto refresh
```

### Проверить статус

```bash
claude-auto status
```

Покажет:
```
Token: Token expires at 2026-05-04T19:31:17.904Z (7h 59m remaining)
Status: ACTIVE
Scopes: user:file_upload, user:profile
Google state: present
```

---

## Автоматический refresh (рекомендуется)

Чтобы вообще не доводить до 401 — настрой автообновление токена раз в неделю.

**Linux / Mac (cron):**
```bash
crontab -e
```
Добавь строку:
```
0 3 */7 * * /usr/local/bin/claude-auto refresh >> /var/log/claude-auto.log 2>&1
```

**Windows (Task Scheduler):**
```powershell
schtasks /create /tn "claude-auto-refresh" /tr "claude-auto refresh" /sc weekly /d MON /st 03:00
```

Это будет рефрешить токен каждую неделю. Auth не слетит вообще.

---

## Что делать если...

| Проблема | Решение |
|----------|---------|
| "Google session state not found" | Запусти `claude-auto setup` или скопируй `google-state.json` на сервер |
| "OAuth flow timed out" | Google-сессия протухла. Запусти `claude-auto setup` заново |
| "no active Max/Pro subscription" | На этом Google-аккаунте нет активной подписки Max/Pro. Claude Code-токен выдать нельзя — проверь подписку или сделай `setup` правильным аккаунтом |
| "Token exchange failed" | Проверь что подписка (Pro/Max) активна |
| Браузер не открывается / падает на сервере | Re-auth теперь **headful** (см. ниже). На headless-сервере нужен `xvfb` |
| Google просит 2FA | IP сервера сильно отличается от того где делал setup. Сделай setup прямо на сервере через VNC |

---

## ⚠️ Re-auth открывает реальный браузер (headful)

claude.ai теперь защищён Cloudflare, который **блокирует headless-браузер**. Поэтому полный re-auth (когда `refresh_token` мёртв) запускает **видимый** Chromium. На десктопе просто откроется окно. На **headless-сервере** нужен виртуальный дисплей:

```bash
# Debian/Ubuntu
sudo apt-get install -y xvfb
# Запускать refresh/claude-auto под виртуальным дисплеем:
xvfb-run -a claude-auto refresh
xvfb-run -a claude-auto -p "..."
```

Аккаунт обязан иметь **активную подписку Max/Pro** — иначе claude.ai не даёт авторизовать Claude Code (в логе будет "no active Max/Pro subscription").

> Лучшая профилактика — недельный cron `claude-auto refresh` (раздел выше): пока `refresh_token` жив, браузер вообще не запускается (чистый HTTP-refresh, без Cloudflare и дисплея).

---

## Как это работает (коротко)

1. `claude-auto` запускает `claude` с твоими аргументами
2. Если `claude` вернул 401 — сначала пробуется HTTP-refresh по `refresh_token` (без браузера)
3. Если refresh не помог — запускается **headful**-браузер с сохранённой Google-сессией
4. Браузер проходит OAuth на claude.ai: Cloudflare → `Continue with Google` → попап Google (выбор аккаунта) → `Authorize` → получает код
5. Код обменивается на свежие токены → записывает в `~/.claude/.credentials.json`
6. Повторяет исходную команду `claude`
