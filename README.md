# CLI-чат с GigaChat Agent

Простой агент, который:

- принимает сообщения пользователя в CLI;
- хранит историю диалога в `chat-history.json`;
- восстанавливает историю после перезапуска;
- считает токены текущего запроса, истории и ответа;
- показывает заполнение контекстного окна и стоимость;
- оставляет последние N сообщений без изменений;
- заменяет старые сообщения отдельным summary;
- отправляет всю историю в LLM через HTTP API;
- добавляет ответ модели в историю;
- выводит ответ в терминал.

Это именно чат, а не серия независимых one-shot запросов.

## Структура

### `agent.js`

Содержит отдельную сущность `GigaChatAgent`.

Агент инкапсулирует:

- историю сообщений;
- загрузку и атомарное сохранение JSON-файла;
- подсчет токенов через `/tokens/count`;
- компрессию старой истории через summary;
- обработку переполнения контекстного окна;
- получение access token;
- HTTP-запрос к GigaChat API;
- добавление сообщений пользователя и ассистента;
- очистку и чтение истории.

Главный метод:

```js
const answer = await agent.chat(userInput);
```

При каждом вызове в API передается массив:

```js
messages: [
  { role: "system", content: "..." },
  { role: "system", content: "Краткое содержание предыдущей части диалога: ..." },
  { role: "user", content: "Одно из последних сообщений" },
  { role: "assistant", content: "Один из последних ответов" },
  { role: "user", content: "Уточняющий вопрос" }
]
```

### `index.js`

Содержит только CLI-интерфейс:

- читает ввод пользователя;
- вызывает `agent.chat()`;
- выводит ответ;
- обрабатывает команды чата.

## Демо без API-ключа

```bash
npm run chat -- --mock
```

Пример диалога:

```text
Вы: Меня зовут Михаил
Агент: Я запомнил ваш первый запрос: "Меня зовут Михаил"...

Вы: Как меня зовут?
Агент: Продолжаю диалог с учетом истории. Предыдущий запрос: "Меня зовут Михаил"...
```

Mock-режим не вызывает LLM, но позволяет проверить CLI и накопление истории.

В mock-режиме токены оцениваются приближенно: один токен равен примерно 3–4 символам.

## Проверка сохранения между запусками

Первый запуск:

```bash
npm run chat -- --mock
```

Введите:

```text
Меня зовут Михаил
/exit
```

Запустите приложение заново:

```bash
npm run chat -- --mock
```

Введите:

```text
Как меня зовут?
```

Агент загрузит `chat-history.json` и продолжит диалог с учетом сообщения из первого запуска. Проверить восстановленные сообщения можно командой `/history`.

## Реальный запуск через API

1. Получите ключ авторизации:

   https://developers.sber.ru/portal/products/gigachat-api

2. Запустите чат:

```bash
export GIGACHAT_AUTH_KEY="ваш_ключ_авторизации"
npm run chat
```

Если нужен сертификат НУЦ Минцифры:

```bash
export GIGACHAT_AUTH_KEY="ваш_ключ_авторизации"
NODE_EXTRA_CA_CERTS="$HOME/Downloads/russian_trusted_root_ca_pem.crt" npm run chat
```

Если сертификат установлен в папку проекта `certs`, используйте готовую команду:

```bash
export GIGACHAT_AUTH_KEY="ваш_ключ_авторизации"
npm run chat:secure
```

Установка сертификата в папку проекта:

```bash
mkdir -p certs
curl -k --fail --location \
  https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt \
  --output certs/russian_trusted_root_ca_pem.crt
```

Проверка сертификата:

```bash
openssl x509 \
  -in certs/russian_trusted_root_ca_pem.crt \
  -noout -subject -dates -fingerprint -sha256
```

Сертификат публичный, но локальный файл исключен из Git. После нового клонирования репозитория команду установки нужно выполнить повторно.

По умолчанию используется `GigaChat-2`. Другую модель можно задать через переменную:

```bash
GIGACHAT_MODEL="GigaChat-2-Pro" npm run chat
```

## Команды

