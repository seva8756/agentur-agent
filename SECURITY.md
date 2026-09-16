# Found a security issue?

[English](#english) | [Русский](#russian)

<a id="english"></a>

## Contact me

If you notice a security issue in Agentur'a, please **send me a private message on Discord**.

**Discord username: seva8756**

Please do not post details in a public issue, PR, or Discord channel until we have looked into the problem. Regular bugs and ideas are welcome in Issues.

## What to include

- Mention that the issue is in Agentur'a / Mini-Chat-Agent.
- What you found and what it could affect.
- How to reproduce it — a short example or a few steps are enough.
- The version or commit where it happened, and how you run the bot: Docker Compose or Node.js.
- Logs or a screenshot, if they help explain the issue.

You do not need to write a long report. What matters is that I can understand and reproduce the problem. Please remove keys, tokens, and personal information from your examples. Do not send your working `.env` or real conversations.

## Checking the issue

You can check the issue on your own test bot or in an environment where you have permission. A short example is enough — there is no need to access other people's data or disrupt a running service.

Let's agree on when to publish the details in private, so there is time to check the problem and prepare a fix. If you would like credit when the fix is published, send me the name or link you want me to use.

## What is already known

The project is still developing. The current approach to access, data storage, and secrets is described in the [README](README.md#data-and-access) and the [integration guide](docs/integrations.md#secrets). If you have already checked the issue on the latest version, mention that too.

---

<a id="russian"></a>

# Нашли уязвимость?

## Напишите мне

Если заметили проблему с безопасностью Агентур'ы, напишите мне **в личку в Discord**.

**Discord username: seva8756**

Пожалуйста, не выкладывайте детали в публичный issue, PR или канал Discord, пока мы не разберёмся с проблемой. Обычные баги и идеи можно смело отправлять в Issues.

## Что написать

- Что проблема касается Агентур'ы / Mini-Chat-Agent.
- Что нашли и к чему это может привести.
- Как повторить проблему — хватит короткого примера или нескольких шагов.
- На какой версии или коммите это произошло и как запущен бот: Docker Compose или Node.js.
- Логи или скриншот, если с ними будет понятнее.

Не нужно оформлять большой отчёт: главное, чтобы я смог разобраться и повторить проблему. Только уберите из примеров ключи, токены и личные данные. Рабочий `.env` и реальные переписки присылать не стоит.

## Проверка проблемы

Проверку можно осуществить на своём тестовом боте или там, где у вас есть разрешение. Короткого примера достаточно — получать чужие данные или ломать работающий сервис не нужно.

Давайте договоримся о публикации деталей в личке, чтобы было время проверить проблему и подготовить исправление. Если хотите, чтобы я отметил вашу помощь при публикации исправления, пришлите имя или ссылку.

## Что уже известно

Проект ещё развивается. Как сейчас устроены доступ, хранение данных и секреты, описано в [README](README.ru.md#данные-и-доступ) и [гайде по интеграциям](docs/ru/integrations.md#секреты). Если уже проверили проблему на свежей версии, напишите об этом тоже.
