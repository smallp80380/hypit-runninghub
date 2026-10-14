# Release v0.1.0 and sealed snapshot v0.0.4

The current source release is v0.1.0. It adds the native Workflow and AI App account Endpoint extension, AI App review/schema fixes, and automated GitHub Actions release builds. Download/install instructions are in [README.md](README.md); the [GitHub Release](https://github.com/smallp80380/hypit-runninghub/releases/tag/v0.1.0) contains the tarball and SHA-256 checksum asset.

The unchanged `artifacts/local-provider-runninghub-0.0.4.tgz` is the previously sealed Workflow snapshot, not a build of the v0.1.0 source. Its SHA-256 remains `a1650fa6a13c98d077191e167b5f86cd290e82f7b8de6f2e15a2d6a3ca211042`. Never overwrite it. Build test archives into fresh directories with `node tests/pack-release.mjs <directory>`. Credentials, production media, Runtime journals, and internal review reports are not distributed.

The package remains private in npm metadata; public GitHub releases do not publish it to npm. No npm publication, live calls, or paid builds are authorized by this release.

## Автоматическая сборка GitHub Actions

`.github/workflows/release.yml` запускается на каждом push в `main` без path-фильтров. Он устанавливает Node.js 22, pinned devDependencies и ffmpeg, выполняет все десять npm test suites, собирает свежий allowlisted tarball, проверяет его обычными installed consumer/runtime proofs, затем публикует tgz и SHA-256 checksum как Actions artifact. Build job имеет только `contents: read`; release job получает `contents: write` только после успешных тестов и proofs.

Для новой версии workflow создаёт immutable GitHub Release `v<package.json version>` из exact tested commit и прикладывает тот же tgz/checksum. Повторные push с уже опубликованной версией всё ещё собирают и загружают Actions artifact, но не перемещают tag и не заменяют assets. `workflow_dispatch` запускает ту же сборку; публикация включена только при запуске на `main`, чтобы безопасно повторить её после внешнего сбоя. API lookup отличает отсутствие release/tag от прочих ошибок и отказывает, если уже существующий tag указывает не на tested commit. Npm publication не выполняется.

Чтобы выпустить следующую версию, обновите `version` в `package.json` и согласованный root version в `package-lock.json` в том же коммите; workflow берёт версию из протестированного checkout, а не из позднее изменившегося `main`.

Development and release checks use Hypit 0.2.16. Set `HYPIT_SDK_ROOT` to the installed Distribution directory when it differs from the development loader default.