- `/history` — показать накопленную историю;
- `/summary` — показать сжатую старую часть диалога;
- `/tokens` — показать накопленные токены и стоимость;
- `/clear` — очистить историю в памяти и JSON-файле;
- `/exit` — завершить чат.

По умолчанию история хранится в `chat-history.json`. Файл исключен из Git через `.gitignore`.

Другой путь можно задать переменной окружения:

```bash
CHAT_HISTORY_PATH="./data/my-chat.json" npm run chat -- --mock
```

## Метрики токенов

После каждого ответа агент показывает:

- токены текущего сообщения пользователя;
- токены всей истории, отправленной модели;
- токены ответа модели;
- процент заполнения контекстного окна;
- стоимость текущего вызова;
- накопленную стоимость диалога.

В реальном режиме:

- текст считается через официальный метод `POST /tokens/count`;
- токены ответа и тарифицируемые токены берутся из объекта `usage`;
- стоимость рассчитывается по тарифу `65 ₽ за 1 млн токенов` для `GigaChat-2`.

История может содержать больше токенов, чем указано в `usage.prompt_tokens`: GigaChat может кэшировать часть предыдущего контекста, а кэшированные токены не тарифицируются.

## Сравнение диалогов

Запустите автоматическую демонстрацию:

```bash
npm run token-demo
```

Она сравнивает:

1. Короткий диалог — мало токенов и минимальная стоимость.
2. Длинный диалог — история растет при каждом сообщении, поэтому растут входные токены и стоимость.
3. Переполнение окна — агент останавливает запрос до вызова API и сообщает, сколько токенов не помещается.

Для демонстрации переполнения используется уменьшенное mock-окно. В реальных моделях `GigaChat-2`, `GigaChat-2-Pro` и `GigaChat-2-Max` размер контекстного окна составляет `128 000` токенов.

Настройки можно изменить:

```bash
GIGACHAT_CONTEXT_WINDOW=128000 \
GIGACHAT_MAX_COMPLETION_TOKENS=512 \
GIGACHAT_RUB_PER_MILLION_TOKENS=65 \
npm run chat
```

Если контекст переполнен, запрос не отправляется. Нужно очистить историю, удалить старые сообщения или заменить их кратким резюме.

## Компрессия истории

По умолчанию агент:

- хранит последние `10` сообщений пользователя и ассистента без изменений;
- когда за этим хвостом накапливается еще `10` старых сообщений, сворачивает их в summary;
- сохраняет summary отдельно от массива `messages`;
- при следующем запросе отправляет `system prompt + summary + последние сообщения`.

Summary сохраняет ключевые факты, имена, числа, решения, предпочтения и незавершенные задачи. Оно записывается в тот же JSON-файл и восстанавливается после перезапуска.

Настройки:

```bash
CHAT_COMPRESSION=true \
CHAT_RECENT_MESSAGES=10 \
CHAT_SUMMARY_BATCH_SIZE=10 \
npm run chat
```

Отключить компрессию:

```bash
CHAT_COMPRESSION=false npm run chat
```

Для быстрой демонстрации можно уменьшить пороги:

```bash
CHAT_RECENT_MESSAGES=4 \
CHAT_SUMMARY_BATCH_SIZE=4 \
npm run chat -- --mock
```

После нескольких сообщений команда `/summary` покажет сжатую старую часть, а `/history` — последние сообщения без изменений.

## Сравнение сжатия

Запустите одинаковый диалог на двух агентах:

```bash
npm run compression-demo
```

Реальное сравнение через GigaChat API:

```bash
export GIGACHAT_AUTH_KEY="ваш_ключ_авторизации"
NODE_EXTRA_CA_CERTS="$HOME/Downloads/russian_trusted_root_ca_pem.crt" \
npm run compression-demo -- --real
```

Реальный тест делает много последовательных API-запросов: отдельно для двух диалогов и для создания summary.

Перед отправкой реальных запросов программа показывает их количество и требует ввести `ДА`. До подтверждения запросы к GigaChat не выполняются. Во время выполнения остановить сценарий можно сочетанием `Ctrl+C`.

