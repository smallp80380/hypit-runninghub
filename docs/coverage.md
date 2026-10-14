# Coverage — Provider v0.1.2

Primary account config@2 accepts arbitrary API-accessible Workflow IDs/full graphs and AI App IDs/fetched interfaces without per-ID Model registration. The result remains ordered heterogeneous ResourceStore files, including an empty collection. Workflow file-count/output coverage and App interface/review/password/retry boundaries are exercised with mocks only. See [Workflow/App contract and CLI](generic-workflow.md) and [workflow reuse](REUSE_RU.md).

“All services” means the published RHCoins Workflow/AI App API families, not UI automation or Enterprise-Shared-only Standard Model/LLM execution. No runtime catalogue implies account availability or billing proof. Backend access to each App, hidden implementation changes, live price, generation quality and actual account charges remain unverified. Owner review must deny anything whose no-external-Money contract cannot be confirmed.

## Historical legacy coverage — v0.0.3

# Историческое покрытие v0.0.3

| Операция | Реализовано и проверено | Ограничения |
| --- | --- | --- |
| Native saved-ID | Consumer Model, named ports, remote template digest preflight, reviewed Member route, durable start/poll/collect | Account consistency не доказывает Membership; необходим scoped human review |
| Native inline-json | Полный effective API graph string и совпадающий nodeInfoList | Offline mocks; реальное backend исполнение/normalization нового режима не проверено |
| Native inputs | Text/number/boolean/enum scalars; image PNG/JPEG/WEBP; audio MP3/WAV; size/role/MIME/header admission | ≤30 MiB; один media role на порт; metadata/itemFields и video/first/last-frame refs не реализованы |
| Native outputs | Image JPG/PNG или video MP4; явный mixed output selection@2 | Неизвестные расширения/overflow/пустой selected result блокируются; audio output generation отсутствует |
| Workflow SDK/CLI | Immutable import/inspect/diff/edit/export, persistent CAS, structural descriptor candidate, configured free fetch | API-format только; input arrays только connections; custom-node semantic/server availability UNVERIFIED |
| Consumer scaffold | Descriptor-named single required ports, image+audio Source, prompt/seed/audioStart/duration, primary Blob output | Inert graph, execution disabled, no real binding; владелец создаёт точный Model contract |
| Standard Model | Pinned full registry 383 entries, reviewed schema/mapping 4 | Executable operations 0 при COINS_ONLY; остальные entries не поддержаны автоматически |

89 offline cases прошли. Обычный архивный consumer прошёл Hypit check/plan/doctor/pricing и mock Build с ResourceStore, двумя media uploads, одним inline create, mixed outputs и экспортом валидного H264 MP4. Doctor подтверждает configuration readiness; Pricing возвращает resolved page, без числовой стоимости. Fully intercepted transport не доказывает живой backend или качество генерации.

Root отдельно подтвердил реальную saved-ID генерацию v0.0.2 и бесплатный configured fetch другого графа. Это отдельные наблюдения. Дополнительная paid inline/audio генерация не выполнена. Money fallback, автоматическая смена account/API/Model/protocol, undocumented server graph save и server idempotency не заявлены.

Источники: [public manifest](../sources/public-manifest.json). Контракты: [workflow management](workflow-management.md), [member binding](member-binding.md).
