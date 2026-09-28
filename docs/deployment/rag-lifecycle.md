# RAG document lifecycle

The PDF ingestion lifecycle is durable in MongoDB. A `BusinessDocument` stores the extracted source text before the BullMQ job is created, and the job payload contains only its deterministic `documentId`. The worker startup recovery re-enqueues `uploaded`, `enqueue_failed`, stale `queued`, and stale `processing` documents idempotently.

Document states progress through `uploaded -> queued -> processing -> ready -> active`. The prior active version remains queryable until the new version and all of its embeddings are ready. A scanned PDF without extractable text ends in `failed` with `errorCode=no_indexable_text`; OCR is not currently performed.

Production requires the unique MongoDB index `business_1_version_unique` and the three Atlas Vector Search indexes. Verify readiness without changing infrastructure:

```powershell
npm run rag:indexes:check
```

Create or update missing indexes explicitly:

```powershell
npm run rag:indexes:ensure
```

The ensure command is idempotent. It refuses to create the unique version index if duplicate `(business, version)` rows exist. Atlas indexes can remain `PENDING` while they build; deployment readiness is confirmed only when the check command reports all indexes as `READY`.
