# Chat Agent "Агентур'a"

Chat-first Telegram agent для множества чатов. Бот может работать во всех чатах, куда его добавили, хранит память раздельно по каждому chat ID и позволяет каждому чату иметь свои настройки, identity, secrets, skills и cron jobs.

## Что Умеет

- multi-chat режим по умолчанию: данные каждого чата лежат в `data/chats/<encoded-chat-id>/`;
- single-chat режим через `TELEGRAM_ALLOWED_CHAT_ID`;
- ответы на mention, reply на сообщение бота, `/agentur`, прямое обращение, сработавший skill или cron;
- OpenAI/OpenRouter/любой OpenAI-compatible endpoint через `LLM_BASE_URL`;
- LLM tool loop с несколькими последовательными tool calls за один ответ;
- chat-local skills с `SKILL.md`, `skill.json`, `plugin.js`;
- выполнение generated skills в QuickJS sandbox;
- safe HTTP layer для skills и agent tools;
- chat-local secrets для API keys;
- cron jobs, которые могут отправлять текст, спрашивать агента или запускать skill tool;
- facts, decisions, mood diary, identity, reply mode и compact interaction summaries.

## Ограничения

- long polling, webhooks не используются;
- память файловая, без БД и vector search;
- generated code исполняется только в QuickJS sandbox, без Node.js APIs, `fetch`, `require`, `import`, `eval`, `Function`, shell и произвольного filesystem access;
- tool calling зависит от LLM-провайдера. При проблемах с function calling бот может деградировать до обычного ответа без tools.

## Установка

```bash
npm install
cp .env.example .env
```

Минимально заполните `.env`:

```env
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_CHAT_ID=
TELEGRAM_BOT_USERNAME=
LLM_API_KEY=...
LLM_MODEL=...
```

`TELEGRAM_ALLOWED_CHAT_ID` можно оставить пустым: бот будет работать во всех чатах, но память и настройки останутся изолированными по чатам.

## LLM Providers

OpenAI:

```env
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=sk-...
LLM_MODEL=gpt-4.1-mini
LLM_SUPPORTS_TOOLS=true
```

OpenRouter:

```env
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_API_KEY=sk-or-...
LLM_MODEL=openai/gpt-4.1-mini
LLM_SUPPORTS_TOOLS=true
```

OpenAI-compatible endpoint:

```env
LLM_BASE_URL=https://your-endpoint.example/v1
LLM_API_KEY=...
LLM_MODEL=your-model
LLM_SUPPORTS_TOOLS=false
```

Важные LLM-настройки:

```env
LLM_TIMEOUT_MS=45000
LLM_MAX_RETRIES=1
LLM_TOOL_LOOP_RETRIES=1
AGENT_MAX_TOOL_STEPS=6
CONTEXT_WINDOW_TOKENS=32000
CONTEXT_BUDGET_TOKENS=12000
REPLY_MAX_TOKENS=900
TELEGRAM_SEND_MAX_ITEMS=10
AGENT_DEFAULT_LOCALE=ru
```

`CONTEXT_WINDOW_TOKENS` — жёсткое окно выбранной модели. `CONTEXT_BUDGET_TOKENS` — обычный рабочий бюджет текстового prompt; длинный user input может вытеснять память и использовать свободную часть окна. `REPLY_MAX_TOKENS` резервируется под ответ и передаётся провайдеру как `max_tokens`. Лимиты Telegram, HTTP, MCP и хранения истории остаются отдельными byte/size ограничениями.

`AGENT_DEFAULT_LOCALE` задаёт язык новых чатов: `ru` (по умолчанию) или `en`. В конкретном чате его можно изменить командой `/agentur language ru` или `/agentur language en`.

## Telegram Setup

1. Создайте бота через BotFather: `/newbot`.
2. Скопируйте токен в `TELEGRAM_BOT_TOKEN`.
3. Для групп отключите privacy mode через BotFather: `/setprivacy` -> `Disable`, иначе бот не увидит обычные сообщения.
4. Добавьте бота в чат.
5. При необходимости укажите `TELEGRAM_ALLOWED_CHAT_ID`.

## Запуск

Локально:

```bash
npm run build
npm test
npm start
```

Разработка:

```bash
npm run dev
```

Docker:

```bash
docker compose up --build
```

Данные монтируются через `./data:/app/data`.

## Команды

```text
/agentur help
/agentur status
/agentur doctor

/agentur reply-mode
/agentur reply-mode called
/agentur reply-mode smart

/agentur censor-mode
/agentur censor-mode on
/agentur censor-mode off

/agentur identity
/agentur identity set <описание>
/agentur identity reset

/agentur mood
/agentur mood reset
/agentur facts
/agentur decisions

/agentur secrets
/agentur secret set KEY VALUE
/agentur secret delete KEY

/agentur skills
/agentur skill enable <name>
/agentur skill disable <name>
/agentur skill delete <name>

/agentur cron list
/agentur cron enable <name>
/agentur cron disable <name>
/agentur cron delete <name>
```

