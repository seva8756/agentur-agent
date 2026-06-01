# Tiny Telegram Agent

Standalone MVP Telegram-бота для групповых чатов. По умолчанию он может работать во всех чатах, куда его добавили, и хранит память раздельно по каждому chat ID. Если заполнить `TELEGRAM_ALLOWED_CHAT_ID`, включается строгий single-chat режим.

## Что умеет

- при пустом `TELEGRAM_ALLOWED_CHAT_ID` обслуживает все чаты с отдельной памятью в `data/chats/<chat>/`;
- при заполненном `TELEGRAM_ALLOWED_CHAT_ID` молча игнорирует остальные чаты;
- хранит свежие сообщения, summary, facts, decisions, mood, skills и cron в `data/`;
- отвечает на mention, reply на сообщение бота, `/agentur`, прямое обращение вроде `бот, ...`, сработавший skill или cron;
- поддерживает OpenAI, OpenRouter и любой OpenAI-compatible endpoint через `LLM_BASE_URL`;
- отключает LLM tool calls флагом `LLM_SUPPORTS_TOOLS=false`;
- не исполняет произвольный сгенерированный код.

## Ограничения MVP

- long polling, webhooks не включены;
- память файловая, без БД и vector search;
- micro-skills только декларативные JSON;
- свободный разбор сложных напоминаний зависит от LLM tool calling, но команды работают без tools.

## Telegram setup

1. Создайте бота через BotFather: `/newbot`.
2. Скопируйте токен в `TELEGRAM_BOT_TOKEN`.
3. Чтобы бот видел обычные сообщения группы, отключите privacy mode через BotFather: `/setprivacy` -> `Disable`. Альтернатива: дайте боту права администратора, если ваша конфигурация группы этого требует.
4. Добавьте бота в группу.
5. Узнайте chat ID: временно отправьте сообщение в группу и вызовите `getUpdates` у Telegram API, либо используйте отдельного ID-бота. Для supergroup ID обычно выглядит как `-100...`.

## Настройка

```bash
cp .env.example .env
```

Минимально заполните вручную:

```env
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_CHAT_ID=
TELEGRAM_BOT_USERNAME=
LLM_API_KEY=...
LLM_MODEL=...
```

`TELEGRAM_ALLOWED_CHAT_ID` можно оставить пустым: тогда бот работает во всех чатах, куда его добавили, и не смешивает память между ними. Если хотите ограничить бота одним чатом, укажите конкретный chat ID.

`TELEGRAM_BOT_USERNAME` можно оставить пустым: приложение получит username через Telegram `getMe` при старте.

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

Custom OpenAI-compatible endpoint:

```env
LLM_BASE_URL=https://your-endpoint.example/v1
LLM_API_KEY=...
LLM_MODEL=your-model
LLM_SUPPORTS_TOOLS=false
```

## Запуск локально

```bash
npm install
npm run build
npm test
npm start
```

Для разработки:

```bash
npm run dev
```

## Docker

```bash
docker build -t tiny-telegram-agent .
docker run --env-file .env -v "$PWD/data:/app/data" tiny-telegram-agent
```

Или:

```bash
docker compose up --build
```

## Команды

```text
/agentur help
/agentur status
/agentur doctor
/agentur mood
/agentur mood reset
/agentur facts
/agentur decisions
/agentur skills
/agentur skill enable <id>
/agentur skill disable <id>
/agentur cron list
/agentur cron enable <id>
/agentur cron disable <id>
```

`/agentur doctor` проверяет конфиг, доступность `data/`, Telegram, LLM и tool calling capability, если tools включены. Секреты не выводятся.

## Micro-skills

Попросите в чате:

```text
бот, создай навык: когда кто-то пишет "надо купить", добавляй предмет в общий список покупок
```

LLM создаст JSON draft в `data/skills/drafts/<id>.json` в single-chat режиме или в `data/chats/<encoded-chat-id>/skills/drafts/<id>.json` в multi-chat режиме. Включение только явно:

```text
/agentur skill enable shopping_list
```

После этого сообщение:

```text
надо купить упаковочную плёнку
```

может добавить элемент в `data/chat/lists/shopping.json` и ответить кратким подтверждением.

В MVP skills не могут запускать JavaScript/TypeScript, `eval`, shell-команды, произвольный filesystem access или HTTP-запросы.

## Cron

Попросите:

```text
бот, каждую среду в 10 утра напоминай проверить поставки
```

LLM создаст disabled draft в `data/cron/jobs.json`. Включение:

```text
/agentur cron enable cron_xxx
```

Cron-задачи всегда отправляют сообщения только в тот чат, где были созданы. В single-chat режиме это `TELEGRAM_ALLOWED_CHAT_ID`.

## Файлы данных

- `data/chat/*` — данные single-chat режима, если задан `TELEGRAM_ALLOWED_CHAT_ID`;
- `data/chats/<encoded-chat-id>/chat/recent.jsonl` — свежие сообщения multi-chat режима;
- `data/chat/summary.md` — сжатый архив при ротации;
- `data/chat/mood.json` и `mood-history.jsonl` — дневник настроения;
- `data/chat/facts.json` — факты;
- `data/chat/decisions.json` — решения;
- `data/chat/lists/*.json` — списки из skills;
- `data/skills/drafts/*.json` — черновики навыков;
- `data/skills/enabled/*.json` — включённые навыки;
- `data/cron/jobs.json` — cron drafts и enabled jobs.

## Универсальные micro-skills

