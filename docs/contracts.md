# Generic v0.0.4 contracts

See [Workflow/App contracts and CLI](generic-workflow.md), exact request/result/review schemas and account config@2. One Provider install supplies Module `@local/provider-runninghub@1`, `run-workflow` and `run-ai-app`, with separate request/draft Types and common WorkflowResult/file projection. Pure preparation subpaths require no SDK.

App metadata uses documented `GET /api/webapp/apiCallDemo` with exact query apiKey/webappId and Bearer auth; submit is `POST /task/openapi/ai-app/run` with string webappId/nodeInfoList and optional instanceType/accessPassword. Shared uploads return filenames; query returns URL/outputType files, not invented inline result variants. Metadata curl is discarded; credential query URLs are never public.

App review pins fetched interface `appDigest`, not a complete hidden graph. A Workflow review cannot authorize an App. Both validators pin actual key/password hash, chosen values/tier, ordered file bytes, origin, Membership source and time. Manual review is owner trust, not a server billing/hidden-version guarantee. Standard Model and LLM APIs are excluded from RHCoins execution by the official key matrix.

## Legacy contracts

# Public contracts and lifecycle

v0.0.3 использует только public Hypit 0.2.16 imports: model-kit, generation, endpoint-kit, runtime-kit, author-kit и artifact. Consumer scaffold создаёт exact Model и markup Surface по declared descriptor ports. Обычный installed Distribution resolver предоставляет SDK; test loader используется только в development unit tests и не включён в archive.

Public EndpointStartContext предоставляет `operation` и `checkpoint`; RuntimeAdapterFactoryContext предоставляет project `dataRoot`, `instance` и machine `hostStateRoot`. Private provider journal использует dataRoot/instance/operation. State/credential files не ищутся в cwd, .env или hostStateRoot автоматически.

## Native wire

| Операция | Документированный protocol |
| --- | --- |
| Account consistency | POST /uc/openapi/accountStatus; body apikey |
| Read workflow | POST /api/openapi/getJsonApiFormat; apiKey/workflowId; code0/data.prompt JSON string |
| Upload | POST /task/openapi/upload; multipart apiKey/fileType=input/file; точный data.fileName |
| Create | POST /task/openapi/create; apiKey/workflowId/nodeInfoList; optional workflow string overrides workflowId |
| Query | POST /openapi/v2/query; taskId; bounded QUEUED/RUNNING/SUCCESS/FAILED handling |
| Download | HTTPS allowlisted output host, без API credential; bounded bytes/MIME/signature |

Bearer auth, exact endpoint paths, type preservation и response shapes закреплены в [public manifest](../sources/public-manifest.json). Legacy upload объявлен deprecated; package не меняет protocol автоматически. Есть 3 TOTAL transient attempts, durable task receipt и no-new-series unknown outcome; server idempotency не предполагается.

## Identity and review

GraphDigest — canonical API graph identity. Management revisionDigest — полный immutable envelope без собственного digest, включая parent/provenance. CAS uses revisionDigest. DescriptorDigest включает static graph pins, source mode, exact mapping/constraints и selection policy. Binding@2 связывает это с actual CredentialRef/hash, origin, Membership contract, review и expiry. Dynamic inputs в пределах declared ports законны; structural/static edits требуют нового review.

Prepared@2 journal pins credential/request identity, template/mode и exact wire/effective graph. Resume reconstructs graph по declared inputs и сверяет uploaded filenames с durable upload journals. Poll хранит bounded private observed URLs/types/usage; public handles/receipts не содержат signed URLs или secrets. ResourceStore возвращает declared Blob artifacts; collection сохраняет только selected results.

## Standard Model

llms.txt и rh-api-contract.md прочитаны целиком; pinned full registry содержит 383 entries. Четыре schemas/mappings reviewed, execution остаётся deferred under COINS_ONLY. Native Membership human trust не превращается в Standard Model entitlement. Не вводятся неизвестные enum/endpoint, Money fallback или automatic account/Model switches.

## Evidence limits

89 unit cases и normal installed Hypit mock Build проверяют transport/Runtime/ResourceStore/export. Check/plan/doctor означают configuration/semantic readiness; Pricing exposes source page без числовой стоимости. Live inline/audio/backend behavior, semantic custom nodes и качество generated assets не подтверждены. POSIX owner/mode checks проверены; native Windows ACL не заявлены.