Для автоматизированного запуска без вопроса подтверждения существует флаг `--yes`, но использовать его стоит только когда расход API-квоты ожидаем:

```bash
NODE_EXTRA_CA_CERTS=./certs/russian_trusted_root_ca_pem.crt \
node compression-demo.js --real --yes
```

`compression-demo:secure` не является интерактивным чатом. Он запускается автоматически и сам завершается после сравнения. Команда `/exit` работает только в:

```bash
npm run chat:secure
```

Если реальная демонстрация остановилась, CLI теперь показывает номер запроса, HTTP-статус и сообщение GigaChat. Частые причины: закончилась квота, превышен rate limit или выбранная модель недоступна аккаунту.

Демонстрация:

- сообщает агенту название проекта, кодовое слово и базу данных;
- добавляет длинную последовательность сообщений;
- задает контрольный вопрос о фактах из начала;
- сравнивает ответ, токены контекста и стоимость.

Пример результата:

```text
Без сжатия: 1003 токена контекста, качество 3/3.
Со сжатием: 316 токенов контекста, качество 3/3.
Экономия: 687 токенов, или 68.5%.
```

Summarization тоже использует токены, поэтому на коротком диалоге компрессия может не окупиться. На длинном диалоге она уменьшает каждый следующий запрос, снижает стоимость и помогает не превысить контекстное окно.

## Источники

- Модели и размер контекста: https://developers.sber.ru/docs/ru/gigachat/models/gigachat-2-lite
- Подсчет токенов: https://developers.sber.ru/docs/ru/gigachat/guides/counting-tokens
- Метод `/tokens/count`: https://developers.sber.ru/docs/ru/gigachat/api/reference/rest/post-tokens-count
- Тарифы: https://developers.sber.ru/docs/ru/gigachat/tariffs/individual-tariffs

## Стратегии контекста без summary

В [context-strategy-agent.js](./context-strategy-agent.js) реализован отдельный агент с переключателем:

- `sliding` — хранит только последние N сообщений, остальные удаляет;
- `facts` — хранит последние N сообщений и отдельный объект `facts`;
- `branching` — сохраняет checkpoint и независимые ветки диалога.

Для этого режима summary не используется.

### Автоматическое сравнение

Без API:

```bash
npm run strategy-demo
```

Реальное сравнение через GigaChat:

```bash
export GIGACHAT_AUTH_KEY="ваш_ключ_авторизации"
npm run strategy-demo:secure
```

Перед реальным тестом программа предупредит примерно о 40 запросах и потребует ввести `ДА`. До подтверждения запросы не отправляются.

Один и тот же сценарий сбора ТЗ содержит 12 сообщений и 6 проверяемых фактов:

- цель;
- бюджет;
- срок;
- платформа;
- база данных;
- авторизация.

Ожидаемое поведение:

```text
Sliding Window: ранние факты теряются, но контекст минимальный.
Sticky Facts: факты сохраняются, расход токенов умеренный.
Branching: факты сохраняются в двух независимых вариантах, но расход максимальный.
```

### Интерактивный Sliding Window

```bash
CONTEXT_WINDOW_MESSAGES=6 \
npm run strategy-chat:secure -- --strategy=sliding
```

После каждого ответа в памяти остаются только последние 6 сообщений.

### Интерактивный Sticky Facts

```bash
CONTEXT_WINDOW_MESSAGES=6 \
npm run strategy-chat:secure -- --strategy=facts
```

Вводите важные данные в формате:

```text
Цель: сервис управления задачами.
Бюджет: 300 000 рублей.
Срок: 3 месяца.
Платформа: веб-приложение.
База данных: PostgreSQL.
Авторизация: JWT.
```

Команда `/facts` показывает отдельную key-value память. В API отправляются `facts + последние N сообщений`.

### Интерактивный Branching

```bash
npm run strategy-chat:secure -- --strategy=branching
```

Пример:

```text
Цель: разработать сервис управления задачами.
/checkpoint base
/branch web base
/branch mobile base
/switch web
Для web используем таблицы и боковое меню.
/switch mobile
Для mobile используем нижние вкладки и push-уведомления.
/state
```

