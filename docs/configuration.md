# Endpoint configuration — Provider v0.1.2

Generic config@2 is account-only and serves both Workflow/App capabilities: see [contracts and CLI](generic-workflow.md), [schema](../schemas/endpoint-config-v2.schema.json), [workflow reuse](REUSE_RU.md). Reviews are per-operation, not liveBillingEvidence or descriptors.
Optional `accessPassword` is an exact `{store,key}` CredentialRef (each string 1–200 characters), resolved via a separately declared credential slot. Its reference/hash is review- and journal-bound; never put literal passwords into requests or authored JSON. One Endpoint has one password reference. Legacy config@1 does not accept this option.
Both request formats allow optional `instanceType: default|plus|ultra`; omission is preserved, and a failure never chooses another tier. The App profile example binds both capabilities to one disabled Endpoint.

## Historical legacy config@1 / v0.0.3

# Historical endpoint configuration — v0.0.3

Config остаётся `hypit-runninghub.config@1`. Native descriptor/binding@2 добавляют source mode и audio; старые descriptor/binding@1 сохраняют saved-ID/image поведение. Схемы описывают package-owned поля, которые не являются автоматически RunningHub wire parameters. Runtime проверяет exact constraints, public SDK Types, digests, private paths и billing review.

| Поле | Смысл |
| --- | --- |
| family / baseUrl | Явный native-workflow или standard-model; allowlisted HTTPS RunningHub origins; Standard base с /openapi/v2 |
| apiKey | CredentialRef `{store,key}`, plaintext запрещён |
| keyType | User declaration; не определяется по secret |
| accountPreflight | read-only-required; native accountStatus с lowercase apikey |
| billingExpectation | Только COINS_ONLY / coins / require-provider-guarantee |
| liveBillingEvidence | none или dataRoot-relative private-file; произвольный verified flag запрещён |
| submissionEnabled | Явный boolean; true не заменяет review или spending scope |
| retry | Submit/upload maxAttempts=3 TOTAL и bounded exponential delays |
| polling | Interval, max elapsed и consecutive transient failures |
| http | Request/response/download limits и exact allowedDownloadHosts |
| paths.journalDirectory | Relative к Profile dataRoot |
| native | workflowDescriptor и exact legacy-filename / legacy-create / v2-query protocol selections |

[Core schema](../schemas/endpoint-config.schema.json), [disabled consumer Profile](../scaffold/profile.json), [Member review](member-binding.md). Activation читает выбранный descriptor и его graphFile относительно dataRoot; symlinks/hardlinks/traversal запрещены. Journal использует public Runtime operation и instance, не закрытый scheduler API. Shared host directories и Credential Stores не сканируются.

## Descriptor

Descriptor задаёт exact capability.module/name, portTable.model/result, graphFile и canonical graphDigest, workflowId, fixtureOnly, portTable и bindings. Name capability совпадает с portTable.model. Каждый named port имеет value kind/cardinality/explicit constraints; каждый itemIndex покрыт target `{itemIndex,nodeId,fieldName,expectedClassType}`. Scalar JSON type сохраняется, media transport — legacy-filename. Mapping на отсутствующий/неподходящий узел или connected field отвергается.

Descriptor@2 требует `sourceMode: saved-id|inline-json`, допускает image или audio media port и optional resultSelection. Saved-ID проверяет точный remote digest. Inline отправляет effective workflow JSON строкой, включая только declared substitutions; workflowId также передаётся по required table. Backend graph normalization и colliding override precedence не гарантированы. Rebuilt descriptor всегда новый review candidate.

[Descriptor@1 schema](../schemas/native-descriptor.schema.json), [descriptor@2 schema](../schemas/native-descriptor-v2.schema.json), [management API](workflow-management.md). Types/node defaults не выводятся из class names. Media signature admission не является полноценным decode.

## Registry

Full pinned registry — единственный источник Standard Model endpoints/schema parameters. Descriptor normalization и request planning бесплатны; executable Model API deferred под COINS_ONLY. `keyType` declaration, registry presence, pricing или NORMAL не открывают billing gate. Package не переключает native request на денежный API.

## Портативность

Обычный Hypit 0.2.16 предоставляет public SDK imports при загрузке установленного Provider/Model; tarball не копирует SDK. Standalone `rh-workflow` и `./workflow` работают через обычный Node. Consumer владеет Model, graph/descriptor, Source/Run, private binding, CredentialRef и Profile dataRoot. После переноса выбираются собственные credentials и новый review; hostStateRoot не копируется.
