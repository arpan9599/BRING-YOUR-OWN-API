# Classroom runbook

Host one website and one Supabase project. Each student has a separate anonymous user ID, bot, document collection, encrypted keys and paired Telegram chat.

| Service | Teacher | Each student |
| --- | --- | --- |
| Website | Deploy once; share the public link | Open link; no account form |
| Supabase | Create/configure once | No Supabase account |
| GitHub | Own the source repository | No GitHub account |
| NVIDIA | Optional centrally supplied key | Own key once, OR teacher's classroom code |
| Telegram | Prepare your demonstration bot | Telegram account and a new BotFather bot once |
| ChatGPT | Optional development tool | No ChatGPT account required |

## Before class

1. Complete the README host setup and run the SQL in a fresh project.
2. Enable anonymous sign-ins. Campus Wi-Fi may share one IP, and Supabase limits anonymous sign-ups by IP with a burst capacity of 30 requests. Have students initialize their workspaces before class or in small groups. Check the current [Auth rate limits](https://supabase.com/docs/guides/auth/rate-limits) and available project settings; increasing a sustained limit does not remove the burst limit.
3. Test the actual NVIDIA key on both endpoints. Hosted trial limits and availability vary; do not promise unlimited free access. A centrally supplied key shares one quota across everyone.
4. Rehearse with a short text-based PDF containing a specific attendance rule. Verify the actual physical page number. Do not assume your handbook says 75% on page 17.
5. Prepare one bot and document ahead of time. If the live service is unavailable, the website has a clearly labeled fixed sample walkthrough.
6. Use a class of 5–10 students for the first rehearsal; then test the intended cohort size. Stagger embedding uploads when sharing a key.

## During class

1. Project the same website link students will open.
2. Show masked NVIDIA and Telegram fields. Explain that each student creates their own Telegram bot via `/newbot` in BotFather. Never share your bot token on the projector.
3. Connect a workspace. This verifies the NVIDIA chat/embedding endpoints and Telegram token, and registers the HTTPS webhook.
4. Upload the handbook. Explain: extract text → chunks → NVIDIA passage embeddings → Supabase vectors.
5. Ask an attendance question in the browser. Expand its quotation and check the PDF page.
6. Ask who won the 2018 World Cup. If absent from the handbook, the expected reply is “I couldn't find this information in the uploaded documents.”
7. Click Connect Telegram. Follow the private pairing link and press Start. Repeat the two questions there.
8. Let students use their own documents and bots. Different students must use different browsers/profiles/devices; sharing one browser profile shares its anonymous session.

## Do students log in again and again?

No website sign-in screen is needed. Supabase creates an anonymous identity once, and the browser persists/refreshes its session. Return using the same browser profile. Telegram normally remains signed in, and the API key and bot token are entered once per workspace.

This first version does not provide account recovery or cross-browser workspace transfer. Clearing browser storage, using incognito or changing devices creates a new workspace. A bot already assigned to the old workspace cannot be claimed by a different anonymous user; use a fresh BotFather bot or ask the host to remove/reset the old workspace after verifying ownership. A student who needs recovery should retain their browser session. The teacher can reset abandoned workspaces from Supabase.

## Practical limits

5 MB/file; text PDF, DOCX, TXT, MD; 300 PDF pages; up to 220,000 extracted characters and 500 stored chunks per workspace. Large handbooks may exceed the chunk limit even below the file-size limit. Upload the relevant chapters for the demo. Scanned PDFs need OCR beforehand.

PDF page numbers refer to physical file pages, which may differ from printed page labels. DOCX/TXT citations show filenames and exact quotations without invented page numbers. Keys are encrypted at rest, but the host controls the server and encryption key; this is not encryption that hides credentials from the host. Excerpts/questions are sent to NVIDIA and bot messages to Telegram. Use public or approved classroom documents.

The system refuses absent retrieval, missing exact supporting quotes and failed evidence verification. It can still make mistakes or decline answerable questions. Students should inspect evidence. No model can promise perfect document-only truthfulness.