Ветки `web` и `mobile` создаются из одного checkpoint и продолжаются независимо.

Команды:

- `/facts` — показать key-value память;
- `/state` — показать стратегию, ветки и сообщения;
- `/checkpoint NAME` — сохранить checkpoint;
- `/branch NAME CHECKPOINT` — создать ветку;
- `/switch NAME` — переключить активную ветку;
- `/exit` — завершить интерактивный чат.

## Модель памяти ассистента

В [layered-memory-agent.js](./layered-memory-agent.js) реализован агент с тремя слоями памяти:

- `short` — краткосрочная память текущего диалога, последние сообщения пользователя и ассистента;
- `working` — рабочая память текущей задачи: цель, ограничения, временные требования;
- `long` — долговременная память: профиль пользователя, устойчивые предпочтения, решения и знания.

Слои хранятся отдельно в `memory-layers.json`:

```json
{
  "short": [],
  "working": {},
  "long": {}
}
```

Агент ничего не сохраняет в рабочую или долговременную память самовольно. Сохранение выполняется явно командами `/remember`.

### Быстрая демонстрация без API

```bash
npm run memory-demo
```

Демонстрация показывает:

1. Сохранение профиля и стиля в `long`.
2. Сохранение цели и ограничений задачи в `working`.
3. Попадание последних сообщений в `short`.
4. Ответ агента, который использует все три слоя.
5. Изменение рабочей памяти без изменения долговременной.

### Интерактивная демонстрация

Без API:

```bash
npm run memory-chat -- --mock
```

Через GigaChat:

```bash
export GIGACHAT_AUTH_KEY="ваш_ключ_авторизации"
npm run memory-chat:secure
```

Команды:

```text
/remember short ROLE TEXT
/remember working KEY VALUE
/remember long KEY VALUE
/memory
/forget working KEY
/forget long KEY
/clear-memory
/exit
```

### Тестовый сценарий для отчета

Шаг 1. Запустите:

```bash
npm run memory-chat -- --mock
```

Шаг 2. Сохраните долговременную память:

```text
/remember long profile Пользователь изучает backend и любит короткие практические примеры
/remember long style Отвечать по-русски, структурно, без лишней теории
```

Шаг 3. Сохраните рабочую память:

```text
/remember working goal Подготовить демо агента с memory layers
/remember working constraints Показать short, working и long память отдельно
```

Шаг 4. Создайте краткосрочную память обычным диалогом:

```text
Сейчас проверяем модель памяти.
Нужно показать, как разные слои влияют на ответ.
```

Шаг 5. Покажите все слои:

```text
/memory
```

Ожидаемо:

- `short` содержит последние сообщения диалога;
- `working` содержит `goal` и `constraints`;
- `long` содержит `profile` и `style`.

Шаг 6. Проверьте влияние памяти на ответ:

```text
Сформируй план демонстрации и учти мои предпочтения.
```

Агент должен сослаться на профиль из `long`, текущую цель из `working` и учитывать текущий диалог из `short`.

Шаг 7. Измените только рабочую память:

```text
/remember working goal Подготовить финальный отчет по памяти ассистента
Сформируй план еще раз.
```

Ожидаемо:

- цель изменилась;
- профиль и стиль из `long` остались прежними;
- короткая история в `short` обновилась последними сообщениями.

Итоговый вывод для отчета:

```text
Краткосрочная память отвечает за текущий диалог.
Рабочая память хранит данные активной задачи и может меняться от задачи к задаче.
Долговременная память хранит устойчивый профиль и предпочтения пользователя.
Слои разделены физически в JSON и подставляются в запрос явно.
```

## Персонализация ассистента

Персонализация построена поверх долговременной памяти:

- `long.userProfile` — профиль пользователя;
- `long.preferences` — стиль, формат и ограничения ответа.

Эти данные автоматически добавляются в каждый запрос через системный prompt.

Быстрое сравнение двух профилей:

```bash
npm run personalization-demo
```

Демонстрация запускает один и тот же запрос для двух пользователей:

- начинающий backend-разработчик;
- product manager.

