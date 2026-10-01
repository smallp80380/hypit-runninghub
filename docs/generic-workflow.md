# Generic native workflow operation (@0.0.4 development)

This account Provider accepts a saved workflow ID or full API-format graph per request. No configured graph, descriptor, Model registration, prompt, media role or reference cardinality is required. Backend node availability and custom input semantics remain RunningHub responsibilities.

## Public contracts

`@local/provider-runninghub/generic` exports the public nominal `workflowManifest`, `workflowComponent`, `workflowFragment`, Capability/Type/Producer references, request/result validators and `createWorkflowProvider`. SDK imports use only public Distribution subpaths. This custom Module uses `ModuleManifest`, `TypeValidatorFacet`, `ProducerFacet` and `sealGraphFragment`; it does not use the exact-generation port/result shape.

Config `hypit-runninghub.config@2` is account-only: the usual CredentialRef, official base origin, COINS_ONLY gate, shared capacity/transport and native legacy-upload/legacy-create/V2-query protocols. `examples/generic-config.json` is disabled and unreviewed. Existing config @1 and descriptors/bindings @1/@2 retain their behavior.

`hypit-runninghub.request@1` contains explicit `workflowId`, optional `workflowJson` string, `nodeInfoList`, ordered `{key,blob}` files, `{fileKey,nodeId,fieldName}` bindings and a private owner-review path. Native `workflow:string` overrides the still-required workflowId. All field values retain their canonical JSON type, including arrays/objects/false/null/zero. Existing nodes may receive new optional input fields; the backend validates their semantic correctness. Duplicate targets are rejected because no collision precedence is assumed. One uploaded file may bind multiple fields. Zero/multiple files and previously unseen workflow IDs/graphs are ordinary requests. Byte/depth budgets apply; there is no provider media-count cap.

`hypit-runninghub.result@1` contains taskId, ordered outputs with BlobRef/extension/safe metadata and safe reported usage. It collects all query files, including >20, mixed media/binary formats and unknown extensions. Actual safe response Content-Type is preserved (e.g. text/csv); missing Content-Type becomes application/octet-stream. Empty SUCCESS is an explicit empty collection. No required video/image/audio result or default dropping policy is applied. Metadata strips credentials and URLs; signed URLs and raw query remain only in private bounded journals. Download origin/redirect/size limits remain enforced; collection never sends API credentials to output URLs.

## Review and durable effects

`REVIEWED_WORKFLOW_OPERATION@1` binds account/ref/actual key hash, semantic request digest (file key/MIME/size, excluding ephemeral ResourceStore IDs), source graph digest, ordered content hashes, Membership source, reviewer and expiry. It is an explicit owner assertion about the operation, not backend entitlement proof or workflow registration. NORMAL accountStatus is consistency only; it never proves Membership. Actual key/source/file checks and fresh account preflight precede uploads/create. Positive Money usage fails while preserving the private query observation and receipt.

Generic state uses account instance + Runtime operation, independent of workflow ID/graph. Its fingerprint binds request/key/account; changed inputs or credentials cannot start a new series through another path. ACK resumes without new upload/create; unknown/in-flight state blocks a new series. Existing durable action machine enforces three TOTAL transient-only attempts for each upload/create series. All input files are admitted before the first upload, checked sequentially without retaining every file's bytes, then reread/hash-checked at upload. Exact returned fileName is mapped without normalization.

`maxRequestBytes` is <=4 MiB; journal budget is <=64 MiB and must cover request serialization and raw response envelope. Worst-case mapped filenames are checked before upload using the client's 4096-character durable-state limit (not an upstream promise). Private state is 0600 in 0700 directories. Container signature checks verify format prefixes, not full decoding, archive contents or backend custom node behavior. Documented upload families: PNG/JPEG/WEBP, MP3/WAV/FLAC, MP4/AVI/MOV/MKV and image ZIP archives, <=30 MiB per file. ZIP is never locally extracted.

## Gate status

Generic own-JSON import/edit and Author binding/projection bridge are implemented. One Provider activation supplies @local/provider-runninghub@1. Normal installed candidate proof completes 0/1/3/12/35-file Builds and composite get exports all results; final archive is independently audited and rerun. No real API, credentials or paid generation has been used in this phase. Neither this document nor disabled examples authorize execution.
