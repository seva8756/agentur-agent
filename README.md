# Agentur'a — an AI agent for your chats

[English](README.md) | [Русский](README.ru.md)

Agentur'a is an AI agent for chats, with memory, skills, mood, a chat file system, and scheduled tasks. It runs on your server and connects to messaging platforms through adapters. Telegram is currently implemented; the architecture supports adding other platforms.

Each chat has its own memory, settings, and integrations. You choose the LLM provider, and the agent stores its data in ordinary files — no separate database is needed.

**Status:** MVP, under active development. See [Limitations](#limitations) for the current scope and constraints.

## Chating with Agentur'a 

![Agentur demo in Telegram](docs/assets/chating_en.gif)

## What you can do

| Task | What it looks like in a chat |
| --- | --- |
| Keep track of agreements | “Remember: we hold planning meetings on Mondays.” You can view saved facts and decisions with commands. |
| Customize your assistant | Set its personality and communication rules for a particular chat, and choose Russian or English. |
| Create skills | Ask for a skill to manage a shopping list, process data, or call an API. |
| Schedule tasks | Ask for a recurring reminder, an agent response, or a skill run, then enable the new task. |
| Connect services | Give a skill access to an allowed HTTP API or connect a remote MCP server. |
| Work with files and images | Discuss photos, read text attachments, and create and send files. Photo analysis requires a model that supports images. |

These examples are requests to the agent, not built-in commands. Results depend on the selected model and available tools. New skills and scheduled tasks are disabled when created; use the commands below to enable them.

## Contents

- [Quick start with Docker](#quick-start-with-docker)
- [Telegram setup](#telegram-setup)
- [Settings and LLM providers](#settings-and-llm-providers)
- [Chatting and commands](#chatting-and-commands)
- [A personality for each chat](#a-personality-for-each-chat)
- [Skills and scheduled tasks](#skills-and-scheduled-tasks)
- [Data and access](#data-and-access)
- [Maintenance](#maintenance)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Limitations](#limitations)
- [Documentation](#documentation)
- [License](#license)

## Quick start with Docker

### 1. Prepare your environment

You will need:

- Docker with the `docker compose` command;
- a Telegram bot token from [@BotFather](https://t.me/BotFather);
- an API key and model ID from an LLM provider with a compatible Chat Completions API;
- outbound network access to Telegram and your chosen LLM API.

For skills, memory updates on request, and scheduling, choose a model that supports tool calling. API usage is billed under your provider's terms; the bot owner supplies the key.

Clone this repository or download its ZIP archive, open the project directory, and create the configuration file:

```bash
cp .env.example .env
```

### 2. Fill in `.env`

Three values are required:

```dotenv
TELEGRAM_BOT_TOKEN=your-bot-token
LLM_API_KEY=your-api-key
LLM_MODEL=model-id-from-your-provider
```

The example uses `LLM_BASE_URL=https://api.openai.com/v1`. Change this address for another provider — see [provider settings](#settings-and-llm-providers).

`TELEGRAM_ALLOWED_CHAT_ID` limits access to one or more numeric chat IDs, separated by commas. **An empty value allows the bot to work in every chat it can access, including private chats.** To find your chat ID without using another bot, send `/agentur help` after startup and look for `chatId: "telegram:…"` in the logs. Put only the numeric part in `.env`, keeping the minus sign if present, then recreate the container with `docker compose up -d`.

### 3. Start the bot

```bash
docker compose up -d --build
docker compose logs --tail=100 -f
```

After a successful start, the logs will contain `Starting Agentur'a`. Data is saved in `./data` on the host, mounted at `/app/data` inside the container. You do not need to expose a port or configure an incoming webhook.

### 4. Check the first response

Open a private chat with your bot and send:

```text
/agentur help
/agentur doctor
```

`help` lists the commands. `doctor` checks the data directory, Telegram, the LLM, and tool calling if enabled. A successful result includes `telegram: ok`, `llm: ok`, and `llm tools: ok`. The check itself makes requests to your provider's API.

Then send a normal message, such as “Hi! What can you help me with?” The bot replies in private chats without a mention. To use it in a group, follow the [Telegram setup](#telegram-setup).

## Telegram setup

1. Create a bot with `/newbot` in [@BotFather](https://t.me/BotFather) and save its token in `.env`.
2. Add the bot to your group. If `TELEGRAM_ALLOWED_CHAT_ID` is set, include the group's ID in that list.
3. To read background conversation, use `smart` mode, or handle custom skill commands, disable privacy mode: `/setprivacy` → select your bot → `Disable`. If the bot is already in the group, remove it and add it again for this change to take effect. See the [Telegram documentation](https://core.telegram.org/bots/features#privacy-mode).
4. Send `@your_bot_username Hi!` or reply to one of the bot's messages.

You can leave `TELEGRAM_BOT_USERNAME` empty: the username is detected at startup. Admin rights are not needed for normal replies. Permission to delete messages is used when the bot tries to remove a command that sets a secret.

## Settings and LLM providers

Environment settings are listed in [`.env.example`](.env.example). The bot uses the Chat Completions API. Use `/agentur doctor` to check whether a particular endpoint and model work with it.

| Provider | `LLM_BASE_URL` | `LLM_MODEL` |
| --- | --- | --- |
| OpenRouter | `https://openrouter.ai/api/v1` | A model ID from the provider's catalog |
| OpenAI | `https://api.openai.com/v1` | The ID of a model available to your account |
| Another compatible service | Your service's API address | A model ID from that service |

`LLM_SUPPORTS_TOOLS=true` enables tool calling. If the endpoint does not support it, set this to `false`: normal replies will still work, but the model will not be able to take actions through tools.

Main settings after copying `.env.example`:

| Variable | Example value | Purpose |
| --- | --- | --- |
| `TELEGRAM_ALLOWED_CHAT_ID` | Empty | Allowed chats: one ID or a comma-separated list |
| `AGENT_TIMEZONE` | `Europe/Moscow` | Time zone for the agent and new scheduled tasks, in IANA format |
| `AGENT_DEFAULT_LOCALE` | `ru` | Language for new chats: `ru` or `en` |
| `AGENT_MAX_TOOL_STEPS` | `15` | Maximum number of tool steps per response |
| `CONTEXT_WINDOW_TOKENS` | `32000` | Context window; set this to match your model |
| `CONTEXT_BUDGET_TOKENS` | `12000` | Working budget for input context |
| `REPLY_MAX_TOKENS` | `900` | Reserved tokens and generation limit for the response |
| `LLM_TIMEOUT_MS` | `45000` | Timeout for an LLM request |
| `TELEGRAM_IMAGE_MAX_BYTES` | `5242880` | Photo download limit: 5 MiB |
| `TELEGRAM_ATTACHMENT_MAX_BYTES` | `5242880` | Document download limit: 5 MiB |
| `SKILL_HTTP_ALLOWED_ORIGINS` | Empty | Allowed HTTP origins; an empty value disables the HTTP tool and HTTP requests from skills |
| `MCP_ENABLED` | `false` | Access to tools on remote MCP servers |

These are values from the **example file**, not a complete list of built-in defaults. If variables are not set at all, the defaults in [`src/config.ts`](src/config.ts) apply; some differ from the example. After changing `.env`, run `docker compose up -d` so the container receives the new environment.

HTTP, secrets, and MCP settings are covered in the [integration guide](docs/integrations.md).

## Chatting and commands

In a private chat, send normal text. In a group, mention the bot's `@username` or reply to its message. Addressing it by name without `@` is not a separate trigger.

`/agentur` is the prefix for management commands. For example, `/agentur help` shows help. An arbitrary request after `/agentur` is not passed to the model as a question.

### Reply modes

- **`called`** — the default. In a group, the bot responds to mentions, replies to its messages, and commands, including commands from enabled skills.
- **`smart`** — the bot also stores background conversation and asks the LLM whether to join in. This can use the API even when no reply is sent to the chat.

```text
/agentur reply-mode called
/agentur reply-mode smart
```

Scheduled tasks run independently of the reply mode. The `called` mode does not prevent background messages from being stored if full capture is enabled separately. See [Data and access](#data-and-access).

### Main commands

| Command | Action |
| --- | --- |
| `/agentur help` | Show command help |
| `/agentur status` | Show the chat's modes and settings |
| `/agentur doctor` | Check connections and the environment |
| `/agentur language ru` or `en` | Set the chat language |
| `/agentur reply-mode called` or `smart` | Set the reply mode |
| `/agentur censor-mode on` or `off` | Set a preference for profanity in replies; this does not moderate chat members |
| `/agentur identity` | Show the agent's current personality and rules |
| `/agentur identity set <text>` | Save its personality and rules |
| `/agentur identity reset` | Reset them |
| `/agentur mood` / `/agentur mood reset` | View / reset the chat mood estimate |
| `/agentur facts` | Show saved facts |
| `/agentur decisions` | Show saved decisions |

## A personality for each chat

You can give the bot its own personality, tone, and rules through **identity**. The same bot can be a concise assistant in a work chat and a more relaxed participant with a sense of humor in a chat with friends. Each chat stores its own identity.

For example, in a work chat:

```text
/agentur identity set You are our team's assistant. Keep replies short and clear, help us keep track of decisions, and ask questions when something is unclear.
```

You can also set the identity by sending a UTF-8 `.txt` or `.md` file with the caption `/agentur identity set`.

## Skills and scheduled tasks

### Skills

A skill is a program for a recurring task in a particular chat. Describe your task to the agent, for example: “Create a shopping list skill that can add items, show the list, and clear it.” Creating skills requires a model with tool calling support.

New skills are saved as disabled. To list and manage them:

```text
/agentur skills
/agentur skill enable <id>
/agentur skill disable <id>
/agentur skill delete <id>
```

Enabling a skill validates its code and runs a trial execution. The agent selects enabled skills by their descriptions. A separate slash command is only needed for an explicitly configured command trigger.

Skills are stored in `skills/custom/<id>/` inside the chat's data directory. An update keeps one previous revision for rollback. **Updating an enabled skill preserves its enabled state**; you do not need to enable it again. Skill changes do not require an application restart.

Skill code runs in QuickJS, with access to memory, lists, files, and allowed integrations through the SDK. See the [skills guide](docs/skill-packages.md) for the contract, examples, and limits.

### Scheduled tasks

Ask the agent to create a recurring task, for example: “Remind us about the team meeting every weekday at 10:00.” It can create a task that sends text, asks the model, or runs a skill tool.

```text
/agentur cron list
/agentur cron enable <id>
/agentur cron disable <id>
/agentur cron delete <id>
```

New tasks remain disabled until enabled. Each task has its own time zone. If no time zone is specified when the task is created, it uses `AGENT_TIMEZONE`. The bot process must be running for scheduled tasks to execute. A skill used by a scheduled task must be enabled; its command triggers are not checked.

## Data and access

### What is stored

In Docker, `./data` on the host maps to `/app/data` inside the container. With the standard setup, chat data is stored in `data/chats/<encoded-chat-id>/`. The directory name is the base64url encoding of `telegram:<numeric-ID>`.

| Path inside the chat directory | Contents |
| --- | --- |
| `chat/recent.jsonl` | Message buffer, authors, and attachment references |
| `chat/summary.md`, `chat/interaction-summaries.jsonl` | Accumulated context and interaction summaries |
| `chat/facts.json`, `chat/decisions.json` | Facts and decisions |
| `chat/identity.md`, `chat/settings.json` | Personality, language, and chat modes |
| `chat/mood.json`, `chat/mood-history.jsonl` | Chat mood estimates |
| `chat/secrets.json` | Integration keys in plain text |
| `chat/lists/` | Lists used by skills |
| `skills/custom/`, `skills/state/`, `skills/audit/` | Skills, their state, and execution logs |
| `attachments/`, `artifacts/` | Received attachments and generated files |
| `integrations/mcp/` | MCP server settings and request logs |
| `cron/jobs.json` | Scheduled tasks |

### Which messages become context

- In `called` mode without full capture, the bot stores messages addressed to it, commands, messages that trigger skills, and its own replies.
- In `smart` mode, background messages are also stored. Some recent conversation is sent to the model to decide whether to reply.
- `TELEGRAM_FULL_CAPTURE_CHAT_IDS` enables storage of all processed messages in selected chats, regardless of reply mode. Set numeric IDs separated by commas, or `*` for all chats. This does not download older Telegram history.

The message buffer is reduced as it grows; some context remains in summaries. Attachments and other files are stored separately, so the buffer limit does not limit the total size of `data/`.

LLM requests send the user's request and the assembled context to the selected provider: history, memory, instructions, images when used, and tool results. HTTP and MCP integrations send data to their respective services. Storing files locally does not mean that all processing happens on your server.

### Who can manage the bot

Access is restricted at the chat level. In the current version, management commands within an allowed chat do not check whether the user is an admin or owner: members can change settings, skills, scheduled tasks, and integrations. Memory is separate between chats, but shared by members and topics within the same chat.

Secrets are stored without encryption. The `/agentur secret set` command passes through message history; trying to delete it from Telegram does not clear local history. See the [secrets section](docs/integrations.md#secrets) for the current behavior.

## Maintenance

```bash
# Check status and recent logs
docker compose ps
docker compose logs --tail=100

# Stop the application; ./data remains on the host
docker compose down

# Build and start after updating the source code
docker compose up -d --build
```

Before updating, stop the bot and keep a copy of `data/` and `.env` in a private location. To restore them, put the files back while the application is stopped, then start a compatible version of the code. Running multiple instances with the same Telegram token or shared data directory is not supported.

To delete a chat's data, stop the bot and remove its `data/chats/<encoded-chat-id>/` directory. The directory will be created again when that chat next interacts with the bot. Deleting local files does not delete messages from Telegram or data already sent to external services.

With the supplied Compose file, keep `AGENT_DATA_DIR=./data` or set it to `/app/data`: both point to the mounted directory. To use another path, also change the mount in `docker-compose.yml`.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| The container exits at startup | Run `docker compose logs --tail=100`: check required variables, the bot token, API URL, and time zone |
| The bot replies in private chats but stays silent in a group | The group's ID in the allowlist, the `@username` mention, privacy mode, and permission to send messages |
| `/agentur <question>` shows help | This is a management command. Ask in normal text in a private chat, or mention `@username` in a group |
| `help` works, but normal replies do not | Use `/agentur doctor` to check the LLM key, model access, balance, API address, and network access |
| The bot replies but does not take actions | `LLM_SUPPORTS_TOOLS`, the model's tool support, and the `llm tools` diagnostic result |
| A skill cannot call an API | Its origin must be allowed in `.env` and the skill manifest, and required secrets must be set; see [HTTP setup](docs/integrations.md#http) |
| MCP is unavailable | `MCP_ENABLED=true`, the server address, Bearer token, and tool/resource restrictions; see [MCP setup](docs/integrations.md#mcp) |
| A scheduled task does not run | The task is enabled, its time zone is correct, the bot is running, and any required skill is enabled |
| Changes to `.env` have no effect | Run `docker compose up -d`; a simple restart does not apply a new container environment |

## Development

The project is written in TypeScript. `package.json` requires Node.js `>=20`; the Dockerfile uses Node.js 20.

To run locally, install Node.js and npm, prepare `.env` as described in the quick start, then run:

```bash
npm ci
npm run build
npm start
```

Use `npm run dev` to run from source. Checks: `npm run lint`, `npm test`, and `npm run build`. `npm run format` formats files and changes them on disk.

You can run checks in Docker without installing dependencies on the host:

```bash
docker build --target build -t agentur-check .
docker run --rm --network none agentur-check npm run lint
docker run --rm --network none agentur-check npm test
```

The `build` stage already runs the TypeScript build. These checks do not require passing `.env` to the container or mounting your working `data/` directory.

## Limitations

- Telegram is the current interface, using long polling without webhooks or a web dashboard.
- Storage uses files, without a database or vector search. Running multiple processes against the same `data/` directory is not supported.
- The quality of responses, tool calls, and image analysis depends on the model and provider. A compatible URL alone does not guarantee support for every feature.

## Documentation

- [Example configuration](.env.example)
- [Skills: manifest, SDK, examples, limits, and rollback](docs/skill-packages.md)
- [Integrations: HTTP, secrets, and MCP](docs/integrations.md)

## License

This project is available under the [MIT license](LICENSE).

Copyright (c) 2026 Всеволод Беликов [(@seva8756)](https://github.com/seva8756).

You may use, modify, and distribute the code, including in commercial and closed-source products, as long as you keep the copyright notice and license text in copies or substantial portions of the code. The software is provided “as is”, without warranties. See [LICENSE](LICENSE) for the full terms.