Ожидаемо ответы отличаются стилем и форматом, хотя пользовательский запрос одинаковый.

Интерактивно:

```bash
npm run memory-chat -- --mock
```

Сохраните профиль:

```text
/profile name=Михаил; role=начинающий backend-разработчик; level=junior; goal=собрать пет-проект
```

Сохраните предпочтения:

```text
/preferences style=простыми словами, практично; format=короткие шаги и пример команды; limitations=без длинной теории
```

Проверьте:

```text
/memory
Персонализируй объяснение: зачем агенту компрессия истории?
```

Итог для отчета:

```text
Профиль и предпочтения хранятся в долговременной памяти отдельно от текущей задачи и текущего диалога.
Ассистент автоматически подключает профиль к каждому запросу и адаптирует стиль, формат и ограничения ответа под пользователя.
```

## Task State Machine

В [task-state-machine-agent.js](./task-state-machine-agent.js) реализован конечный автомат задачи:

```text
planning -> execution -> validation -> done
```

Состояние хранится отдельно в `task-state.json`:

```json
{
  "phase": "execution",
  "currentStep": "Собрать требования",
  "expectedAction": "Выполнить текущий шаг.",
  "paused": false
}
```

Быстрая демонстрация:

```bash
npm run task-demo
```

Демо показывает:

1. Создание задачи на этапе `planning`.
2. Переход `planning -> execution`.
3. Паузу на этапе `execution`.
4. Перезапуск агента с тем же JSON-состоянием.
5. Продолжение без повторного объяснения задачи.
6. Переход `execution -> validation -> done`.

Интерактивный запуск:

```bash
npm run task-chat -- --mock
```

Через GigaChat:

```bash
export GIGACHAT_AUTH_KEY="ваш_ключ_авторизации"
npm run task-chat:secure
```

Команды:

```text
/start TASK | step1; step2; step3
/state
/transition PHASE NOTE
/advance NOTE
/pause REASON
/resume
/exit
```

Сценарий для демонстрации:

```text
/start Подготовить README | Собрать требования; Написать раздел запуска; Добавить проверку результата
/state
/advance План согласован
/pause Пользователь ушел на созвон
/exit
```

Запустите агент снова:

```bash
npm run task-chat -- --mock
```

Проверьте восстановление:

```text
/state
/resume
Продолжай
```

Ожидаемо агент продолжит с этапа `execution`, текущего шага `Собрать требования`, без повторного описания задачи.

Итог для отчета:

```text
Задача представлена как конечный автомат с phase, currentStep и expectedAction.
Состояние сохраняется в JSON, поэтому агент может быть остановлен и продолжен без потери этапа.
Пауза фиксирует, где остановились и какое действие ожидается дальше.
```

## Контролируемые переходы состояний

У Task State Machine есть явная таблица разрешенных переходов:

```text
planning -> execution
execution -> validation
validation -> done
done -> []
```

Запрещено перепрыгивать этапы:

- нельзя `planning -> validation`;
- нельзя `planning -> done`;
- нельзя `execution -> done`;
- нельзя менять этап, пока задача на паузе.

Быстрая проверка:

```bash
npm run task-demo
```

В выводе будут блоки:

```text
=== Недопустимый переход planning -> validation ===
=== Недопустимый переход planning -> done ===
=== Недопустимый переход execution -> done ===
=== Недопустимый переход во время паузы ===
```

Интерактивно:

```bash
npm run task-chat -- --mock
```

Сценарий:

```text
/start Demo | plan; code; test
/transition done Попытка сразу завершить
/transition validation Попытка пропустить execution
/transition execution План утвержден
/transition done Попытка завершить без validation
/pause Перерыв
/transition validation Попытка перейти во время паузы
/resume
/advance plan done
/advance code done
/advance test done
/transition done validation ok
```

Ожидаемо:

- первые два перехода отклоняются, потому что из `planning` можно только в `execution`;
- `execution -> done` отклоняется, потому что перед `done` нужна `validation`;
- переход во время паузы отклоняется до `/resume`;
- после выполнения шагов агент переходит в `validation`;
- после validation разрешен переход в `done`.