`/agentur doctor` проверяет конфиг, доступность `data/`, Telegram, LLM и tool calling capability. Секреты не выводятся.

## Структура Данных

Все данные чата хранятся в:

```text
data/chats/<encoded-chat-id>/
```

Основные файлы:

- `chat/recent.jsonl` — короткий буфер свежих сообщений;
- `chat/summary.md` — накопленная сводка;
- `chat/interaction-summaries.jsonl` — compact summaries interaction-буфера;
- `chat/mood.json`, `chat/mood-history.jsonl` — настроение чата;
- `chat/facts.json` — факты;
- `chat/decisions.json` — решения;
- `chat/settings.json` — reply/censor mode;
- `chat/identity.md` — стабильная identity агента в этом чате;
- `chat/secrets.json` — chat-local secrets;
- `chat/lists/*.json` — списки, которыми пользуются skills;
- `skills/custom/<id>/` — chat-generated skill package и его сохранённая ревизия;
- `skills/state/<id>.json` — scoped storage конкретного skill;
- `skills/audit/<id>.jsonl` — audit log запусков skill;
- `cron/jobs.json` — cron drafts и enabled jobs.

## Skills

Skill теперь является chat-local package:

```text
skills/custom/<id>/
  skill.json
  SKILL.md
  plugin.js
  revisions/
    v1/
      snapshot.json
      SKILL.md
      plugin.js
```

`skill.json.enabled` определяет, исполняется ли skill. `revisions/v<version>/` содержит ровно одну сохранённую редакцию и перезаписывается при следующем обновлении.

Новый skill создаётся выключенным. Чтобы включить его:

```text
/agentur skill enable <id>
```

Enable делает validation/dry-run. При обновлении skill агент сохраняет предыдущие `plugin.js`, `SKILL.md` и runtime-поля manifest; при критичной ошибке он может вручную откатить skill к этому снимку. Перезапуск бота для изменения `data/` не нужен, но изменения в `src/` требуют rebuild контейнера.

Подробный гайд: [docs/skill-packages.md](docs/skill-packages.md).

## Skill Runtime

`plugin.js` исполняется в QuickJS sandbox. Контракт:

```js
export default {
  tools: {
    async add_item(ctx, args) {
      const item = args.item || ctx.item;
      await ctx.api.lists.append("shopping", item);
      return { ok: true, reply: `Добавил: ${item}` };
    }
  }
};
```

SDK доступен только через `ctx.api`:

- `ctx.api.storage.get/set/delete`;
- `ctx.api.lists.list/append/clear`;
- `ctx.api.memory.rememberFact/saveDecision`;
- `ctx.api.http.request/get/post/put/patch/delete`;
- `ctx.api.artifacts.createText/createBase64/get/readText`;
- `ctx.api.secrets.get`;
- `ctx.api.log`;
- `ctx.api.sleep`.

Результат tool:

```js
return {
  ok: true,
  reply: "text or null",
  data: { optional: "machine-readable" },
  send: { optional: "media payload" },
  error: { code: "optional", message: "optional" }
};
```

`reply: null` означает: tool успешно завершился, но отвечать нечего.

### Artifacts

Skills и agent tools могут создавать chat-local файлы без публичной ссылки. Файл сохраняется в `artifacts/<artifact_id>/`, а наружу передается только `artifactId`.

```js
const artifact = await ctx.api.artifacts.createText({
  filename: "index.html",
  mimeType: "text/html",
  text: "<h1>Hello</h1>"
});

return {
  ok: true,
  send: {
    kind: "file",
    source: { type: "artifact", artifactId: artifact.id },
    caption: "HTML готов"
  }
};
```

Для бинарных файлов используйте `createBase64({ filename, mimeType, base64 })`. Старый формат `send: { kind, url }` продолжает работать для публичных http/https URL. Для обычных файлов используйте `kind: "file"`.

## Safe HTTP

HTTP из skills и agent-facing `execute_http_query` идет через общий `safeHttpRequest`.

Ограничения:

- только `http` и `https`;
- direct `fetch` в `plugin.js` запрещен;
- origin должен быть объявлен в `skill.json`;
- origin должен быть разрешен глобально в `SKILL_HTTP_ALLOWED_ORIGINS`;
- localhost/private IP блокируются;
- хосты из `HTTP_BLOCKED_HOSTS` блокируются;
- private/localhost хосты из `HTTP_ALLOWED_PRIVATE_HOSTS` явно разрешаются;
- redirects проверяются на каждом шаге;
- есть timeout, request body limit и response body limit.

Настройки:

```env
SKILL_HTTP_ALLOWED_ORIGINS=
HTTP_BLOCKED_HOSTS=
HTTP_ALLOWED_PRIVATE_HOSTS=
SKILL_HTTP_TIMEOUT_MS=10000
SKILL_HTTP_MAX_REQUEST_BYTES=131072
SKILL_HTTP_MAX_RESPONSE_BYTES=1048576
```

