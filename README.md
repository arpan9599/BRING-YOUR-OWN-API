# DocBot Lab

A classroom website that turns each student's documents into a private Telegram knowledge assistant using NVIDIA Nemotron and Supabase. No model training is required.

Students open one public link, connect their NVIDIA key and Telegram bot token, upload a document, and ask questions in the browser or their paired Telegram chat. The teacher can supply the NVIDIA key centrally instead.

## Current implementation

- Anonymous browser workspaces with persisted sessions; no website login form.
- Tenant-isolated Supabase documents and 2,048-dimensional embeddings.
- PDF page-aware extraction, DOCX and text support; resumable embedding batches.
- Evidence-based answers, exact supporting quotations, PDF page citations and abstention.
- Encrypted API credentials, private Telegram pairing, webhook verification, deduplication and delivery retry state.
- Browser answer preview and an explicitly labeled fixed sample walkthrough.

The implementation has local security tests and a successful Worker build. A real Supabase project, NVIDIA key, Telegram token and public host are required for an end-to-end live test. The sample walkthrough is not a live NVIDIA demonstration.

## Teacher setup — once for the whole class

1. Create a fresh [Supabase project](https://supabase.com/dashboard).
2. Run [supabase/schema.sql](supabase/schema.sql) in its SQL editor.
3. Enable **anonymous sign-ins** under Authentication → Providers. Rehearse sign-ups on campus Wi-Fi: Supabase limits anonymous sign-ins by IP, including a burst capacity of 30 requests. Have students open their workspaces before class or in small groups; check the current [Auth rate limits](https://supabase.com/docs/guides/auth/rate-limits) and available project settings before promising a simultaneous whole-class sign-up. See [official anonymous auth documentation](https://supabase.com/docs/guides/auth/auth-anonymous).
4. Set these host runtime environment variables:

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | Your project URL |
| `SUPABASE_ANON_KEY` | Publishable key or legacy anonymous key; safe for the browser |
| `SUPABASE_SERVICE_ROLE_KEY` | New server secret key or legacy service-role key; server only |
| `CREDENTIAL_ENCRYPTION_KEY` | 32 random bytes encoded as base64; server only |
| `APP_URL` | Public HTTPS website origin; used for Telegram webhooks |

Generate the encryption key with `node scripts/generate-encryption-key.mjs` and save it in the hosting secret manager. Keep it stable; changing it prevents decrypting existing stored credentials.

Existing installations with the earlier 200-chunk limit: run `supabase/upgrade-workspace-chunks.sql` once to update the database to 500 chunks per workspace. Fresh installations already receive this allowance from `supabase/schema.sql`.

Existing installations: run `supabase/upgrade-document-retrieval.sql` once to remove the old 0.35 similarity cutoff, which could discard relevant passages. Fresh installations already include the corrected retrieval function. Answers still require verified source quotations.

Optional: set **both** `SHARED_NVIDIA_API_KEY` and `CLASSROOM_CODE` as host secrets to use the teacher's key. Students then enter your classroom code instead of getting NVIDIA accounts. They share your request quota. Use a random classroom code, small test groups and staggered uploads.

Do not put server keys in GitHub, `.openai/hosting.json`, frontend variables, or screenshots. Copy `.dev.vars.example` to ignored `.dev.vars` only for local development. Configure the same variables in the production host's secret manager for live use.

## Run locally

Node.js 22.13+ and npm are required; Node 24 is recommended for the TypeScript test runner used here.

```sh
npm ci
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your project settings.
npm run dev
```

PowerShell: use `Copy-Item .dev.vars.example .dev.vars` instead of `cp`. The preview starts on `http://127.0.0.1:5173/`. Without host settings, it shows the setup notice and lets you try the fixed sample. Telegram requires a publicly reachable HTTPS website; its webhook cannot point to localhost.

```sh
npm test
npm run typecheck
npm run lint
npm run build
```

This project uses React with the Vinext/Cloudflare Worker starter. The production build is under `dist/server` and `dist/client`. Sites registration metadata is in `.openai/hosting.json`; it contains no application secrets. Publish through the Sites workflow with the registered project ID. The locally registered Site is not live until its deployment succeeds.

## Student flow

1. Open the shared website link in your own browser profile.
2. Get a [NVIDIA API key](https://build.nvidia.com/) with Public API Endpoints access, OR enter the teacher's classroom code.
3. In Telegram, open [BotFather](https://t.me/BotFather), send `/newbot`, and copy the token. Every student uses a different bot.
4. Paste the key and token into the website; click **Create my workspace**.
5. Upload a short document and wait for **Ready**. If interrupted, click **Resume**.
6. Ask a document question in the browser and check its quotation.
7. Click **Connect Telegram**, follow the private pairing link, and press **Start**.

The browser remembers the workspace, so repeated logins or key entry are not needed. Students do not need Supabase, GitHub or ChatGPT accounts. Clearing browser data, using incognito, or switching devices creates a new workspace. Account recovery and workspace transfer are not included in this first version. See [classroom runbook](docs/CLASSROOM.md).

## What “document-only” means here

Retrieval searches only the owner's ready documents. A model answer must cite an actual retrieved chunk and an exact quote, and pass a second evidence check. A malformed citation gets one fresh generation attempt using the same excerpts. If that still fails, the website shows a verification error and asks you to retry. Missing or unsupported evidence leads to:

> I couldn't find this information in the uploaded documents.

This is a conservative RAG design, not a guarantee of perfect correctness. A model can still misinterpret quoted evidence or decline an answerable question. Read the quotations before relying on an answer.

## Limits

- Text-based PDF, DOCX, TXT and Markdown; 5 MB/file.
- Up to 300 PDF pages, 220,000 extracted characters and 500 stored chunks per workspace. The chunk cap can be reached first.
- Scanned PDFs need OCR before uploading.
- PDF citations use physical page numbers. DOCX/TXT use filenames and quotations.
- 12 questions/minute per bot; bounded upload and embedding calls.
- Answer generation allows up to 40 seconds per call, within a 90-second answer budget. One NVIDIA 500/502/503/504 retry is shared across the answer's AI calls; authentication, rate-limit and timeout failures are not retried automatically.
- Free service quotas are shared and can change. This is a classroom prototype; load-test the intended class size.
- Telegram delivery is at least once; a message can be duplicated if sending succeeds but recording completion fails.

Architecture, isolation, delivery recovery and current model references are documented in [implementation notes](docs/IMPLEMENTATION.md).

## GitHub repository

Source: [arpan9599/Plug-And-Play-LLM](https://github.com/arpan9599/Plug-And-Play-LLM), a private repository. Its owner must grant GitHub access before others can clone it.

Hosted classroom website: [DocBot Lab](https://docbot-lab-arpan.claw-co-28.chatgpt.site/). Students can open this public website without repository access.

The separate Sites source remote is used for hosted deployments. Follow the teacher setup above when running your own copy.
