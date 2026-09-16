# Как пользоваться Агентурой

## Как обратиться

В личном чате просто напишите сообщение. В группе упомяните `@username` бота, ответьте на его сообщение или используйте команду `/agentur`.

Есть два режима ответа:

- `called` — Агентура отвечает на явное обращение, reply, команду или команду навыка.
- `smart` — Агентура читает доступный контекст чата и может осторожно вмешаться при нерешённом вопросе, неясности или необходимости помочь с планом.

Переключение: `/agentur reply-mode called` или `/agentur reply-mode smart`.

## Частые задачи

- Изменить характер общения: `/agentur identity set <описание>`.
- Посмотреть или сбросить характер: `/agentur identity`, `/agentur identity reset`.
- Попросить запомнить факт или принятое решение можно обычным сообщением.
- Создать напоминание можно обычной просьбой. Новый cron создаётся выключенным; затем включите его командой, которую сообщит Агентура.
- Создать новый навык можно обычным описанием задачи. Он включается через `/agentur skill enable <name>`.
- Передать ключ внешнего сервиса: `/agentur secret set KEY VALUE`. Значение секрета обратно не показывается.

## Команды

- Справка: `/agentur help`.
- Состояние и диагностика: `/agentur status`, `/agentur doctor`.
- Язык: `/agentur language ru` или `/agentur language en`.
- Режим ответа: `/agentur reply-mode [called|smart]`.
- Режим речи: `/agentur censor-mode [on|off]`.
- Характер и память: `/agentur identity`, `/agentur mood`, `/agentur facts`, `/agentur decisions`.
- Секреты: `/agentur secrets`, `/agentur secret set KEY VALUE`, `/agentur secret delete KEY`.
- Навыки: `/agentur skills`, `/agentur skill enable <name>`, `/agentur skill disable <name>`, `/agentur skill delete <name>`.
- Напоминания: `/agentur cron list`, `/agentur cron enable <name>`, `/agentur cron disable <name>`, `/agentur cron delete <name>`.
- MCP: `/agentur mcp servers`, `mcp add-remote`, `mcp set-token`, `mcp tools`, `mcp allow-tool`, `mcp allow-resource`, `mcp delete`.

## Если что-то не работает

- В группе нет ответа: упомяните бота или ответьте на его сообщение, затем проверьте `/agentur reply-mode`.
- Агентура отвечает, но не выполняет действия: проверьте `/agentur status` и запустите `/agentur doctor`.
- Навык не запускается: проверьте `/agentur skills`, включён ли он и заполнены ли требуемые значения в `/agentur secrets`.
- Напоминание не приходит: проверьте `/agentur cron list`; новые задачи создаются выключенными.
- Картинка не читается: текущая модель может не поддерживать изображения — отправьте важный текст отдельным сообщением.

Настройки, память, навыки, секреты и напоминания относятся только к текущему чату.
