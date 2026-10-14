# Hypit RunningHub Provider v0.0.4

Один account Endpoint выполняет API-доступные RHCoins workflows и AI Apps RunningHub по произвольному ID. Read-only fetch принимает также `/post/<id>` и `/ai-detail/<id>` на официальных HTTPS origins. Workflows принимают saved ID или полный API JSON; Apps — отдельный `webappId` и параметры загруженного интерфейса. Новый сервис не требует регистрации Model, descriptor или каталога.

Provider поставляет один generic nominal Module через public Hypit SDK. Результат — вся коллекция ResourceStore файлов и безопасных метаданных, включая смешанные image/audio/video/binary, неизвестные расширения и пустой результат. Обычный `hypit get` экспортирует composite directory с value.json и всеми файлами; отдельные outputs можно выбрать по индексу.

Проверено на Hypit 0.2.16 / Node 22: обычные установленные check/plan/doctor/pricing/Build/get с 0/1/3/12/35 файлами, разными saved-ID/inline workflows, 25 outputs и побайтовым экспортом. Все service calls перехвачены mock transport; backend availability, цена и качество RunningHub генерации этим не подтверждены.

Практические инструкции: [workflow перенос и запуск](docs/REUSE_RU.md), [редактирование](docs/WORKFLOW_CHANGES_RU.md), [Workflow/App контракт и CLI путь](docs/generic-workflow.md). Старые config/descriptor/binding @1/@2 и consumer scaffold сохранены.

## Официальные правила

Источник: [developer-kit README](https://github.com/HM-RunningHub/ComfyUI_RH_OpenAPI/blob/8f9c858e7e631a1c1c49df0c4defd77fdd690dd4/developer-kit/README.md); точная пользовательская рекомендация:

> Please read llms.txt and rh-api-contract.md in https://github.com/HM-RunningHub/ComfyUI_RH_OpenAPI/tree/main/developer-kit first. You must comply with the RunningHub API Integration Rules. Do not fabricate endpoints, parameter names, enum values, or response structures. Please use model-registry.public.json as the single source of truth for all available model endpoints and parameters. After reading, first explain your understanding of the integration process, and do not edit the code immediately.

Pinned commit: `8f9c858e7e631a1c1c49df0c4defd77fdd690dd4`. Source URLs/digests: [public manifest](sources/public-manifest.json). Разработка: [DEVELOPMENT.md](DEVELOPMENT.md). llms.txt/rh-api-contract.md относятся к Standard Model API; native Workflow и AI App contracts закреплены отдельно. Package Model registry остаётся источником описанных Standard Model endpoints/parameters, а не каталогом Apps.

## Покрытие

| Область | v0.0.4 |
| --- | --- |
| Native execution | Workflow ID/full API JSON и AI App ID/interface values; две capabilities одного account Endpoint |
| Входные файлы | PNG/JPEG/WEBP, MP3/WAV/FLAC, MP4/AVI/MOV/MKV, image ZIP; до 30 MiB каждый; без provider count cap |
| Результаты | Все query files как BlobRefs, фактический безопасный MIME, private raw query, safe metadata |
| Own JSON | Pure Node import/edit/export/request/author helpers и CLI; API literals сохранены, UI source сохранён с API-export-needed notice |
| AI Apps | ID/ai-detail URL → literal metadata → overrides/file bindings → `<AiApp>` → `run-ai-app`; без guessed enum/range/defaults |
| Standard Model / LLM | Требуют Enterprise-Shared по official key matrix; не включены в RHCoins execution |

Бюджеты JSON/state/response/download и безопасность URL остаются явными. Container prefix admission не проверяет полный файл или содержимое ZIP. Custom node semantics и output indices проверяет backend. UI JSON с positional widgets не конвертируется без подтверждённых node contracts.

## Review и восстановление

COINS_ONLY обязателен. Владелец отдельно проверяет actual Membership key, конкретный workflow/App, выбранные параметры, файлы и отсутствие consumeMoney/third-party Money. Кандидат review — **не разрешение**. Workflow и App reviews не взаимозаменяемы. NORMAL accountStatus и положительный баланс подтверждают лишь consistency, не Membership.

App metadata не раскрывает скрытый граф или version identifier. `appDigest` закрепляет только exact интерфейс; manual owner review — доверительный допуск, не серверная гарантия и не обнаружение hidden implementation changes. Без подтверждения владельца исполнение запрещено.

Optional `instanceType` — ровно `default|plus|ultra`, без default GPU или fallback. `accessPassword` хранится только в Endpoint CredentialRef/Store, его ref и actual hash закреплены review и attempt identity. Для другого пароля нужен другой Endpoint. Для незашифрованного App пароль не отправляется.

Journal identity — account instance + Runtime operation, общая для обоих сервисов. Changed request/key/password/kind не создаёт новую серию. Upload/submit имеют **3 попытки всего**, transient-only; ACK прекращает submit и допускает offline resume, unknown/in-flight блокирует новый бюджет. Перед каждым App submit повторно читается интерфейс; изменённый appDigest блокирует submit. Money usage сохраняется в private evidence и блокирует сбор. Credentials не передаются output hosts; server idempotency не заявлена.

## Установка

Ветка исходников содержит расширение Workflow/App; неизменённый архив в `artifacts/` — прежний sealed snapshot, не сборка этих изменений. Для App CLI и обеих capabilities сначала соберите архив из текущего source: `PROOF_DIR=$(mktemp -d /tmp/rh-provider.XXXXXX)` и `node tests/pack-release.mjs "$PROOF_DIR"`. Используйте полученный `local-provider-runninghub-0.0.4.tgz` в команде установки ниже; версия не bump-нута, публикация не выполняется.

```sh
npm install --ignore-scripts --legacy-peer-deps --save-exact ./vendor/local-provider-runninghub-0.0.4.tgz
npx --no-install rh-workflow --help
hypit check author.svml --workspace . --json
hypit plan run.svrun --runtime ./profile.json --workspace . --json
hypit doctor --runtime ./profile.json --workspace . --json
```

Один install поставляет Module `@local/provider-runninghub@1` и обе capabilities `run-workflow`/`run-ai-app`; отдельная Model package не нужна. SDK supplies установленный Hypit Distribution. Pure Node subpaths: `./workflow-document`, `./author-source`, `./review-candidate`, `./workflow`, `./ai-app-document`, `./ai-app-author-source`, `./ai-app-review-candidate`. Provider/Author SDK exports: `./generic`, `./ai-app`. Linux/WSL private files/directories проверены; Windows ACL не проверены. Npm publication и новые платные прогоны не выполнялись. Sealed artifacts сохранены.
