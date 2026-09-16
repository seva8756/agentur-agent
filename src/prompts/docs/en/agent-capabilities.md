# Using Agentur

## Getting a reply

In a private chat, simply send a message. In a group, mention the bot with `@username`, reply to one of its messages, or use `/agentur`.

There are two reply modes:

- `called` — Agentur replies to a direct request, reply, command, or skill command.
- `smart` — Agentur reads the available chat context and may cautiously intervene for an unresolved question, confusion, or useful planning help.

Switch modes with `/agentur reply-mode called` or `/agentur reply-mode smart`.

## Common tasks

- Change the communication style: `/agentur identity set <description>`.
- View or reset identity: `/agentur identity`, `/agentur identity reset`.
- Ask normally to remember a fact or decision.
- Ask normally to create a reminder. A new cron job starts disabled; enable it with the command Agentur provides.
- Describe a task normally to create a skill. Enable it with `/agentur skill enable <name>`.
- Store an external-service key with `/agentur secret set KEY VALUE`. Secret values are never shown back.

## Commands

- Help: `/agentur help`.
- Status and diagnostics: `/agentur status`, `/agentur doctor`.
- Language: `/agentur language ru` or `/agentur language en`.
- Reply mode: `/agentur reply-mode [called|smart]`.
- Profanity mode: `/agentur censor-mode [on|off]`.
- Identity and memory: `/agentur identity`, `/agentur mood`, `/agentur facts`, `/agentur decisions`.
- Secrets: `/agentur secrets`, `/agentur secret set KEY VALUE`, `/agentur secret delete KEY`.
- Skills: `/agentur skills`, `/agentur skill enable <name>`, `/agentur skill disable <name>`, `/agentur skill delete <name>`.
- Reminders: `/agentur cron list`, `/agentur cron enable <name>`, `/agentur cron disable <name>`, `/agentur cron delete <name>`.
- MCP: `/agentur mcp servers`, `mcp add-remote`, `mcp set-token`, `mcp tools`, `mcp allow-tool`, `mcp allow-resource`, `mcp delete`.

## Troubleshooting

- No group reply: mention the bot or reply to its message, then check `/agentur reply-mode`.
- Agentur replies but does not perform actions: check `/agentur status` and run `/agentur doctor`.
- A skill does not run: check `/agentur skills`, whether it is enabled, and required values in `/agentur secrets`.
- A reminder does not arrive: check `/agentur cron list`; new jobs start disabled.
- An image cannot be read: the current model may not support images; send important text separately.

Settings, memory, skills, secrets, and reminders belong only to the current chat.