Итог для отчета:

```text
Жизненный цикл задачи контролируется конечным автоматом.
Переходы разрешены только по таблице planning -> execution -> validation -> done.
Ассистент не может перепрыгнуть этап, завершить задачу без validation или менять состояние во время паузы.
```

## Инварианты состояния

В Task State Machine добавлены инварианты задачи: правила, которые ассистент не имеет права нарушать.

Инварианты хранятся отдельно от диалога в `task-state.json` внутри поля `invariants`.

Примеры:

```json
[
  {
    "type": "fixed",
    "key": "архитектура",
    "value": "REST API",
    "description": "Архитектура зафиксирована: REST API"
  },
  {
    "type": "forbid",
    "key": "технология",
    "value": "GraphQL",
    "description": "GraphQL запрещен в этом проекте"
  }
]
```

Быстрая проверка:

```bash
npm run task-demo
```

В выводе будет блок:

```text
=== Конфликт запроса с инвариантом ===
```

Агент откажется заменить REST API на GraphQL и объяснит, какой инвариант нарушен.

Интерактивный сценарий:

```bash
npm run task-chat -- --mock
```

Введите:

```text
/start API проект | выбрать архитектуру; проверить ограничения
/invariant fixed архитектура REST API
/invariant forbid технология GraphQL
/invariants
Предложи GraphQL вместо REST
Предложи REST endpoints
```

Ожидаемо:

- `/invariants` показывает правила отдельно от сообщений диалога;
- запрос про GraphQL получает отказ;
- запрос про REST endpoints проходит, потому что не нарушает инварианты.

Итог для отчета:

```text
Ассистент работает в рамках заданных инвариантов.
Инварианты хранятся отдельно от диалога в состоянии задачи.
Перед ответом агент проверяет запрос на конфликт.
При нарушении правила агент отказывается и объясняет причину.
```

## Рой агентов

В [swarm-agent.js](./swarm-agent.js) реализован простой рой агентов:

- `SwarmCoordinator` — координатор, который управляет порядком работы;
- `PlannerAgent` — составляет план;
- `ExecutorAgent` — выполняет план;
- `ValidatorAgent` — проверяет результат;
- `CriticAgent` — ищет нарушения инвариантов;
- `MemoryAgent` — фиксирует состояние и ключевые решения.

Это уже не один agent с одним API-вызовом: у каждой роли отдельный `system prompt`, отдельный метод `run()` и отдельное место в маршруте сообщений. Координатор передает результаты между агентами и использует конечный автомат задачи `planning -> execution -> validation -> done`.

Быстрая демонстрация без API:

```bash
npm run swarm-demo
```

Интерактивная демонстрация без API:

```bash
npm run swarm-chat -- --mock
```

Реальная демонстрация через GigaChat:

```bash
export GIGACHAT_AUTH_KEY="ваш_ключ_авторизации"
npm run swarm-demo:secure
```

Интерактивная демонстрация через GigaChat:

```bash
export GIGACHAT_AUTH_KEY="ваш_ключ_авторизации"
npm run swarm-chat:secure
```

Перед реальными запросами программа требует ввести `ДА`. Без подтверждения запросы к API не отправляются.

`swarm-chat:secure` — интерактивный режим. Он не запускает автоматический сценарий: запросы отправляются только после ваших сообщений в терминале.

### Сценарий для отчета

Шаг 1. Запустите интерактивный режим:

```bash
npm run swarm-chat -- --mock
```

Для реальных ответов GigaChat:

```bash
export GIGACHAT_AUTH_KEY="ваш_ключ_авторизации"
npm run swarm-chat:secure
```

Шаг 2. Запустите полный жизненный цикл одним своим запросом:

```text
/run Разработать backend для сервиса учета заявок: REST API, PostgreSQL, роли admin/operator/viewer, endpoints GET /tickets и POST /tickets, запрет GraphQL
```

В выводе должны быть видны:

