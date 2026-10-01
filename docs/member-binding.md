# Reviewed Member binding

Native execution требует включённый submissionEnabled и действующую private reviewed Member запись. Descriptor@1 принимает только `REVIEWED_MEMBER_BINDING@1`; descriptor@2 требует `REVIEWED_MEMBER_BINDING@2`. Binding создаёт доверенный владелец consuming project после проверки ключа на Consumer-Membership и полного graph/descriptor на отсутствие внешней Money оплаты.

Это scoped human approval по [официальному Membership Coins contract](https://www.runninghub.ai/enterprise-api/consumerApi). NORMAL используется только как fresh account consistency, не Member enum или entitlement proof. Package не аутентифицирует человека криптографически и не обеспечивает backend billing enforcement.

## Привязка

| Поле | Проверка |
| --- | --- |
| credential.reference / sha256 | Точный CredentialRef и private SHA256 фактического runtime secret |
| family / baseUrl | native-workflow и точный официальный origin |
| workflow | workflowId, template graphDigest, descriptorDigest, scope=reviewed-native-only-no-external-money |
| workflow@2 | Дополнительно sourceMode и mappingPolicy=declared-port-inputs-only |
| source | Membership URL и pinned note SHA256 `becf0e9cb51ceee2460b77ebeddc394343e7e982f9fdbb029a3e6e4055386097` |
| humanReview / expiresAt | Kind, reviewer, recordId, canonical UTC times; review действителен сейчас |

Схемы: [binding@1](../schemas/member-binding.schema.json), [binding@2](../schemas/member-binding-v2.schema.json). Digest — локальная identity, не подписанный server token. Actual secret поступает только из Credential Store. Binding hash нельзя переносить в public repository или release archive. Inert examples не являются настоящим approval.

`liveBillingEvidence: {kind:"private-file",path:"private/member.json"}` указывает файл относительно Profile dataRoot. Leaf directory должна иметь mode 0700, файл 0400/0600, owner UID процесса; максимум 8192 bytes. Symlinks, hardlinks и traversal отвергаются. Descriptor/graph/journals также принадлежат dataRoot; machine hostStateRoot не используется. Native Windows ACL не проверены.

## Исполнение

1. Activation проверяет private structure/source/scope. Supports проверяет exact semantics, flag и свежесть local review; это configuration selectability до credential/account preflight.
2. Start фиксирует один runtime secret и identity операции. Перед новыми effects binding перечитывается, actual secret hash сверяется; `/uc/openapi/accountStatus` использует тот же secret и documented body field `apikey`. SHARED/unknown/неположительный или неизвестный remainCoins блокируют action.
3. Saved-ID проверяет exact remote template перед upload и каждой create attempt. Inline проверяет pinned local template. Все media references admitted до первого upload; freshness/expiry проверяются перед попытками.
4. Перед каждой новой create попыткой снова проверяются binding/account/source. Admission failure находится вне paid retry budget. Dynamic reviewed mapped inputs разрешены; static settings/structure/mappings/sourceMode/resultSelection требуют нового review.
5. Upload/create transient retries имеют durable 3 TOTAL budget. Known taskId resume не создаёт новую задачу; unknown crash outcome блокирует новую серию. Private checkpoint pins препятствуют смене key/request/template/wire при восстановлении.
6. Poll/collect сохраняют usage; positive consumeMoney/thirdPartyConsumeMoney блокируют дальнейшую обработку. Post-task usage не заменяет pre-submit approval.

Default disabled/unreviewed и Standard Model routes закрыты. Исторический ключ с декларацией Consumer-Member фактически оказался SHARED; декларация и Coins balance не являются proof. Отдельная оплата Build требует согласованного user scope. В child development были только inert synthetic credentials и mocks.
