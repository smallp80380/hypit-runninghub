# Hypit RunningHub Provider v0.0.4

Один account Endpoint выполняет любой workflow, который принимает документированный native API RunningHub. Каждый запрос задаёт saved workflow ID или полный API JSON, nodeInfoList и файлы с привязками к node fields. Новый workflow не требует регистрации Model, descriptor или каталога. Prompt, image/audio, seed и число references не фиксированы.

Provider поставляет один generic nominal Module через public Hypit SDK. Результат — вся коллекция ResourceStore файлов и безопасных метаданных, включая смешанные image/audio/video/binary, неизвестные расширения и пустой результат. Обычный `hypit get` экспортирует composite directory с value.json и всеми файлами; отдельные outputs можно выбрать по индексу.

Проверено на Hypit 0.2.16 / Node 22: обычные установленные check/plan/doctor/pricing/Build/get с 0/1/3/12/35 файлами, разными saved-ID/inline workflows, 25 outputs и побайтовым экспортом. Все service calls перехвачены mock transport; backend availability, цена и качество RunningHub генерации этим не подтверждены.

Практические инструкции: [перенос, собственный JSON и запуск](docs/REUSE_RU.md), [редактирование](docs/WORKFLOW_CHANGES_RU.md), [generic контракт](docs/generic-workflow.md). Старые config/descriptor/binding @1/@2 и consumer scaffold сохранены.

## Официальные правила

Источник: [developer-kit README](https://github.com/HM-RunningHub/ComfyUI_RH_OpenAPI/blob/8f9c858e7e631a1c1c49df0c4defd77fdd690dd4/developer-kit/README.md); точная пользовательская рекомендация:

> Please read llms.txt and rh-api-contract.md in https://github.com/HM-RunningHub/ComfyUI_RH_OpenAPI/tree/main/developer-kit first. You must comply with the RunningHub API Integration Rules. Do not fabricate endpoints, parameter names, enum values, or response structures. Please use model-registry.public.json as the single source of truth for all available model endpoints and parameters. After reading, first explain your understanding of the integration process, and do not edit the code immediately.

Pinned commit: `8f9c858e7e631a1c1c49df0c4defd77fdd690dd4`. Source URLs/digests: [public manifest](sources/public-manifest.json). Разработка: [DEVELOPMENT.md](DEVELOPMENT.md). llms.txt/rh-api-contract.md относятся к Standard Model API; native Workflow contracts закреплены отдельно. Package Model registry остаётся единственным источником описанных Standard Model endpoints/parameters.

## Покрытие

| Область | v0.0.4 |
| --- | --- |
| Native execution | Per-request ID/full API JSON, произвольные JSON fieldValue и file bindings, один account Endpoint |
| Входные файлы | PNG/JPEG/WEBP, MP3/WAV/FLAC, MP4/AVI/MOV/MKV, image ZIP; до 30 MiB каждый; без provider count cap |
| Результаты | Все query files как BlobRefs, фактический безопасный MIME, private raw query, safe metadata |
| Own JSON | Pure Node import/edit/export/request/author helpers и CLI; API literals сохранены, UI source сохранён с API-export-needed notice |
| Standard Model | Pinned registry discovery; Money Model execution запрещено при COINS_ONLY |

Бюджеты JSON/state/response/download и безопасность URL остаются явными. Container prefix admission не проверяет полный файл или содержимое ZIP. Custom node semantics и output indices проверяет backend. UI JSON с positional widgets не конвертируется без подтверждённых node contracts.

## Review и восстановление

COINS_ONLY обязателен. Владелец отдельно проверяет actual Membership key, граф, параметры, файлы и отсутствие внешнего Money; кандидат review не является разрешением. NORMAL accountStatus подтверждает лишь consistency. Actual key hash, source graph и file bytes проверяются до effects. Positive Money usage сохраняется в private query evidence и блокирует сбор.

Journal identity — account instance + Runtime operation. Changed request/key не создаёт новую серию. Upload/create имеют **3 попытки всего**, transient-only; ACK прекращает submit, unknown/in-flight блокирует новый бюджет. API credential не передаётся output hosts. Server idempotency не заявлена.

## Установка

```sh
npm install --ignore-scripts --legacy-peer-deps --save-exact ./vendor/local-provider-runninghub-0.0.4.tgz
npx --no-install rh-workflow --help
hypit check author.svml --workspace . --json
hypit plan run.svrun --runtime ./profile.json --workspace . --json
hypit doctor --runtime ./profile.json --workspace . --json
```

Один Provider install поставляет generic Module `@local/provider-runninghub@1`; отдельная Model package не нужна. SDK supplies обычный установленный Hypit Distribution. Pure Node subpaths: `./workflow-document`, `./author-source`, `./review-candidate`, прежний `./workflow`. Provider/Author SDK exports: `./generic`. Linux/WSL private files/directories проверены; Windows ACL не проверены. Npm publication и новые платные прогоны не выполнялись. Sealed v0.0.2/v0.0.3 сохранены.