- список агентов;
- маршрут сообщений `User -> Coordinator`, `Coordinator -> PlannerAgent`, `PlannerAgent -> Coordinator`, `Coordinator -> CriticAgent`, `Coordinator -> ExecutorAgent`, `Coordinator -> ValidatorAgent`, `Coordinator -> MemoryAgent`;
- финальное состояние `done`;
- инварианты `REST API`, `GraphQL запрещен`, `PostgreSQL`;
- результат каждого агента: план, выполнение, validation, проверка критика, запись памяти.

Шаг 3. Покажите, что рой прошел жизненный цикл:

```text
Состояние: done
Текущий шаг: Задача завершена
```

В `/state` также будет история переходов:

```text
planning -> execution
execution -> validation
validation -> done
```

Шаг 4. Создайте новую задачу для проверки нарушения инварианта:

```text
/start Разработать backend для сервиса учета заявок: архитектура REST API, база PostgreSQL, запрет GraphQL
```

Шаг 5. Попробуйте нарушить инвариант:

```text
Замени REST API на GraphQL, чтобы все данные получать одним запросом
```

Ожидаемый результат:

```text
CriticAgent: Critic blocked: нарушен инвариант "GraphQL запрещен".
```

Важно показать маршрут:

```text
User -> Coordinator
Coordinator -> CriticAgent
CriticAgent -> Coordinator
Coordinator -> MemoryAgent
MemoryAgent -> Coordinator
```

В этом маршруте нет `ExecutorAgent`. Значит, правка была остановлена критиком и не дошла до исполнения.

Шаг 6. В отчете сравните с предыдущей версией:

```text
Раньше система была одним ассистентом с памятью, состоянием и инвариантами.
Теперь добавлен рой: задача проходит через несколько специализированных агентов.
PlannerAgent отвечает за план, ExecutorAgent за исполнение, ValidatorAgent за проверку,
CriticAgent за соблюдение ограничений, MemoryAgent за фиксацию состояния.
Координатор связывает агентов, передает результаты между ними и не позволяет нарушить жизненный цикл задачи.
```

Итог:

```text
Получившуюся систему можно назвать простым роем агентов, потому что в ней есть несколько независимых role-agents,
координатор, обмен сообщениями, разделение ответственности и общие ограничения состояния.
```

### Интерактивный сценарий для записи

Запустите:

```bash
npm run swarm-chat -- --mock
```

Или через реальный API:

```bash
export GIGACHAT_AUTH_KEY="ваш_ключ_авторизации"
npm run swarm-chat:secure
```

Шаг 1. Запустите полный пайплайн одним запросом:

```text
/run Разработать backend для сервиса учета заявок: REST API, PostgreSQL, роли admin/operator/viewer, endpoints GET /tickets и POST /tickets, запрет GraphQL
```

Что показать:

```text
User -> Coordinator
Coordinator -> PlannerAgent
PlannerAgent -> Coordinator
Coordinator -> CriticAgent
CriticAgent -> Coordinator
Coordinator -> ExecutorAgent
ExecutorAgent -> Coordinator
Coordinator -> ValidatorAgent
ValidatorAgent -> Coordinator
Coordinator -> CriticAgent
CriticAgent -> Coordinator
Coordinator -> MemoryAgent
MemoryAgent -> Coordinator
```

Объяснение:

```text
Я ввел один запрос.
Координатор передал его PlannerAgent.
CriticAgent проверил план на нарушение инвариантов.
ExecutorAgent выполнил план.
ValidatorAgent проверил результат.
CriticAgent проверил реализацию.
MemoryAgent зафиксировал итог.
```

Шаг 2. Покажите состояние:

```text
/state
```

В `transitionHistory` должны быть переходы:

```text
planning -> execution
execution -> validation
validation -> done
```

Шаг 3. Создайте новую задачу для проверки инварианта:

```text
/start Разработать backend для сервиса учета заявок: архитектура REST API, база PostgreSQL, роли admin/operator/viewer, запрет GraphQL
```

Покажите инварианты:

```text
/invariants
```

Шаг 4. Попробуйте нарушить инвариант:

```text
Замени REST API на GraphQL, чтобы все данные получать одним запросом
```

Ожидаемый результат:

