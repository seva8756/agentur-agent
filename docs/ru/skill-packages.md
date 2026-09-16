# Skills Guide

[English](../skill-packages.md) | **Русский**

Этот документ фиксирует актуальный контракт chat-local skills, чтобы не держать детали только в голове или в prompt descriptions.

## Идея

Навык — это локальный skill внутри конкретного Telegram-чата. Технически он хранится как папка с `skill.json`, `SKILL.md` и `plugin.js`, но в интерфейсе и ответах пользователю называем его просто навыком.

Для привилегированных интеграций вроде MCP используйте trusted skills из `skills/catalog/`. Подключение серверов и права доступа описаны в [руководстве по интеграциям](integrations.md#mcp).

Trusted skills исполняются native-кодом без QuickJS sandbox и включаются приложением, а не создаются агентом из чата. Первый такой skill: `skills/catalog/mcp`.

Структура:

```text
data/chats/<chat>/skills/custom/<skill_id>/
  skill.json
  SKILL.md
  plugin.js
  revisions/
    v1/
      snapshot.json
      SKILL.md
      plugin.js
```

`enabled` в `skill.json` — единственный флаг, определяющий, исполняет ли runtime skill. `revisions/v<version>/` содержит только одну сохранённую редакцию skill.

Новый skill создаётся выключенным. Чтобы включить его:

```text
/agentur skill enable <skill_id>
```

Enable делает validation/dry-run и меняет `enabled` на `true`.

## skill.json

Минимальный manifest:

```json
{
  "id": "shopping_list",
  "title": "Shopping List",
  "description": "Use when the user asks to add, remove, or view shopping-list items; do not use for unrelated tasks.",
  "enabled": false,
  "runtime": "quickjs",
  "source": "chat_generated",
  "version": 1,
  "triggers": [
    {
      "type": "command",
      "command": "/add_product",
      "tool": "add_item"
    }
  ],
  "tools": {
    "add_item": {
      "description": "Add item to shopping list",
      "schema": {
        "type": "object",
        "properties": {
          "item": { "type": "string" }
        }
      }
    },
    "list_items": {
      "description": "Show shopping list",
      "schema": {
        "type": "object",
        "properties": {}
      }
    }
  },
  "permissions": {
    "httpOrigins": [],
    "storage": true,
    "secrets": []
  },
  "createdAt": "2026-06-03T00:00:00.000Z"
}
```

Правила:

- `runtime` сейчас всегда `"quickjs"`;
- `tools` должен содержать хотя бы один tool;
- `triggers` по умолчанию должен быть `[]`: skill доступен агенту через semantic selection и не требует Telegram-команды;
- прямые triggers поддерживают только явные slash-команды, например `/balance`;
- command-trigger создается только когда пользователь явно попросил привязать slash-команду к конкретному tool;
- каждый trigger обязан ссылаться на существующий tool;
- natural-language активация идет через `description` и semantic selection, а не через phrase/keyword triggers;
- `httpOrigins` должны быть точными origins, например `https://openrouter.ai`;
- secrets нужно объявлять явно.

Примеры:

- хороший command trigger: пользователь явно попросил `/denis_tasks`, и команда всегда собирает конкретный отчет;
- хороший semantic-only skill: GitLab helper с `triggers: []` и точным `description`;
- плохой command trigger: `/gitlab`, если внутри skill сам угадывает, что пользователь хотел сделать.

## SKILL.md

`SKILL.md` описывает, когда и как использовать skill. Он попадает модели в context для enabled skills.

Пишите коротко:

```md
Используй `add_item`, когда пользователь просит добавить покупку.
Используй `list_items`, когда пользователь спрашивает текущий список покупок.
Не используй навык для задач, не связанных со списком покупок.
```

## plugin.js

Контракт:

```js
export default {
  tools: {
    async tool_name(ctx, args) {
      return { ok: true, reply: "Готово." };
    }
  }
};
```

SDK доступен только через `ctx.api`. Не используйте третий аргумент `api`.

Нормальный пример:

```js
export default {
  tools: {
    async add_item(ctx, args) {
      const item = String(args.item || ctx.item || "").trim();
      if (!item) return { ok: true, reply: "Что добавить?" };

      await ctx.api.lists.append("shopping", item);
      return { ok: true, reply: "Добавил: " + item };
    },

    async list_items(ctx, args) {
      const items = await ctx.api.lists.list("shopping");
      if (!items.length) return { ok: true, reply: "Список пуст." };
      return {
        ok: true,
        reply: items.map((item, index) => (index + 1) + ". " + item.text).join("\n")
      };
    }
  }
};
```

## ctx

`ctx` содержит сообщение и окружение:

```js
ctx.text          // полный текст сообщения
ctx.item          // текст после slash-command
ctx.now           // ISO timestamp
ctx.user.id
ctx.user.username
ctx.user.displayName
ctx.chat.id
ctx.chat.type
ctx.message.id
ctx.message.date
ctx.api           // SDK
```

`ctx.item` удобен для command-trigger:

- сообщение: `/todo купить молоко`;
- `ctx.item`: `купить молоко`.

Для semantic calls через `run_skill_tool` используйте `args`; `ctx.item` может быть пустым или равным аргументам команды только при прямом slash-trigger.

## args

`args` приходит из LLM tool call через `run_skill_tool`.

Если tool вызван прямым trigger без LLM, обычно `args` будет `{}`.

Паттерн:

```js
const value = args.value || ctx.item || ctx.text;
```

## SDK

### Storage

Scoped per skill, файл `skills/state/<skill_id>.json`.

```js
const value = ctx.api.storage.get("key");
ctx.api.storage.set("key", value);
ctx.api.storage.delete("key");
```

`storage` синхронный.

### Lists

Chat-level списки в `chat/lists/*.json`.

```js
const items = await ctx.api.lists.list("shopping");
await ctx.api.lists.append("shopping", "milk");
await ctx.api.lists.clear("shopping");
```

### Memory

```js
await ctx.api.memory.rememberFact("Пользователь любит короткие ответы.");
await ctx.api.memory.saveDecision("Решили проверять отчеты по пятницам.");
```

### Artifacts

Artifacts — chat-local файлы, которые можно создать из skill и отправить через общий `send` контракт. Skill не получает прямой filesystem access: он создает файл через SDK и дальше передает только `artifactId`.

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

Для бинарников:

```js
const image = await ctx.api.artifacts.createBase64({
  filename: "square.png",
  mimeType: "image/png",
  base64: "..."
});
```

`ctx.api.artifacts.get(artifactId)` читает metadata, `ctx.api.artifacts.readText(artifactId)` читает text-like artifacts с лимитом. Старый media payload с `url: "https://..."` остается валидным только для публичных http/https URL.

### Secrets

Только объявленные в `skill.json` secrets доступны skill.

```js
const token = ctx.api.secrets.get("OPENROUTER_API_KEY");
if (!token) return { ok: true, reply: "Нужен секрет OPENROUTER_API_KEY." };
```

`secrets` синхронные.

### HTTP

```js
const res = await ctx.api.http.get("https://example.com/api", {
  headers: { Authorization: "Bearer " + token }
});

const created = await ctx.api.http.post("https://example.com/items", {
  title: "Item"
});

const patched = await ctx.api.http.patch("https://example.com/items/1", {
  title: "Updated"
});

const removed = await ctx.api.http.delete("https://example.com/items/1");

const custom = await ctx.api.http.request({
  method: "PUT",
  url: "https://example.com/items/1",
  headers: { "content-type": "application/json" },
  body: { title: "Updated" }
});
```

HTTP response:

```js
res.ok
res.status
res.statusText
res.headers
res.text
res.body
res.json
res.url
```

HTTP проходит через safe layer:

- только `http/https`;
- origin должен быть в `skill.json.permissions.httpOrigins`;
- origin должен быть разрешен глобально в `SKILL_HTTP_ALLOWED_ORIGINS`;
- localhost/private IP запрещены по умолчанию; явные исключения настраиваются через `HTTP_ALLOWED_PRIVATE_HOSTS`, см. [настройку HTTP](integrations.md#http);
- redirects проверяются;
- есть timeout и лимиты request/response body.

### MCP

Обычные chat skills могут использовать только уже подключенные MCP servers этого чата:

```js
const servers = await ctx.api.mcp.listServers();
const tools = await ctx.api.mcp.listTools("my_gitlab");
const result = await ctx.api.mcp.callTool("my_gitlab", "list_merge_requests", {
  assignee: "me"
});
```

Доступные методы:

- `ctx.api.mcp.listServers()`;
- `ctx.api.mcp.listTools(serverId?)`;
- `ctx.api.mcp.callTool(serverId, toolName, args)`;
- `ctx.api.mcp.readResource(serverId, uri)`.

Нельзя подключать servers из `plugin.js`: нет `connect`, `spawn`, `setHeader`, `setSecret`. Подключение делается командами `/agentur mcp ...`, а исполнение всегда идет через trusted `McpManager`.

### Log

```js
ctx.api.log("step=loaded");
```

Logs попадают в `skills/audit/<skill_id>.jsonl`.

### Sleep

```js
await ctx.api.sleep(500);
```

Sleep ограничен, не используйте его для долгих процессов.

## Result Contract

Tool должен вернуть объект:

```js
return {
  ok: true,
  reply: "текст",
  data: { any: "json" },
  send: undefined,
  error: undefined
};
```

Поля:

- `ok?: boolean`;
- `reply?: string | null`;
- `data?: any`;
- `send?: media payload`;
- `error?: { code: string, message: string }`.

Примеры:

```js
return { ok: true, reply: "Готово." };
return { ok: true, reply: null };
return { ok: true, data: { count: 3 }, reply: "Нашел 3 элемента." };
return { ok: false, error: { code: "missing_secret", message: "OPENROUTER_API_KEY не задан" } };
```

`reply: null` значит: tool завершился успешно, но в чат отвечать нечего.

Media:

```js
return {
  ok: true,
  reply: "Документ готов.",
  send: {
    kind: "file",
    url: "https://cdn.example.com/report.pdf",
    caption: "Отчет",
    filename: "report.pdf"
  }
};
```

Поддерживаются `message`, `file`, `photo`, `video`. URL должен быть публичным `http/https`, не localhost/private IP. Для локально созданных файлов используйте `source: { type: "artifact", artifactId }`; не используйте `kind: "artifact"`.

## Forbidden

В `plugin.js` нельзя:

- `require`;
- `import`;
- `process`;
- `fs`;
- `child_process`;
- direct `fetch`;
- `XMLHttpRequest`;
- `WebSocket`;
- `Worker`;
- `eval`;
- `Function`;
- бесконечные циклы вида `while(true)` и `for(;;)`;
- Node.js APIs.

## HTTP Skill Example

```js
export default {
  tools: {
    async openrouter_balance(ctx, args) {
      const key = ctx.api.secrets.get("OPENROUTER_API_KEY");
      if (!key) return { ok: true, reply: "API-ключ OpenRouter не задан." };

      const res = await ctx.api.http.get("https://openrouter.ai/api/v1/key", {
        headers: { Authorization: "Bearer " + key }
      });

      if (!res.ok) {
        return { ok: false, error: { code: "http_error", message: "OpenRouter status " + res.status } };
      }

      const account = res.json && res.json.data ? res.json.data : {};
      const limit = account.limit !== undefined ? account.limit : "?";
      const usage = account.usage !== undefined ? account.usage : "?";

      return {
        ok: true,
        reply: "Баланс OpenRouter\nЛимит: " + limit + "\nПотрачено: " + usage,
        data: account
      };
    }
  }
};
```

Manifest permissions:

```json
{
  "permissions": {
    "httpOrigins": ["https://openrouter.ai"],
    "storage": true,
    "secrets": ["OPENROUTER_API_KEY"]
  }
}
```

Global `.env` must allow the origin:

```env
SKILL_HTTP_ALLOWED_ORIGINS=https://openrouter.ai
```

## Lifecycle

1. Agent creates or updates a skill via `create_skill_package`.
2. On update, the current `plugin.js`, `SKILL.md`, and runtime manifest fields are saved to `skills/custom/<id>/revisions/v<version>/`. The existing `enabled` flag is preserved: updates to an enabled skill take effect without enabling it again.
3. User sets required secrets.
4. For a new or disabled skill, the user runs `/agentur skill enable <id>`.
5. Enable validates and dry-runs the skill, then sets `enabled: true`.
6. Runtime executes the package when `enabled` is true.
7. If a recent update is broken, the agent can manually use `rollback_skill` to restore the one saved revision. The enabled flag, secrets, scoped state, and audit log are kept unchanged.

## Common Mistakes

- Using `api.http` instead of `ctx.api.http`.
- Using a third `api` argument: `async tool(ctx,args,api)`.
- Reading HTTP JSON from `res.data`; use `res.json`.
- Forgetting to declare `httpOrigins`.
- Forgetting to allow origin in `SKILL_HTTP_ALLOWED_ORIGINS`.
- Forgetting to declare secrets in `skill.json`.
- Updating a skill expecting more than one revision to be retained.
- Returning a string instead of `{ reply: "..." }`.
- Using `module.exports`; prefer `export default`.
- Creating command triggers for broad/agentic skills instead of using `triggers: []` and `description`.
- Returning raw JSON dumps or low-level integration errors as `reply`; prefer structured `data`/`error` and let the LLM compose semantic answers.
