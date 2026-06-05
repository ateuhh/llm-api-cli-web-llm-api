# Сравнение слабой, средней и сильной LLM-модели

Проект демонстрирует один и тот же запрос на трех моделях GigaChat:

- слабая модель: `GigaChat-2`
- средняя модель: `GigaChat-2-Pro`
- сильная модель: `GigaChat-2-Max`

Скрипт замеряет:

- время ответа;
- количество токенов из поля `usage`;
- стоимость: `0 ₽` в рамках freemium-лимита и расчетную платную стоимость по тарифу за 1000 токенов.

В конце выводится сравнение по качеству, скорости и ресурсоемкости.

## Запрос по умолчанию

```text
Объясни простыми словами, почему для пет-проекта с LLM API важно сравнивать слабую, среднюю и сильную модель. Ответь в 4-5 предложениях.
```

## Демо без API-ключа

Если нет ключа GigaChat или сертификата Минцифры, можно показать работу задания в mock-режиме:

```bash
npm run ask -- --mock
```

Этот режим не отправляет сетевые запросы, но показывает пример результата с временем, токенами, стоимостью и выводами.

## Реальный запуск через API

1. Получите ключ авторизации в GigaChat API:

   https://developers.sber.ru/portal/products/gigachat-api

2. Запустите:

```bash
export GIGACHAT_AUTH_KEY="ваш_ключ_авторизации"
npm run ask
```

Можно передать свой запрос:

```bash
npm run ask -- "Сравни REST API и GraphQL для небольшого веб-приложения"
```

## Сертификат для Node.js

Если появляется ошибка `SELF_SIGNED_CERT_IN_CHAIN`, Node.js не доверяет корневому сертификату НУЦ Минцифры, который нужен для GigaChat API.

Запуск с сертификатом:

```bash
export GIGACHAT_AUTH_KEY="ваш_ключ_авторизации"
NODE_EXTRA_CA_CERTS="$HOME/Downloads/russian_trusted_root_ca_pem.crt" npm run ask
```

Временный небезопасный вариант только для локальной проверки:

```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 npm run ask
```

Для реального проекта лучше использовать `NODE_EXTRA_CA_CERTS`, а не отключать TLS-проверку.

## Как считается стоимость

В freemium-режиме стоимость для пользователя считается как `0 ₽`, пока не исчерпаны бесплатные токены.

Для платной оценки используется формула:

```text
стоимость = total_tokens / 1000 * цена_за_1000_токенов
```

В коде используются цены из тарифов для физлиц:

- `GigaChat-2`: `0.065 ₽ / 1000 токенов`
- `GigaChat-2-Pro`: `0.5 ₽ / 1000 токенов`
- `GigaChat-2-Max`: `0.65 ₽ / 1000 токенов`

## Ссылки

- Модели GigaChat: https://developers.sber.ru/docs/ru/gigachat/models
- Выбор модели: https://developers.sber.ru/docs/ru/gigachat/guides/selecting-a-model
- Подсчет токенов и поле `usage`: https://developers.sber.ru/docs/ru/gigachat/guides/counting-tokens
- Тарифы для физлиц: https://developers.sber.ru/docs/ru/gigachat/tariffs/individual-tariffs