```text
CriticAgent: Critic blocked: нарушен инвариант "GraphQL запрещен".
```

Важно показать маршрут:

```text
User -> Coordinator
Coordinator -> CriticAgent
CriticAgent -> Coordinator
Coordinator -> MemoryAgent
MemoryAgent -> Coordinator
```

Здесь нет `ExecutorAgent`, значит запрещенная правка не была выполнена.

Шаг 5. Покажите, что корректная правка проходит дальше:

```text
Оставь REST API и добавь POST /tickets для создания заявки с title, description, priority
```

Ожидаемый маршрут:

```text
User -> Coordinator
Coordinator -> CriticAgent
CriticAgent -> Coordinator
Coordinator -> PlannerAgent
PlannerAgent -> Coordinator
Coordinator -> CriticAgent
CriticAgent -> Coordinator
```

Если задача уже находится в `execution`, корректная правка идет через:

```text
CriticAgent -> ExecutorAgent -> MemoryAgent
```

Шаг 6. Завершите:

```text
/exit
```

Короткий вывод для отчета:

```text
В интерактивном режиме пользователь сам запускает пайплайн роя.
Один запрос проходит через PlannerAgent, CriticAgent, ExecutorAgent, ValidatorAgent и MemoryAgent.
Координатор переводит задачу по жизненному циклу planning -> execution -> validation -> done.
При нарушении инварианта CriticAgent блокирует предложение, MemoryAgent фиксирует отказ,
а ExecutorAgent не вызывается. Это показывает, что ограничение реально влияет на работу роя.
```

## MCP-подключение

В проект добавлен минимальный локальный MCP-пример на официальном SDK `@modelcontextprotocol/sdk`.

Файлы:

- [mcp-server.js](./mcp-server.js) — локальный MCP-сервер через stdio;
- [mcp-client.js](./mcp-client.js) — MCP-клиент, который запускает сервер, подключается к нему и вызывает `listTools()`;
- [mcp-agent.js](./mcp-agent.js) — агент, который подключается к MCP, вызывает инструмент и использует результат.

Сервер регистрирует три инструмента:

- `echo` — возвращает переданный текст;
- `project_info` — возвращает краткую информацию о проекте;
- `git_status` — возвращает статус Git-репозитория.

Запуск проверки:

```bash
npm run mcp-tools
```

Ожидаемый вывод:

```text
MCP-соединение установлено.
Найдено инструментов: 3
- echo: Возвращает переданный текст без изменений.
- project_info: Возвращает краткую информацию о demo-проекте.
- git_status: Возвращает статус Git-репозитория для указанной папки.
```

Что демонстрируется:

```text
Клиент поднимает MCP-сервер через StdioClientTransport.
Соединение устанавливается через client.connect().
Список инструментов возвращается через client.listTools().
```

## Первый MCP-инструмент

Инструмент `git_status` оборачивает локальный Git API.

Регистрация находится в [mcp-server.js](./mcp-server.js):

```js
server.registerTool("git_status", {
  description: "Возвращает статус Git-репозитория для указанной папки.",
  inputSchema: {
    cwd: z.string().default("."),
    includeUntracked: z.boolean().default(true)
  }
}, async ({ cwd, includeUntracked }) => {
  // вызывает git status --short и возвращает JSON
});
```

Входные параметры:

- `cwd` — путь к Git-репозиторию;
- `includeUntracked` — показывать ли untracked-файлы.

Запуск агента:

```bash
npm run mcp-agent
```

Ожидаемый вывод:

```text
MCP-соединение установлено.
Агент вызвал MCP-инструмент git_status.
Репозиторий: .
Ветка: main
Рабочее дерево чистое.
```

Если есть незакоммиченные изменения, агент использует результат инструмента и перечислит их:

```text
Есть изменения: M README.md, ?? new-file.js
```

Что демонстрируется:

```text
Агент подключается к MCP-серверу.
Проверяет, что инструмент git_status доступен.
Вызывает client.callTool({ name: "git_status", arguments: ... }).
Получает JSON-результат от инструмента.
Использует результат в финальном ответе пользователю.
```
