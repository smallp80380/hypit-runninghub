# Перенос и собственный workflow — v0.0.4

Нужно: Node 22+, установленный Hypit 0.2.16, архив Provider и ваш API-format workflow JSON. Один Provider подходит для разных запросов; число файлов и обязательные prompt/image/audio ports не задаются пакетом.

## 1. Установить и импортировать

```sh
npm install --ignore-scripts --legacy-peer-deps --save-exact ./vendor/local-provider-runninghub-0.0.4.tgz
npx --no-install rh-workflow import-native --input ./my-api.json --output ./workflow.document.json
npx --no-install rh-workflow request-from-document --input ./workflow.document.json --workflow-id <EXPLICIT_SERVICE_WORKFLOW_ID> --values ./values.json --output ./request.json
```

`values.json` содержит только nodeInfoList/files/bindings/review. CLI готовит draft: files могут быть пустыми до добавления настоящих Author File edges; Provider принимает только finalized request с разрешёнными BlobRefs. Pure helper имеет явный option draft:true для такого режима. Пример с произвольным input field и одной картинкой:

```json
{
  "nodeInfoList": [{"nodeId":"YOUR_NODE","fieldName":"text","fieldValue":"Ваш текст"}],
  "files": [],
  "bindings": [{"fileKey":"portrait","nodeId":"YOUR_LOADER","fieldName":"image"}],
  "review": "reviews/operation.json"
}
```

Для workflow без файлов: files:[] и bindings:[]. Для нескольких файлов повторите entries с любыми уникальными fileKey; один key может привязываться к нескольким fields. Числа, boolean, arrays и objects остаются своим JSON типом. Workflow ID нужен явно даже при full JSON: это required service field, которое full workflow overrides.

UI-format JSON тоже сохраняется, но executionReady:false требует API-export или verified conversion. Исходник не меняется. Редактирование: [WORKFLOW_CHANGES_RU.md](WORKFLOW_CHANGES_RU.md).

## 2. Создать generic Author

`assets.json` задаёт ваши локальные файлы; пустой список подходит для zero-file запроса:

```json
[{"key":"portrait","src":"./assets/portrait.png","mediaType":"image/png"}]
```

`outputs.json` необязателен; имя произвольное, index относится к порядку query outputs:

```json
[{"name":"firstFile","index":0}]
```

```sh
npx --no-install rh-workflow author-from-request --input ./request.json --id job --files ./assets.json --outputs ./outputs.json --output ./author.svml
```

Author содержит generic Request JSON и настоящие Blob edges. В обычном Source можно также использовать `<File key="portrait" source={existingBlob}/>` для результата upstream компонента. Все file bindings сохраняют authored order. Отдельный consumer Model/descriptor не нужен; Module `@local/provider-runninghub@1` поставляет сам Provider.

`run.svrun`:

```xml
<?svml using="@hypit/run-markup@1"?>
<svrun version="1">
  <author source="./author.svml"/>
  <target output="job.result"/>
  <target output="job.firstFile"/>
</svrun>
```

Для zero outputs используйте только job.result; index projection требует существующий output.

## 3. Настроить account и подготовить review

Возьмите [generic-config.json](../examples/generic-config.json) как Endpoint config и [generic-profile.json](../examples/generic-profile.json) как portable Profile. `account-config.json` для review-candidate должен совпадать с embedded config вашего Profile. Оставьте submissionEnabled:false до owner review. Укажите свой CredentialRef `{store,key}` и точные разрешённые output hostnames. После собственной проверки принадлежности actual key к Membership задайте keyType=Consumer-Member; пример с unknown не даёт execution authority. Plaintext key в JSON запрещён. Profile имеет один Endpoint и binding:

```json
"bindings": {"@local/provider-runninghub@1#run-workflow":"runninghub.account"}
```

Endpoint config не содержит workflowDescriptor, graphFile или workflow whitelist. `paths.journalDirectory` относится к вашему private Profile dataRoot; этот каталог переносится с журналами при восстановлении, а не сбрасывается для retry.

Создайте отдельный `review-files.json` с теми же ordered keys и локальными paths; CLI проверит bytes/signatures/SHA:

```json
[{"key":"portrait","path":"./assets/portrait.png","mediaType":"image/png"}]
```

```sh
npx --no-install rh-workflow review-candidate --input ./request.json --config ./account-config.json --credential-sha256 <ACTUAL_KEY_SHA256> --files ./review-files.json --output ./review-candidate.json
```

CLI не читает secret и не запускает API. SHA берётся владельцем из того exact Credential Store key, который использует Profile. Для saved-ID request без inline JSON нужен также `--graph <CURRENT_API_GRAPH_FILE>`; его digest должен совпасть с текущим backend graph перед execution.

Кандидат намеренно UNREVIEWED. Владелец проверяет Membership key/source, граф, все параметры/файлы и отсутствие внешних Money charges. Только после этого его `.record` становится private review record: humanReview.kind=`project-owner-reviewed-membership-key-and-native-workflow`, собственные recordId/reviewer, reviewedAt и expiresAt в ISO UTC. Не копируйте synthetic offline records в реальные проекты. Review хранится по request.review относительно dataRoot: directory0700/file0600, либо0400. submissionEnabled:true не заменяет этот review и не даёт permission на spending.

Review digest фиксирует file key/MIME/size и отдельные exact byte hashes; ephemeral ResourceStore IDs не входят в owner review. Durable operation fingerprint сохраняет полный BlobRef/request/key/account, поэтому changed request или rotation не создаёт новую серию.

## 4. Проверить и выполнить в своём spending scope

```sh
hypit check author.svml --workspace . --json
hypit plan run.svrun --runtime ./profile.json --workspace . --json
hypit doctor --runtime ./profile.json --workspace . --json
hypit pricing run.svrun --runtime ./profile.json --workspace . --json
```

Doctor проверяет конфигурацию; pricing page не является numeric quote или spending authority. Подготовленный request и его стоимость владелец рассматривает отдельно. В этой разработке новых paid/live вызовов не было.

После вашей авторизации расхода:

```sh
hypit build run.svrun --runtime ./profile.json --workspace . --follow --json
hypit get <BUILD_ID> --output job.result --to ./all-results --workspace . --json
hypit get <BUILD_ID> --output job.firstFile --to ./first-file --workspace . --json
```

`all-results` — directory с value.json и всеми Resource файлами. Safe metadata сохраняет extension/usage, secret и signed URLs остаются private. Результаты могут быть mixed PNG/WAV/MP4/CSV/binary и пустыми; unknown extension не отбрасывается. Для воспроизведения/декодирования конкретных медиа нужен корректный backend output; generic Provider не обещает доступность custom nodes.

Old config/descriptor/binding @1/@2 остаются совместимыми. Root review и offline proof reports находятся отдельно от sealed archive. Package installation не меняет global SDK и не требует SDK test loader.
