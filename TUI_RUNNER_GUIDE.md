# Инструкция: замена `claude -p` через интерактивный Claude Code

С 15 июня 2026 `claude -p`, Agent SDK и GitHub Actions уходят из подписочного пула в отдельный Agent SDK Credit pool. Чтобы не использовать `claude -p`, в `claude-auto` добавлен режим `tui-p`: он запускает обычный интерактивный Claude Code в псевдо-терминале, печатает prompt как пользователь и забирает финальный ответ через `Stop` hook.

Важно: мы не парсим TTY-вывод. Ответ берётся из hook payload поля `last_assistant_message`.

## Что уже проверено

```bash
npm test
```

Ожидаемо: `20/20` pass.

Реальные smoke-тесты уже проходили:

```bash
node dist/index.js tui-p "Reply with exactly PING." --timeout 60000 --skip-auth
# stdout: PING
```

Сабагентный кейс:

```bash
node dist/index.js tui-p \
  "Spawn an Explore subagent/task to answer: what is 2+2? Wait for it to finish. Then reply exactly MAIN SAW 4." \
  --skip-auth \
  --timeout 120000
# stdout: MAIN SAW 4
```

Library API с двумя параллельными сабагентами тоже проверен: main дождался обоих, `result.subagents[]` содержал оба результата.

## Установка

```bash
npm install
npm run build
npm link
```

Поставить hook relay:

```bash
claude-auto install-hooks
```

Проверить:

```bash
test -x ~/.claude-auto/hook-relay.sh && echo OK
jq '.hooks | keys' ~/.claude/settings.json
```

Ожидаемые ключи:

```json
[
  "Stop",
  "StopFailure",
  "SubagentStop"
]
```

Hook relay безопасен для обычных сессий: без env `CLAUDE_AUTO_RUN_SOCKET` он сразу делает `exit 0`.

## Использование

Вместо:

```bash
claude -p "your prompt"
```

использовать:

```bash
claude-auto tui-p "your prompt" --skip-auth
```

или без глобального link:

```bash
node dist/index.js tui-p "your prompt" --skip-auth
```

`--skip-auth` сейчас нужен практически: он пропускает старый headless OAuth preflight `claude-auto` и даёт интерактивному `claude` использовать текущую подписочную OAuth-сессию. Именно это нам и нужно для обхода `claude -p`.

## Почему не ломается из-за user settings

У пользователя может быть в `~/.claude/settings.json` API-конфиг вроде `ANTHROPIC_BASE_URL` и `ANTHROPIC_AUTH_TOKEN`. Тогда обычный Claude идёт не в подписку, а в API/proxy.

`tui-p` по умолчанию запускает Claude так:

```bash
claude --setting-sources project,local --settings <temp-settings>
```

Временный settings-файл содержит только наши hooks. User-level env не подтягивается, поэтому Claude стартует как обычный Claude Pro/Max session.

Если нужно явно вернуть user settings:

```bash
claude-auto tui-p "prompt" --setting-sources user,project,local --skip-auth
```

## Сабагенты

Сабагенты поддержаны.

Логика:

- `SubagentStop` сохраняется в `result.subagents[]`.
- `Stop` с `agent_id` игнорируется.
- Завершением считается только главный `Stop` без `agent_id`.

Пример через библиотеку:

```ts
import { runInteractive } from "claude-auto";

const result = await runInteractive({
  prompt:
    "Spawn TWO Explore subagents/tasks in parallel. First answers: what is 2+2? Second answers: what is 3+3? Wait for both to finish. Then reply exactly MAIN 4 6.",
  skipAuth: true,
  timeoutMs: 180000,
});

console.log(result.text);
console.log(result.subagents);
```

Ожидаемо:

```json
{
  "text": "MAIN 4 6",
  "subagents": [
    { "type": "Explore", "message": "4" },
    { "type": "Explore", "message": "6" }
  ]
}
```

## Важные caveats

Не использовать `--skip-permissions` в smoke-тестах на свежей машине. Claude Code сначала показывает интерактивный warning:

```text
Bypass Permissions mode
1. No, exit
2. Yes, I accept
```

Автоматизация пока не отвечает на этот экран, поэтому запуск зависнет до timeout. Если bypass уже принят ранее, можно использовать.

`node-pty` может поставить `spawn-helper` без executable bit. Runner теперь чинит это сам перед spawn.

Для длинных prompt'ов runner ждёт перед Enter, иначе Claude Code иногда принимает `/exit` как часть prompt при timeout.

## Диагностика

Показать TTY-рендер:

```bash
claude-auto tui-p "Reply with PING." --skip-auth --debug-tty --timeout 60000
```

Чистый stdout:

```bash
claude-auto tui-p "Reply with PING." --skip-auth --timeout 60000
```

Если нужно проверить hook relay отдельно:

```bash
SOCK=/tmp/claude-auto-test.sock
rm -f "$SOCK"
nc -lU "$SOCK" | jq .
```

В другом терминале:

```bash
echo '{"hook_event_name":"Stop","session_id":"abc","transcript_path":"/tmp/x.jsonl","last_assistant_message":"hi"}' \
  | CLAUDE_AUTO_RUN_SOCKET="$SOCK" ~/.claude-auto/hook-relay.sh
```

## Что осталось отдельно

Headless OAuth flow старого `claude-auto authenticate()` сейчас может зацикливаться на Anthropic consent page. Это отдельная задача. Для режима `tui-p` основной рабочий путь — `--skip-auth`, потому что интерактивный Claude Code сам использует текущую подписочную OAuth-сессию.

## Миграция в Алису

Заменять вызовы:

```bash
claude -p "$PROMPT"
```

на:

```bash
claude-auto tui-p "$PROMPT" --skip-auth
```

Флаги модели можно пробрасывать так же:

```bash
claude-auto tui-p "$PROMPT" --skip-auth --model sonnet
```

Если нужны MCP/tools/system prompt:

```bash
claude-auto tui-p "$PROMPT" \
  --skip-auth \
  --mcp-config /path/to/mcp-config.json \
  --append-system-prompt "$SYSTEM_PROMPT"
```
