# Independent Subjects Registry API

The subject-finder, attendance, and parent-child applications read one independent SubjectRegistry over HTTP. The attendance database contains no subject catalog, subject face references, subject keys, or automatic roster import. Registry recognition returns suggestions and never writes attendance. Parent-child recognition identifies individuals and does not infer family relationships.

## Running and configuring the services

Start `SubjectRegistry` independently using its [service documentation](SubjectRegistry/README.md). The local HTTP service defaults to `http://127.0.0.1:3002`. Its database is `SubjectRegistry/.local-db/pgdata`, physically separate from `Backend/.local-db/pgdata`. Its Gitignored private `SubjectRegistry/.local-db/service-config.json` contains `readerKey`, `writeKey`, and `sourceId`. Neither that file nor reference images are served by the attendance app.

The local attendance launcher reads only the registry's `readerKey`; it does not start or seed the registry. `SUBJECT_REGISTRY_URL` and `SUBJECT_REGISTRY_READ_KEY` override this local configuration. Production requires both variables. Use HTTPS for remote transport; plain HTTP is supported only on loopback. The read credential stays in the server process and is sent in `X-API-Key` by the HTTP adapter, never browser code. The app does not use the write key.

## External writes belong to SubjectRegistry

Send source-scoped external updates directly to the registry service, not the attendance app. `PUT /api/subjects/external/olivia`, with a registry **write** key and `Content-Type: application/json`, accepts:

```json
{"name":"Olivia","active":true,"apps":["subject-finder","attendance","parent-child"],"image":"BASE64_JPEG_WITHOUT_DATA_PREFIX"}
```

`PATCH /api/subjects/external/olivia` preserves omitted fields. `{"active":false}` stops matching in every permitted application. `POST /api/subjects/external/olivia/references` with `{"image":"..."}` adds an idempotent reference. `DELETE /api/subjects/external/olivia` takes no body and physically deletes the subject, references, and application access. Registry audit metadata remains without face bytes. A source key can only manage its own external IDs, and the app's read key cannot write.

The authorized local Olivia import uses the existing external ID `team_olivia`. New-source `olivia` belongs to that new source and cannot update the imported identity. Names alone do not enroll a recognizable face; upload an authorized JPEG with one clear face. The registry validates face size and image limits before committing. Every committed identity update changes its catalog version; in-flight matching against an older catalog is invalidated.

Keys are provisioned using `SubjectRegistry/scripts/provision-key.mjs`, as documented in its README. The old `Backend/scripts/provision-subject-key.mjs` exits with relocation guidance and never opens the attendance database. Previously generated attendance `subjects_*` keys and its retired key file are not registry credentials.

## Cookie authenticated application routes

Teacher/admin browser clients call `GET /api/subjects?app=subject-finder` (also `attendance` or `parent-child`). The attendance server calls the registry using its read key and returns `{version,subjects:[{id,name,referenceCount}]}`. The UUID is the registry's stable subject identity. The response contains no face images or credentials.

`POST /api/subjects/detect` retains the attendance app's Origin and CSRF checks and accepts `{app,image,groupId?}`. The server forwards only `{app,image}` to registry recognition. A supplied `groupId` requires attendance course-manager permission before any remote recognition call. It does not restrict recognition to that course roster. Matching returns `{version,registeredReferences,matches:[{subjectId,name,personId,identityMatched,box,similarity,message}]}`. A verified identity displays `Got you, Olivia`; unknown identities have null names, subject IDs, and messages.

The optional `personId` mapping uses exact stable UUID equality with an active attendance person. When a group is provided that person must be an active roster member. Name equality and external source IDs never establish this mapping. An independently recognized subject can remain recognizable with `personId:null`.

Every request uses a fresh HTTP response; the attendance app has no registry gallery cache or local catalog fallback. Missing configuration, downtime, bad credentials, timeout, redirects, malformed responses, or oversized responses fail closed with a 503 error and no identity result. Requests have a 15-second timeout and a 1 MB response bound. Browser clients clear earlier recognition when a request fails. Credentials and service diagnostics are not included in responses.

## Validation

`node --test tests/subjects-api.test.mjs` from `Backend` starts real separate HTTP services with separate PostgreSQL-compatible databases. It verifies empty attendance subject storage, shared applications, authorization, direct external updates, immediate deactivation/deletion, in-flight invalidation, stable-ID mapping, service restart/outage, and bounded response failures. The test injects a deterministic image worker to exercise the HTTP boundary; it does not establish face-recognition accuracy or cloud PostgreSQL/Timescale behavior. SubjectRegistry's own tests verify its storage and key lifecycle.
