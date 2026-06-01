# Минимальный LLM API CLI на GigaChat

Пример отправляет текстовый запрос в LLM через GigaChat API и печатает ответ в консоль.

Платформа: GigaChat API от Сбера.

Почему она подходит для пет-проекта в РФ:

- есть бесплатный тариф для физических лиц;
- регистрация и ключ создаются в кабинете Sber Developers;
- сервис российский, без зависимости от Gemini/OpenAI-доступа.

## Где получить ключ

1. Откройте https://developers.sber.ru/portal/products/gigachat-api
2. Зарегистрируйтесь или войдите в личный кабинет.
3. Создайте проект GigaChat API.
4. Скопируйте ключ авторизации.

## Сертификат для Node.js

Если при запуске появляется ошибка `SELF_SIGNED_CERT_IN_CHAIN`, Node.js не доверяет корневому сертификату НУЦ Минцифры, который нужен для GigaChat API.

Что сделать:

1. Скачайте корневой сертификат НУЦ Минцифры с официальной страницы Госуслуг или по инструкции Sber Developers.
2. Найдите файл сертификата в формате `.crt` или `.pem`, например `russian_trusted_root_ca_pem.crt`.
3. Запустите CLI с переменной `NODE_EXTRA_CA_CERTS`:

```bash
export GIGACHAT_AUTH_KEY="ваш_ключ_авторизации"
NODE_EXTRA_CA_CERTS="/полный/путь/russian_trusted_root_ca_pem.crt" npm run ask -- "Привет"
```

На macOS путь может выглядеть так:

```bash
NODE_EXTRA_CA_CERTS="$HOME/Downloads/russian_trusted_root_ca_pem.crt" npm run ask -- "Привет"
```

Можно временно отключить проверку TLS через `NODE_TLS_REJECT_UNAUTHORIZED=0`, но для реального проекта так делать не стоит.

## Запуск

```bash
export GIGACHAT_AUTH_KEY="ваш_ключ_авторизации"
npm run ask -- "Объясни, что такое API, одним предложением"
```

По умолчанию используется модель `GigaChat-2`. Можно выбрать другую:

```bash
GIGACHAT_MODEL="GigaChat-2-Pro" npm run ask -- "Напиши короткий факт о космосе"
```
