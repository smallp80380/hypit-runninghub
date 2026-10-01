# Own workflow JSON v0.0.4

Primary import-native/edit-native/export-native/request-from-file/document preserve API literals and originals; UI source is retained non-executable until API export or verified contracts. See [edit guide](WORKFLOW_CHANGES_RU.md), [reuse](REUSE_RU.md) and [generic operation](generic-workflow.md). Legacy editor below remains compatible.

## Legacy management SDK / v0.0.3

# Proposed workflow management — v0.0.3 phase1

**Phases1–3 approved; v0.0.3 portable release awaits final parent review.** Descriptor@2 execution/audio/inline/free fetch are implemented and checked with offline mocks. Consumer scaffold and ordinary installed Hypit mock Build verify image/audio inputs, ResourceStore and MP4 export. Sealed v0.0.2 remains unchanged. Existing descriptor@1 and binding@1 saved-ID behavior remain unchanged.

## Local revisions and public interfaces

Planned pure SDK subpath `@local/provider-runninghub/workflow`:

- importWorkflow(graph, provenance) → immutable revision with canonical graph SHA256; API-format JSON only, no automatic UI-format conversion.
- inspectWorkflow(revision, nodeContracts?) → nodes/links/inputs and structural validation; semantic types/output-index upper bounds report UNVERIFIED without consuming node contracts.
- diffWorkflows(before, after) → exact class/input/connection changes, with hashes; do not print authored prompt/file contents by default.
- editWorkflow(revision, operations, expectedDigest, nodeContracts?) → atomic batch/new revision, never a mutated original. Typed setInput, connect, disconnect, add/replace/remove.
- persistRevision(projectDirectory, revision, expectedHeadDigest) → immutable graph/revision files plus atomic CAS head. Paths/no-follow/private file checks and lock apply; no global host directory writes.
- rebuildDescriptor(descriptor, revision) → updated graphFile/graphDigest and validated mappings; result is a new candidate descriptor, explicitly requires fresh human billing review. Hypit public SDK validates exact port semantics at Model/Provider activation.
- fetchWorkflow({workflowId,baseUrl,apiKey,requestTimeoutMs,maxResponseBytes}, {resolveCredential,fetch,clock}) → read-only fetched revision, no uploads/tasks. The caller resolves a declared CredentialRef; never read .env automatically or infer key names/types.

Exact function signatures may be consolidated at reviewed implementation. These are package-owned management APIs, not invented RunningHub endpoints.

Planned `rh-workflow` CLI subcommands: import, inspect, diff, apply, export, descriptor-rebuild, fetch. Ordinary Node22 CLI graph editing has no SDK loader dependency. Source and output/head paths must be explicit; fetch contacts only documented getJsonApiFormat on allowlisted official origins. CLI credential resolution accepts only explicitly configured `{store:"env",key:"NAME"}`; other stores require injected public API resolver. Secret never appears in command arguments, output JSON or source files. Fetch does not save changes remotely or enable generation. Native generation remains a Hypit Build operation.

## Graph coverage and edit rules

Graph keys are node IDs; node has class_type, inputs and optional _meta. Top-level input arrays are connection pairs [nodeId,outputIndex]; arbitrary literal arrays at this location remain outside the initial supported subset. Nested plain JSON objects are preserved as opaque literals, with safe JSON keys/depth/size checks. Schema resource bounds are package policy, not discovered RunningHub node limits.

Reject __proto__/prototype/constructor keys recursively, non-JSON values, malformed connections, missing source nodes, negative/unsafe indices, graph cycles, oversized/deep documents, invalid metadata, path links/traversal and CAS conflicts. Validation must use own properties and immutable copies. Schema alone cannot verify graph digest, DAG, connection semantics or class existence; runtime semantic checks remain required.

setInput changes a declared literal field with matching JSON type and optional explicit node constraints. connect uses explicit source node/index and target node/field; unknown output count/type cannot be guessed from class_type. It reports UNVERIFIED instead of inventing type compatibility. disconnect requires an explicit typed literal replacement or consumer-declared optional-input removal; no assumed defaults. remove refuses referenced nodes unless the same atomic batch explicitly rewires every affected reference. replace validates surviving connections against the supplied contract; no silent dropped mappings. Editor never auto-approves billing or backend custom-node availability.

## Sources and wire payload

Descriptor@2 adds sourceMode saved-id/inline-json and image-or-audio ports; existing workflowId, graphFile/graphDigest, capability and binding fields retain their names. graphFile is an immutable API-format graph; the revision envelope is metadata, not submitted as workflow.

Saved-ID: before new uploads/create, retrieve documented getJsonApiFormat for workflowId and compare exact template digest, then apply nodeInfoList as today.

