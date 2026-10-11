# SubjectRegistry

An independent registry database and loopback HTTP service. Its schema has no attendance tables, attendance database pool, person links, or automatic roster imports. Locally it uses PostgreSQL-compatible PGlite with an atomic, durable snapshot at `SubjectRegistry/.local-db/pgdata/database.tar`. This is a separate physical database from `Backend/.local-db/pgdata`. Keys live only in the Gitignored `SubjectRegistry/.local-db/service-config.json`; responses and logs never return those keys.

For the complete local presentation, follow the root `npm ci`, `npm run setup`, `npm start` workflow. It starts this service with the attendance backend and provisions the four verified bundled demo identities only into a fresh empty catalog. It does not overwrite an existing catalog or resurrect deleted identities on restart. Reader/writer keys remain server-side in the private local configuration. The standalone commands below continue to support independent registry operation.

From this directory run `npm start` (default `127.0.0.1:3002`). An existing backend installation supplies the dependencies; independent installation also supports `npm install`. To explicitly import the authorized Olivia reference: `node scripts/start.mjs --olivia-photo <JPEG path> [--subject-id <existing UUID>]`. Only `team_olivia` is imported; no other identities are copied. Real JPEG validation requires exactly one sufficiently large face through the existing Python SFace worker. Failed validation does not write a subject.

All calls use `X-API-Key`. The backend keeps a **read** credential server side and calls `GET /api/subjects?app=subject-finder`, or `POST /api/subjects/detect` with `{ "app": "subject-finder", "image": "<base64 JPEG>" }`. Other supported apps are `attendance` and `parent-child`. Catalog subjects expose `id`, `name`, `externalId`, and `referenceCount`; detection matches expose `subjectId`, `name`, `identityMatched`, `box`, `similarity`, and the `Got you, <name>` message. Attendance person mappings belong to the backend, not this registry.

External sources receive a distinct **write** key and update only their own external identities:

- `PUT /api/subjects/external/:externalId`: `{name, apps?, active?, image?}`.
- `PATCH /api/subjects/external/:externalId`: optional `{name, apps, active, image}`; the subject must already exist.
- `POST /api/subjects/external/:externalId/references`: `{image}`.
- `DELETE /api/subjects/external/:externalId`: no request body; physically removes the subject, references, and app access. Immutable metadata audit snapshots remain, without image bytes or foreign keys to the deleted identity.

Writes, source scope changes, deactivation, reactivation, and key revocation use one catalog lock. Capacity is limited to 100 active references and 12 MB across active sources. Matching results are invalidated when the catalog changes during recognition. Keys are stored as SHA-256 digests with optional expiry. Reader keys cannot write; source write keys cannot read or cross into another source.

Provision a private key file while the local service is stopped (the embedded database allows one owner): `node scripts/provision-key.mjs --local --name integration --apps subject-finder --output .local-db/integration-key.json`. For a reader use `--read --apps subject-finder --output .local-db/reader-key.json`. Existing source scope is preserved when `--apps` is omitted. Helpers also expose `provisionSubjectKey`, `provisionReaderKey`, `revokeSubjectKey`, and `setSubjectSourceActive`; none log private keys.

Production uses `NODE_ENV=production`, `SUBJECT_REGISTRY_DATABASE_URL` pointing at a **separately provisioned** PostgreSQL database, and an HTTPS `SUBJECT_REGISTRY_PUBLIC_ORIGIN`. TLS certificate verification remains enabled. Provisioning that database or public HTTPS routing is outside this local implementation; the service continues to bind loopback behind a trusted HTTPS reverse proxy. Configure the backend's independent registry reader credential separately.

Run `npm test` for persistence, read/write privileges, source isolation, physical deletion, immutable audit, capacity rollback, and concurrent scope/revocation behavior. Contract tests inject a deterministic worker; actual biometric recognition remains the Python worker's responsibility.
