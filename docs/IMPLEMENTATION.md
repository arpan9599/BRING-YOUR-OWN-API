# Implementation and limits

## Data flow

Browser extraction (PDF.js / Mammoth / plain text) → page-aware chunks (1,400 characters, 150 overlap) → NVIDIA passage embeddings → Supabase pgvector.

Question → NVIDIA query embedding → tenant-filtered cosine search → up to six excerpts → Nemotron JSON claims with exact quotes → deterministic citation validation → second model evidence check → browser/Telegram response.

Search ranks the six nearest excerpts without a fixed similarity cutoff. Similarity scores vary with query length and wording; the original 0.35 cutoff discarded relevant cost-of-attendance passages scoring around 0.27. Candidate retrieval does not authorize an answer: the model must identify relevant evidence, quote it exactly, and pass the second evidence check. Short topic phrases request a document-based definition or explanation. Internal diagnostics record only the rejection stage and counts/scores, never question text, excerpts or credentials.

## Isolation

Supabase anonymous auth creates an authenticated unique user, persisted in the browser. Server APIs validate the JWT using `auth.getUser`, then derive owner IDs exclusively from that verified user. Service-role access is server-only; RLS separately permits authenticated users to read only their own documents/chunks. Bot credentials, webhook jobs and rate counters have no browser policies. Composite foreign keys enforce bot/document/owner consistency.

The service role bypasses RLS, so server owner filters are essential. Security tests cover forged owner input, wrong webhook secrets, unauthorized chat access, duplicate updates and absent evidence. SQL has to be applied and integration tested against a real Supabase project before the classroom launch.

AES-256-GCM encrypts keys with a random IV and binds ciphertext to the owner ID. The base64 encryption key is a host secret. Only a safe bot summary is returned to the browser. NVIDIA/Telegram keys are never stored in browser localStorage or returned by the server. Supabase's browser auth session is persisted so students can return.

Telegram uses a unique bot per workspace, a hashed webhook secret, and a one-use 256-bit private pairing link. Only the paired private chat can retrieve document content. A new pairing invalidates the earlier pairing. One Telegram token supports one webhook, so existing integrations require an explicit replacement choice.

## Ingestion and delivery recovery

SQL reserves chunk slots atomically under a bot-row lock. Embeddings are processed in batches of five. A document becomes searchable only after all vectors are stored. Interrupted uploads remain visible with a Resume button; deleting a document cascades its chunks.

Telegram update IDs are durable and unique per bot. A database lease with a fencing token prevents concurrent processing, and prepared response parts are stored before delivery. Retries reuse prepared responses and resume unsent parts. Complete claims are sent as separate messages to preserve their source citations. Database operations time out after 8 seconds and NVIDIA operations after 22 seconds. Failed work is not acknowledged to Telegram.

Delivery is at least once: if Telegram accepts a message but recording its completion fails, a retry can duplicate that part. Shared NVIDIA capacity may still cause retries; use staggered class uploads. There is no distributed job scheduler or separate queue worker in this first version. Periodically remove old completed Telegram update rows and inactive anonymous workspaces from the host dashboard. Keep recent deduplication rows for at least 7 days.

## Model selection

Defaults verified for this implementation:

- Chat: `nvidia/nemotron-3-ultra-550b-a55b`, with the hosted API's `reasoning_effort: none` for direct JSON answers ([API reference](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-ultra-550b-a55b-infer)). Both answer generation and the second evidence check use this mode; validation and source quotation checks still apply.
- Embeddings: `nvidia/nemotron-3-embed-1b`, 2,048 dimensions, `input_type: passage/query` ([API reference](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-embed-1b-infer)).
- Fixed endpoint: `https://integrate.api.nvidia.com/v1`. API keys need Public API Endpoints access ([NVIDIA key guide](https://docs.nvidia.com/rag/latest/api-key.html)).

Older embedding endpoints are deprecated. Switching to a different embedding model requires a compatible schema and re-embedding every document. The hosted embedding endpoint accepts up to 4,096 input tokens; conservative character chunks stay below that even for token-dense text.

Ordinary pgvector vector indexes cap dimensions below this model's 2,048. The classroom version instead uses exact cosine scans after filtering to at most 500 chunks per workspace. For larger production collections, redesign retrieval/indexing, background ingestion, account recovery, monitoring and resource quotas.

## Grounding

Retrieved documents are untrusted data, including embedded instructions. A model must produce at most four claims, each with a real retrieved chunk ID and an exact supporting quote. Invalid citations and unsuccessful verification fail closed. Quotations shorter than 12 characters are rejected, which can cause abstention for short table cells. Similarity is a retrieval heuristic, not a correctness score. The second verifier is also a model; this reduces errors but does not guarantee entailment or defeat every prompt injection.

The sample walkthrough is fixed content and uses no NVIDIA calls, database, uploads or Telegram registration. It is labeled explicitly in the UI. Do not present it as a live RAG test.

## Primary setup references

- [Supabase anonymous auth and IP rate limits](https://supabase.com/docs/guides/auth/auth-anonymous)
- [Supabase RLS and server-key behavior](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Telegram Bot API webhooks](https://core.telegram.org/bots/api#setwebhook)