`SKILL_HTTP_ALLOWED_ORIGINS=*` разрешает любые публичные origins, но проверки localhost/private IP и лимитов остаются.

`HTTP_BLOCKED_HOSTS` — дополнительный список запрещенных хостов через запятую, например `HTTP_BLOCKED_HOSTS=api.example.com,staging.example.com`. Сопоставление идет по имени хоста без порта и без учета регистра.

`HTTP_ALLOWED_PRIVATE_HOSTS` позволяет обратиться к точно указанному private/localhost хосту, например `HTTP_ALLOWED_PRIVATE_HOSTS=localhost,api.internal`. Используйте только для доверенной инфраструктуры; `HTTP_BLOCKED_HOSTS` имеет приоритет.

## Trusted MCP Skill And Chat MCP Servers

Привилегированные интеграции живут как trusted/system skills в `skills/catalog/`. Они похожи на обычные skills по manifest и `SKILL.md`, но исполняются native-кодом без QuickJS sandbox.

Первый catalog skill: `skills/catalog/mcp`.

Он добавляет direct tools в LLM loop:

- `mcp_list_servers`;
- `mcp_list_tools`;
- `mcp_call_tool`;
- `mcp_read_resource`.

Включение:

```env
MCP_ENABLED=true
MCP_TIMEOUT_MS=20000
MCP_MAX_RESPONSE_BYTES=262144
```

Каждый чат может подключать свои remote MCP servers:

```text
/agentur mcp add-remote my_gitlab https://my-gitlab-mcp.example.com/mcp
/agentur secret set GITLAB_MCP_TOKEN ...
/agentur mcp set-token my_gitlab GITLAB_MCP_TOKEN
/agentur mcp tools my_gitlab
/agentur mcp allow-tool my_gitlab list_merge_requests
```

Chat config хранится в `data/chats/<chat>/integrations/mcp/servers.json`, secrets остаются в `chat/secrets.json`. MCP servers подключаются только как remote `streamable_http`; `localhost`, private IP и запуск локальных процессов не поддерживаются.

Chat-generated skills могут использовать уже подключенные MCP servers:

```js
const result = await ctx.api.mcp.callTool("my_gitlab", "list_merge_requests", {});
```

Подробности: `docs/trusted-mcp-skill-example.md`.

## Secrets

Secrets scoped per chat и лежат в `chat/secrets.json`.

Команды:

```text
/agentur secrets
/agentur secret set OPENROUTER_API_KEY sk-or-...
/agentur secret delete OPENROUTER_API_KEY
```

Skill должен объявить нужные секреты в `skill.json`:

```json
{
  "permissions": {
    "secrets": ["OPENROUTER_API_KEY"]
  }
}
```

В `plugin.js` доступ есть только к объявленным secrets:

```js
const key = ctx.api.secrets.get("OPENROUTER_API_KEY");
```

## Cron

Cron jobs создаются как disabled drafts в `cron/jobs.json`, затем включаются командой:

```text
/agentur cron enable <id>
```

Поддерживаемые actions:

- `send_static_message`;
- `ask_agent_and_send`;
- `run_skill_tool`.

Пример `run_skill_tool`:

```json
{
  "type": "run_skill_tool",
  "skillId": "daily_report",
  "toolName": "build",
  "args": {},
  "text": "cron daily report",
  "sendResult": true
}
```

Cron запускает enabled skill tool напрямую в том же чате. Triggers при этом не проверяются.

## Reply Mode И Контекст

`called` — режим по умолчанию. Бот отвечает только на явное обращение, reply, команду, skill trigger или cron.

`smart` — бот мониторит чат, сохраняет короткий буфер и через compact LLM-classifier решает, стоит ли вмешаться.

```text
/agentur reply-mode called
/agentur reply-mode smart
```

По умолчанию фоновая переписка не пишется полностью в `recent.jsonl`. Для полного capture:

```env
TELEGRAM_FULL_CAPTURE_CHAT_IDS=-1001234567890,-1009876543210
```

Для всех чатов:

```env
TELEGRAM_FULL_CAPTURE_CHAT_IDS=*
```

Для чатов без full capture `recent.jsonl` является interaction-buffer. После `INTERACTION_SUMMARY_EVERY_MESSAGES` сообщений бот обновляет mood, пишет summary и очищает буфер.

## Identity, Mood, Facts, Decisions

Identity — стабильный характер и правила поведения агента в конкретном чате:

```text
/agentur identity
/agentur identity set <описание>
/agentur identity reset
```

Также можно отправить `.txt` или `.md` файл с caption:

```text
/agentur identity set
```

Mood — динамическая оценка атмосферы чата. Facts и decisions — долговременная память, которую агент может пополнять через tools.

## Локальное Время

Агент получает локальное время по:

```env
AGENT_TIMEZONE=Europe/Moscow
```

Timezone валидируется как IANA timezone при старте.

## License

Создатель проекта: Всеволод Беликов [(@seva8756)](https://github.com/seva8756)