Micro-skills остаются безопасными JSON-декларациями, без JS/eval/shell. Чтобы не дорабатывать код под каждый кейс, runtime поддерживает универсальные действия:

- `reply_template` — ответ по шаблону с переменными `{{text}}`, `{{item}}`, `{{username}}`, `{{displayName}}`, `{{chatId}}`;
- `http_request` — HTTP-запрос к заранее разрешённому origin;
- `chain` — цепочка до 8 действий, например сохранить в список, вызвать webhook и ответить шаблоном.

HTTP-действия выключены по умолчанию. Разрешите только нужные origin:

```env
SKILL_HTTP_ALLOWED_ORIGINS=https://api.example.com,https://hooks.example.com
SKILL_HTTP_TIMEOUT_MS=10000
```

Пример JSON action, который LLM может создать через tool calling:

```json
{
  "type": "chain",
  "actions": [
    { "type": "http_request", "method": "GET", "url": "https://api.example.com/lookup?q={{item}}", "responseTemplate": "Ответ ручки: {{responseText}}" },
    { "type": "reply_template", "template": "Обработал: {{item}}" }
  ]
}
```

Если origin не указан в `SKILL_HTTP_ALLOWED_ORIGINS`, skill не будет создан или запрос будет заблокирован при выполнении.

## Политика хранения сообщений

По умолчанию бот не пишет в `recent.jsonl` всю фоновую переписку. В память попадают только:

- сообщения, обращённые к боту;
- `/agentur` команды;
- сообщения, которые активировали skill;
- ответы самого бота;
- cron/agentur interactions.

Это снижает расход диска и не собирает сырые данные из всех чатов. Mood diary и контекст в таком режиме строятся по взаимодействиям с ботом, а не по полной пассивной переписке.

Если для конкретного чата нужен полный контекст, укажите его ID:

```env
TELEGRAM_FULL_CAPTURE_CHAT_IDS=-1001234567890,-1009876543210
```

Чтобы вернуть старое поведение для всех разрешённых чатов:

```env
TELEGRAM_FULL_CAPTURE_CHAT_IDS=*
```

### Сводка и очистка interaction-buffer

Для чатов, которые не входят в `TELEGRAM_FULL_CAPTURE_CHAT_IDS`, `recent.jsonl` используется как короткий буфер взаимодействий с ботом. После `INTERACTION_SUMMARY_EVERY_MESSAGES` сохранённых сообщений бот:

- анализирует настроение по буферу;
- обновляет `data/.../chat/mood.json`;
- добавляет запись в `data/.../chat/mood-history.jsonl`;
- пишет компактную запись в `data/.../chat/interaction-summaries.jsonl`;
- добавляет текстовую сводку в `data/.../chat/summary.md`;
- очищает `recent.jsonl`.

По умолчанию:

```env
INTERACTION_SUMMARY_EVERY_MESSAGES=50
```

Для full-capture чатов применяется прежняя ротация через `RECENT_MESSAGES_FILE_LIMIT`, потому что там явно включён сбор полного контекста.

## Chat Identity

У каждого чата может быть стабильная identity агента. Это не mood diary: identity задаёт постоянный характер и правила поведения агента в конкретном чате и не переписывается под настроение.

Файл хранится в:

```text
data/.../chat/identity.md
```

Команды:

```text
/agentur identity
/agentur identity set <описание характера и правил>
/agentur identity reset
```

Можно задать identity файлом: отправьте `.txt` или `.md` документ с caption:

```text
/agentur identity set
```

Текст файла будет сохранён как identity этого чата. Размер ограничен:

```env
AGENT_IDENTITY_MAX_CHARS=5000
```

## Связь cron и micro-skills

Cron-задачи могут не только отправлять статичный текст или спрашивать агента, но и запускать включённый micro-skill в том же чате.

Action:

```json
{
  "type": "run_micro_skill",
  "skillId": "daily_report",
  "text": "cron daily report",
  "sendResult": true
}
```

Правила:

- skill должен быть включён через `/agentur skill enable <id>`;
- cron запускает action навыка напрямую по `skillId`, trigger навыка при этом не проверяется;
- `text` передаётся навыку как синтетическое сообщение от `Cron`;
- если skill вернул текст и `sendResult=true`, cron отправит этот текст в чат;
- HTTP allowlist и файловая память остаются теми же, что у обычных skills этого чата.

## Режим ответа в чате

Для каждого чата можно выбрать, как бот вмешивается в диалог.

Команды:

```text
/agentur reply-mode
/agentur reply-mode called
/agentur reply-mode smart
```

Режимы:

- `called` — режим по умолчанию. Бот отвечает только на mention, reply, `/agentur`, прямое обращение или сработавший skill.
- `smart` — бот мониторит чат, сохраняет короткий буфер сообщений и через компактный LLM-classifier решает, стоит ли самому вмешаться.

Настройка хранится в `data/.../chat/settings.json` и привязана к конкретному чату. В smart mode фоновая переписка попадает в короткий буфер и затем сворачивается через `INTERACTION_SUMMARY_EVERY_MESSAGES`, как обычные interactions.

## Локальное время агента

Агент всегда получает в system context текущее локальное время по `AGENT_TIMEZONE`:

```env
AGENT_TIMEZONE=Europe/Moscow
```

Timezone валидируется как IANA timezone при старте. `/agentur doctor` также показывает рассчитанное локальное время.

## License

Создатель проекта: Всеволод Беликов [(@seva8756)](https://github.com/seva8756)
