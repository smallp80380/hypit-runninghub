# Development source and sealed snapshot 0.0.4

The source tree includes the Workflow/App account Endpoint extension and its development tests. The unchanged archive under `artifacts/` is the earlier sealed Workflow snapshot, not a build of the current source changes. Build a new archive into a fresh temporary directory with `node tests/pack-release.mjs <directory>` when testing or installing the extension. Credentials, production media, Runtime journals, and internal review reports are not distributed.

Package SHA256: `a1650fa6a13c98d077191e167b5f86cd290e82f7b8de6f2e15a2d6a3ca211042`.

The package remains private in npm metadata; install the archive as described in docs/REUSE_RU.md. Public GitHub hosting does not publish it to npm.

Development tests use Hypit 0.2.16. Set `HYPIT_SDK_ROOT` to your installed Distribution directory when it differs from the development loader default.
