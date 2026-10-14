# Hypit RunningHub Provider v0.1.2 — release and publishing

The current source release is v0.1.2. It aligns the package version, install instructions, and bundled README while retaining the Workflow and AI App functionality. Download/install instructions are in [README.md](README.md); the [GitHub Release v0.1.2](https://github.com/smallp80380/hypit-runninghub/releases/tag/v0.1.2) contains the tarball and SHA-256 checksum asset.

Published [v0.1.1](https://github.com/smallp80380/hypit-runninghub/releases/tag/v0.1.1) and [v0.1.0](https://github.com/smallp80380/hypit-runninghub/releases/tag/v0.1.0), and the sealed [v0.0.4 snapshot](https://github.com/smallp80380/hypit-runninghub/releases/tag/v0.0.4), remain immutable history. The v0.1.1 archive keeps its older bundled README; its tag, assets, and checksum are not replaced. Use the repository README for current installation instructions.

The unchanged `artifacts/local-provider-runninghub-0.0.4.tgz` is the previously sealed Workflow snapshot, not a build of the v0.1.2 source. Its SHA-256 remains `a1650fa6a13c98d077191e167b5f86cd290e82f7b8de6f2e15a2d6a3ca211042`. Never overwrite it. Build test archives into fresh directories with `node tests/pack-release.mjs <directory>`. Credentials, production media, Runtime journals, and internal review reports are not distributed.

The package remains private in npm metadata; public GitHub releases do not publish it to npm. No npm publication, live calls, or paid builds are authorized by this release.

## Автоматическая сборка GitHub Actions

`.github/workflows/release.yml` запускается на каждом push в `main` без path-фильтров. Он устанавливает Node.js 22, pinned devDependencies и ffmpeg, выполняет все десять npm test suites, собирает свежий allowlisted tarball, проверяет его обычными installed consumer/runtime proofs, затем публикует tgz и SHA-256 checksum как Actions artifact. Build job имеет только `contents: read`; release job получает `contents: write` только после успешных тестов и proofs.

For a new package version, the workflow creates an immutable GitHub Release `v<package.json version>` from the exact tested commit, titles it `Hypit RunningHub Provider v<version>`, and explicitly marks that new release Latest. Repeated pushes for an existing version still build and upload the Actions artifact but do not move the tag, change the title, or replace assets. `workflow_dispatch` runs the same build; publication is enabled only on `main`, allowing safe retry after an external failure. API lookup distinguishes a missing release/tag from other errors and refuses if an existing tag points to a different tested commit. Npm publication is not performed.

For the next release, update `version` in `package.json`, both root version fields in `package-lock.json`, and the current release/install documentation in the same commit. Before packing, `tests/pack-release.mjs` verifies these versions and the README/PUBLISHING/REUSE release and archive paths agree; the workflow uses the tested checkout rather than a later `main`.

Development and release checks use Hypit 0.2.16. Set `HYPIT_SDK_ROOT` to the installed Distribution directory when it differs from the development loader default.
