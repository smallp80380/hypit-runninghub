# Инструкции разработчику пакета

Рабочая граница: этот пакет и /tmp; no real credentials/env/live/paid calls. v0.0.4 account Endpoint обслуживает Workflow и AI App native routes с отдельными nominal request/review и общим durable lifecycle/result. Старые stage notes ниже — исторические, не новое spending permission.

## Обязательная рекомендация

Источник: официальный [RunningHub developer-kit README](https://github.com/HM-RunningHub/ComfyUI_RH_OpenAPI/blob/8f9c858e7e631a1c1c49df0c4defd77fdd690dd4/developer-kit/README.md); пользовательская точная формулировка:

> Please read llms.txt and rh-api-contract.md in https://github.com/HM-RunningHub/ComfyUI_RH_OpenAPI/tree/main/developer-kit first. You must comply with the RunningHub API Integration Rules. Do not fabricate endpoints, parameter names, enum values, or response structures. Please use model-registry.public.json as the single source of truth for all available model endpoints and parameters. After reading, first explain your understanding of the integration process, and do not edit the code immediately.

Read local pinned llms.txt и rh-api-contract.md полностью; затем exact registry entry и relevant native docs. Объяснить интеграцию и план перед integration code edits. Проверить digests в manifest. Полный registry — единственный источник Model API endpoints/params; capabilities overview и sample не заменяют exact entry. Различать Model API contract и Native Workflow docs.

## Публичный SDK

Использовать только `@hypit/hypit/model-kit`, `generation`, `endpoint-kit`, `runtime-kit`, при необходимости `author-kit`. Distribution devDependency — `@hypit/hypit@0.2.16`; не копировать `workspace:*` из monorepo примера. Проверять контракт по installed public exports, а не предполагать сигнатуры.

Подтверждено чтением владельца публичного Endpoint SDK: `EndpointStartContext` содержит `readonly operation: string`, `checkpoint?: (checkpoint: EndpointCheckpoint) => Promise<void>`. `EndpointPollContext` расширяет его и добавляет `handle`. `RuntimeAdapterFactoryContext` публично даёт `instance: string`, `dataRoot: string`, `hostStateRoot: string`. Переносимый journal использует `dataRoot`, instance и operation; не извлекать ID из закрытых scheduler/store APIs. Подробные evidence/digests в manifest и docs/contracts.md.

## Оплата и retry

- COINS_ONLY обязателен: consumeMoney generation запрещена; unknown/mismatch blocks до upload/submit. Money fallback и monetary Model execution запрещены. Новых paid Builds этой разработки не авторизовано; child live calls запрещены.
- Отдельные поля family/keyType/billingExpectation/liveBillingEvidence не создают entitlement и не принуждают RunningHub к ledger. Предыдущая Coins observation или post-task usage не являются pre-submit proof.
- Принять только реализованный verifier документированной official pre-submit Coins guarantee для exact account/key/workflow/params; Membership Coins promise документирован, но NORMAL не доказывает принадлежность конкретного ключа к Membership, поэтому NORMAL-only routes disabled; explicit reviewed private Member binding допускает scoped native route по manual trust contract. Не добавлять обход report-only или acceptance неизвестного bill.
- Official submit/upload policy: до 3 total attempts с exponential backoff для transient failures. Применять эту последнюю поправку пользователя; старое правило zero retries не является default нового пакета.
- Deterministic business error, включая BILLING_UNKNOWN/BILLING_MISMATCH/COINS_ONLY_UNVERIFIED, запрещает retry даже при transient-looking HTTP status. Нельзя выдумывать idempotency key, перечислять серверные status aliases без источника или переключать account/API/model/GPU после ошибки.
- Сохранять attempt intent до вызова; каждый ответ/ошибку и полученный ID — после. Полученный ID прекращает submit. Crash/restart не создаёт новый бюджет retries. No live calls в текущей разработке.

## Данные и проверки

- Только CredentialRef в config; не искать .env, cookies, auth stores или существующие secrets. `keyType` — user declaration, не эвристика по ключу.
- Named reference mapping должен сохранять все roles, порядок/индекс и metadata, когда exact Model их требует. Unsupported metadata отклонять до upload. Нельзя заменять unknown duration числом из planning.
- Не отдавать ключ внешнему download host, не сохранять signed URLs в public receipt/progress. Private durable evidence permissions: directories 0700, files 0600; public sanitized response отдельно. `raw_response` сохранение не означает permission печатать его.
- На будущих stages разрешены meaningful offline mocks и isolated consumer checks. Live smoke, uploads, paid tasks и publication требуют отдельного scope.
- AI Apps: metadata — интерфейс, не полный граф. appDigest не обнаруживает hidden implementation change; нужен manual owner review ключа/App/params/no-external-Money. Workflow review не авторизует App. Model/LLM Enterprise-Shared routes не включать в RHCoins execution.
- Проверка расширения: `node --import ./tests/sdk-register.js tests/ai-app.test.js` плюс прежние suites. Паковать в новый `/tmp` directory через `tests/pack-release.mjs`; запускать `tests/installed-generic-proof.mjs` и `tests/installed-hypit-proof.mjs` на новом tarball. Не перезаписывать sealed artifacts; не bump/publish.
- Schema regressions compile the published draft-2020-12 App schemas with the pinned `ajv` devDependency; both official origins and trailing-slash spellings must agree with runtime admission, without widening the origin allowlist.
- Не менять root packages/node_modules/workflows/.hypit/renders/profiles/assets/scripts/.env или официальный Hypit skill. Проверять diff только этого каталога; не staging/commit чужие изменения.

## Обновление источников

Обновление registry/docs — явный новый pin с commit/digests. Просмотреть schema changes, пересобрать только allowlisted exact capabilities, проверить каждый mapping и обновить coverage. Не синхронизировать latest автоматически при submit; непроверенные endpoints остаются unsupported. Website snapshots имеют retrieved date/modified date и raw source hash; это evidence чтения, не release authority сервиса.

## Stage 3 review boundary

Public Native activation/model/endpoint factories разработаны against SDK0.2.16; native lifecycle проверен только с injected mocks. Unknown/unreviewed Coins routes остаются закрытыми; reviewed scoped Member route executable. NORMAL нельзя переводить в Membership; candidate evidence не даёт spending authority. Не читать .env/keys и не повторять root paid verification. Package exports/tarball/consumer checks относятся к stage5.

Member binding: explicit trusted human project review + pinned provider Membership contract + private actual-secret hash/exact scope/expiry; не fabricate NORMAL=>Member. Project descriptors/graphs/evidence/journals в dataRoot, не machine hostStateRoot. POSIX permissions only; native Windows ACL coverage не заявлять. Child session не выполняет paid smoke/credentials/live calls. Пользователь отдельно разрешил root одну logical paid проверку после stage5 готового пакета; official transient3TOTAL policy сохраняется.
