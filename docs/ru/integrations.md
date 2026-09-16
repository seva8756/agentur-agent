# HTTP, секреты и MCP

[English](../integrations.md) | **Русский**

[← README](../../README.ru.md)

Интеграции настраиваются на двух уровнях: владелец приложения задаёт общие возможности через `.env`, а настройки серверов и секреты хранятся отдельно для каждого чата.

## HTTP

Для HTTP-запросов навыков и встроенного инструмента агента `execute_http_query` используется общий сетевой слой. В `.env` укажите разрешённые origins — схему, хост и, при необходимости, порт, без пути:

```dotenv
SKILL_HTTP_ALLOWED_ORIGINS=https://api.example.com,https://another.example.com
SKILL_HTTP_TIMEOUT_MS=10000
SKILL_HTTP_MAX_REQUEST_BYTES=131072
SKILL_HTTP_MAX_RESPONSE_BYTES=1048576
HTTP_BLOCKED_HOSTS=
HTTP_ALLOWED_PRIVATE_HOSTS=
```

Адреса в примере нужно заменить адресами ваших API. При пустом `SKILL_HTTP_ALLOWED_ORIGINS` эти HTTP-запросы отключены. Значение `*` разрешает любые публичные origins с сохранением остальных проверок.

Дополнительно навык должен объявить нужные origins в `skill.json`:

```json
{
  "permissions": {
    "httpOrigins": ["https://api.example.com"],
    "storage": true,
    "secrets": ["SERVICE_TOKEN"]
  }
}
```

Это фрагмент manifest, а не полный файл. [Полный контракт навыка](skill-packages.md).

В `plugin.js` запросы выполняются через `ctx.api.http`, например:

```js
const token = ctx.api.secrets.get("SERVICE_TOKEN");
const response = await ctx.api.http.get("https://api.example.com/items", {
  headers: { Authorization: "Bearer " + token }
});
```

Ограничения сетевого слоя:

- протоколы `http` и `https`;
- проверка разрешённых origins, адресов назначения и перенаправлений;
- блокировка localhost и private IP по умолчанию;
- таймаут и лимиты размера запроса и ответа.

`HTTP_BLOCKED_HOSTS` задаёт дополнительный запрет по имени хоста, без порта. `HTTP_ALLOWED_PRIVATE_HOSTS` позволяет явно разрешить конкретный внутренний хост; он всё равно должен проходить проверку origins. Запрет в `HTTP_BLOCKED_HOSTS` имеет приоритет. Эти настройки относятся к HTTP-слою навыков и агента, а не к подключениям LLM, Telegram или MCP.

Прямой `fetch` в коде навыка недоступен. Полный HTTP SDK описан в [руководстве по навыкам](skill-packages.md#http).

## Секреты

Ключи интеграций конкретного чата хранятся в `chat/secrets.json` внутри его каталога данных. Это обычный JSON без шифрования. Ключ LLM и Telegram-токен приложения задаются отдельно в `.env`.

```text
/agentur secrets
/agentur secret set SERVICE_TOKEN <значение>
/agentur secret delete SERVICE_TOKEN
```

`/agentur secrets` показывает имена ключей и наличие значений, но не сами значения. Навык получает доступ через `ctx.api.secrets.get()` только к ключам, перечисленным в `permissions.secrets` его manifest.

**Текущее поведение:** команда установки секрета сохраняется в буфере сообщений до обработки команды и может попасть в последующий контекст LLM. В группе бот пытается удалить исходное сообщение из Telegram, если у него есть соответствующее право; локальная история при этом не очищается. Удаление ключа командой `secret delete` также не удаляет его из ранее сохранённых сообщений, сводок или резервных копий.

Чтобы не передавать ключ командой через чат, владелец сервера может остановить приложение и добавить строковое значение непосредственно в `chat/secrets.json` нужного чата, сохранив остальные ключи. Файл имеет вид:

```json
{
  "SERVICE_TOKEN": "значение-ключа"
}
```

После изменения запустите приложение. Ключ, заданный в личном чате с ботом, не переносится в группу: у этих чатов разные хранилища.

## MCP

MCP (Model Context Protocol) позволяет подключать инструменты и ресурсы внешних сервисов. В проекте эту возможность предоставляет доверенный навык [`skills/catalog/mcp`](../../skills/catalog/mcp/SKILL.md), работающий в процессе Node.js.

### Включение

В `.env`:

```dotenv
MCP_ENABLED=true
MCP_TIMEOUT_MS=20000
MCP_MAX_RESPONSE_BYTES=262144
```

После изменения выполните `docker compose up -d`. Поддерживаются удалённые серверы с транспортом `streamable_http`. Конфигурация рассчитана на публичные HTTP(S)-адреса; проверка URL отклоняет localhost и ряд частных адресов. Локальные процессы и stdio не поддерживаются.

### Подключение сервера

В нужном чате выполните команды, заменив адрес и имена на значения своего сервера:

```text
/agentur mcp add-remote my_service https://mcp.example.com/mcp
/agentur mcp servers
```

Если требуется авторизация, сохраните ключ `SERVICE_MCP_TOKEN` в хранилище секретов этого чата, как описано [выше](#секреты), и привяжите его:

```text
/agentur mcp set-token my_service SERVICE_MCP_TOKEN
```

Значение ключа передаётся серверу как `Authorization: Bearer <token>`. Затем запросите инструменты:

```text
/agentur mcp tools my_service
```

### Ограничение инструментов и ресурсов

У нового сервера списки `allowedTools` и `allowedResources` пустые. **Пустой список означает доступ ко всем инструментам или ресурсам сервера**, а не запрет доступа.

Чтобы ограничить инструменты, добавьте разрешённые имена:

```text
/agentur mcp allow-tool my_service list_items
/agentur mcp allow-resource my_service service://reports/*
```

После первого `allow-tool` разрешены только перечисленные tools; ресурсы ограничиваются отдельно через `allow-resource`. Для ресурсов поддерживается точный URI или префикс с завершающим `*`. Названия инструментов и URI зависят от сервера.

Удалить подключение:

```text
/agentur mcp delete my_service
```

Настройки хранятся в `integrations/mcp/servers.json` внутри каталога чата; значение токена остаётся в `chat/secrets.json`. Удаление подключения не удаляет ключ из хранилища секретов.

### Использование агентом и навыками

Агент получает инструменты `mcp_list_servers`, `mcp_list_tools`, `mcp_call_tool`, `mcp_read_resource`. Обычный навык также может обращаться к подключённому серверу:

```js
const result = await ctx.api.mcp.callTool("my_service", "list_items", {});
```

Серверы подключаются командами управления, а не кодом навыка. Вызовы проходят через MCP-менеджер с ограничениями, заданными для сервера этого чата. Подробнее — [MCP SDK навыков](skill-packages.md#mcp).