Inline: pinned local template is the execution source. Build effectiveGraph by applying only declared scalar/media mappings; serialize this graph as documented workflow:string. workflowId is sent for the required table/provenance but does not select the effective graph when workflow is supplied. nodeInfoList explicitly repeats the identical mapped values (including seed), so the two fields do not contradict one another. Both are documented together in the English request example. No getJsonApiFormat check of the ignored ID is presented as proof of effective graph. No remote save/import/update endpoint is invented.

## Review and operation pins

REVIEWED_MEMBER_BINDING@2 pins actual credential hash/reference, origin, sourceMode, workflowId, template graphDigest, exact descriptorDigest and mappingPolicy=declared-port-inputs-only. Template graph includes all static nodes/links/settings; descriptor includes allowed ports/types/ranges/targets. Any structural/static/type/mapping/source-mode change invalidates review BEFORE upload. @1 records are not silently promoted to approve @2 or inline/audio coverage.

A prompt, image/audio reference or scalar value within the already-reviewed declared contract is a legitimate dynamic request and does not require review per value. Before any upload, persist operation identity with descriptor/template digest, mode, actual credential hash and resolved request. After uploads, persist exact prepared graph/body and effectiveGraphDigest privately; this contains real authored media filenames/scalars. Resume cannot adopt a different graph, key or request. Binding hash is private, not an entitlement API. NORMAL is only fresh consistency; SHARED/unknown/default bindings remain blocked.

Inline custom nodes can create outside charges; the consuming owner must review the complete template for no external Money billing under the official Membership contract. No runtime billingRoute string proves ledger enforcement. Standard Model execution remains deferred; no automatic API/key/model/protocol changes. Post-task usage and metadata are evidence, not pre-submit proof or100%settings guarantees.

## Audio and reusable consumer

First audio input coverage: MP3 audio/mpeg and WAV audio/wav ≤30MB using pinned legacy multipart apiKey/fileType=input/file and returned data.fileName exactly. The uploader is documented deprecated; no automatic switch to an unreviewed protocol. Role-aware filename extension, MIME/size/bytes validation and audio-specific port mappings are required. Mixed image/audio references map independently in declared order; no lost inputs. Audio output generation is not added.

The inspected other graph has LoadImage.image at306 and VHS_LoadAudioUpload.audio at317, a literal string field. This class-specific mapping comes from the user-supplied API graph, not an official promise that every audio loader shares the field. Prompt214.value, sampler295.seed, duration319.value and audioStart318.value must be reviewed by the consuming owner. Its duration/start connections and audio-derived length graph are preserved; no generic duration default/limit is invented. Its original girl/kitten singing prompt is not replaced with ROBO1 fight text.

Phase4 will ship a scaffold or generic Model author surface accepting named descriptor ports so another project does not copy the fixed3reference ROBO1 Model. Installed consumer uses inert local PNG+WAV, image/audio/prompt/seed/audioStart/duration ports and mock video output. Actual target workflow audio availability, custom-node/output types/assets and live inline execution remain unverified; no additional paid test is authorized.

## Verification gates

Phase2: positive immutable edits/import/diff, type refusals, cycles/missing refs, referenced-node removal, replacement mappings, dangerous keys/depth/size, concurrent CAS conflicts, no partial writes, actual installed offline CLI. Phase3: free fetch with inert env/custom resolver mocks, default/unknown/secret leakage refusals; saved-ID and inline exact wire, audio/image mapping, reviewed scopes/dynamic inputs/structural invalidation, durable3TOTAL retries, unknown outcome and resume. Phase4: all old regressions, normal installed CLI/Hypit mock Build, exported package APIs, archive digests/exclusions and portable source manifest. No live API or credentials in this development session.

## Phase2 actual commands and identities

Pure Node subpath `./workflow` and `rh-workflow import|inspect|diff|apply|export|fetch|descriptor-rebuild` are implemented. inspect/diff output field hashes instead of prompt/media contents. All management outputs retain semanticValidation=UNVERIFIED even when optional consuming node contracts check some fields; custom-node backend availability is not inferred.

Revision has separate revisionDigest (SHA of canonical full envelope excluding revisionDigest) and graphDigest (SHA of graph alone). parentDigest identifies the previous revision, not the graph content. CAS/head/CLI expected-digest use revisionDigest. Graph files deduplicate by graphDigest; revision envelopes/head use revisionDigest. A→B→A creates a new revision retaining B ancestry and rejects stale A CAS, while graph content can reuse the original immutable graph file. Schema@1 revision is still a proposed management contract, updated during parent review before any released implementation.

