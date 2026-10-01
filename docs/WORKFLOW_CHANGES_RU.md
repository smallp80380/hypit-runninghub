# Импорт и редактирование своего workflow — v0.0.4

## Свой JSON

API-format JSON запускается напрямую как per-request full workflow. Исходный файл сохраняется побайтово; локальный документ содержит source hash, graph digest, полный revision digest и parent chain. Граф не сохраняется в аккаунте RunningHub: API выполняет отдельный task.

```sh
npx --no-install rh-workflow import-native --input ./my-api.json --output ./before.document.json
npx --no-install rh-workflow inspect-native --input ./before.document.json
```

Если файл — ComfyUI UI JSON с nodes/links/widgets_values, импорт сохранит его с executionReady:false. Нужен API-format export либо проверенные node/widget contracts для конверсии. Positional widgets не доказывают names/defaults; custom nodes и seed-control slots не угадываются.

## Изменения

`edit-native` поддерживает setInput/connect/disconnect/add/replace/remove. setInput сохраняет любые JSON literals, включая arrays/objects/null/false/0, и позволяет новые поля существующего node. Connect задаёт source/outputIndex явно. Disconnect без value удаляет поле, с value подставляет указанное значение. Remove не переписывает похожие на links literal arrays; custom-node semantics остаются UNVERIFIED, поэтому владелец сам проверяет связанные inputs после структурных правок.

```json
[
  {"op":"setInput","nodeId":"YOUR_NODE","fieldName":"seed","value":42},
  {"op":"setInput","nodeId":"YOUR_NODE","fieldName":"labels","value":["first","second"]}
]
```

```sh
npx --no-install rh-workflow edit-native --input ./before.document.json --operations ./edits.json --expected-digest <DIGEST_FROM_INSPECT> --output ./after.document.json
npx --no-install rh-workflow export-native --input ./after.document.json --output ./my-edited-api.json
npx --no-install rh-workflow request-from-document --input ./after.document.json --workflow-id <EXPLICIT_SERVICE_WORKFLOW_ID> --output ./request.json
```

Writes используют новый файл и не перезаписывают originals. CAS сравнивает полный document digest, а не только graph hash. Новый граф/значения/files требуют нового owner review. Full JSON по официальному контракту overrides workflowId, но workflowId всё ещё required; CLI не подставляет 0 или чужой production ID.

Готовый request переносится в generic Author без нового descriptor/Model: [пошаговый guide](REUSE_RU.md). Старые import/apply/descriptor-rebuild остаются отдельным legacy strict editor для @1/@2.
