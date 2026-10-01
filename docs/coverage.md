# Coverage v0.0.4

Primary generic native operation accepts any API-valid ID/full JSON per request, arbitrary literals/files and heterogeneous ResourceStore outputs, without workflow registration. Normal installed mock proof covers 0/1/3/12/35 files, different workflows and 25 outputs. See [generic contract](generic-workflow.md) and [reuse](REUSE_RU.md). Backend availability, UI conversion and live price are unverified; Standard Money execution stays deferred.

## Legacy v0.0.3 coverage

# Покрытие v0.0.3

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