```sh
rh-workflow import --input api-graph.json --directory ./project --expected-head none
rh-workflow inspect --input ./project/.rh-workflows/REVISION_ID.revision.json
rh-workflow apply --input before.revision.json --operations edits.json --expected-digest REVISION_ID --directory ./project --expected-head REVISION_ID
rh-workflow diff --before before.revision.json --after after.revision.json
rh-workflow export --input after.revision.json --output new-api-graph.json
```

Directory must already exist, its realpath must match its absolute path. The dedicated .rh-workflows leaf uses owner-only0700 and files0600. Output files are new/no-clobber, written atomically via private incoming file and link; storage CAS commits head last after complete graph/revision persistence. Locks are not force-cleared after crashes. Manual recovery requires verifying no writer is alive and preserving the current head/revisions; no automatic stale-lock heuristic. POSIX/Linux/WSL only, Windows ACL unverified. Files containing symlinks/hardlinks, malformed or mismatching heads/revisions are refused. import does not upload, save remote graphs, resolve credentials or fetch backend schemas.

## Phase3 implemented APIs and limits

`fetchWorkflow(config, {resolveCredential, fetch, clock?})` requires the complete `hypit-runninghub.fetch@1` config and an injected resolver/transport. Resolver accepts exactly the configured CredentialRef and returns a secret string or `{secret}`; the SDK never inspects environment or credential stores. Resolver and HTTP calls each have a bounded timeout; response bytes and API graph JSON are bounded. No retry, upload, task creation, remote graph save or default credential guessing occurs. CLI fetch supports only explicit env store/key and writes a new revision only after successful fetch; custom stores use SDK injection. Failures omit upstream body/error text and secrets.

```sh
rh-workflow fetch --config explicit-fetch-config.json --output fetched.revision.json
rh-workflow descriptor-rebuild --input after.revision.json --descriptor before-descriptor.json --graph-file graphs/after.api.json --output candidate-descriptor.json
```

`rebuildDescriptor(descriptor, revision, graphFile, verifyTable?)` checks the new pinned graph and surviving mappings. It returns `{descriptor,reviewRequired:true,semanticValidation:"UNVERIFIED"}`. CLI writes the candidate descriptor and prints the review requirement; it does not copy old binding approval, authorize generation or silently remap removed nodes. Callers can supply the public SDK port verifier; ordinary standalone Node CLI performs structural candidate checks. Normal Hypit activation always requires the public SDK's exact port validator.

@2 descriptor runtime rejects unsafe/non-JSON keys, cycles and missing links using the bounded iterative graph validator. It allows one image or audio role per declared media port. Every @2 input is admitted before the first upload, then checked again from actual ResourceStore bytes at upload; PNG/JPEG/WEBP signatures and MP3 ID3/frame-prefix or WAV RIFF/WAVE signatures are checked along with role, MIME and ≤30MiB package limit. These checks identify headers and transport validity; they are not a full decoder or media quality check. Returned server fileName is mapped exactly.

Inline preparation snapshots the validated template and maps only declared inputs. It journals exact wire body, body digest, source mode, template digest and effective graph digest privately. Resume verifies all pins and reconstructs the effective graph from declared mappings to reject unrelated static edits even if checkpoint digests were rewritten consistently. Prepared scalar values must match the request; upload filenames are retained from the private durable upload results. The workflow string and nodeInfoList use identical values. Inline mode does not fetch the ignored ID; saved-ID retains exact remote template preflight before upload and each create attempt. Durable unknown-outcome and 3TOTAL retry rules apply to both modes.

Optional @2 `resultSelection` is package-owned consumer policy, not a fabricated server output enum:

```json
{"kind":"extensions","selectedOutputTypes":["mp4"],"ignoredOutputTypes":["png","mp3"],"maxSelected":1,"maxIgnored":2}
```

Available policy extensions are png/jpg/mp4/mp3/wav/flac/txt, based on documented file formats/extensions; their appearance in a particular task remains unverified. Selected types must match the declared image/video result. Every observed output must be explicitly selected or ignored, counts must fit limits and at least one selected output must exist. Default @2 and all @1 reject mixed outputs. The private results journal retains bounded observed output URLs/types and selected/ignored counts; public handles expose no signed URLs. Only selected outputs are downloaded, with MIME/signature/host checks and no credential forwarding.

Reproducible checks: `npm run test:workflow:v2` exercises inline/saved wire and public reviewed Provider mocks; `npm run test:workflow:installed` installs a development archive offline and exercises the actual installed CLI/public management export, including fetch through explicit inert env configuration and an injected network mock. Child development performs no live or paid API calls. Expanded inline/audio behavior remains unverified on RunningHub until a separately authorized live test.
