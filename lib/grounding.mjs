export const REFUSAL = "I couldn't find this information in the uploaded documents.";
export const EMBEDDING_MODEL = 'nvidia/nemotron-3-embed-1b';
export const CHAT_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';
export const FALLBACK_CHAT_MODEL = 'nvidia/nemotron-3-super-120b-a12b';
export const DIMENSIONS = 2048;
export const MAX_CHUNKS = 500;
export class DocumentInputError extends Error {}

/** PostgreSQL text/JSONB cannot store NUL or unpaired UTF-16 surrogates.
 * @param {string} value */
export function cleanDocumentText(value) { return value.replace(/\u0000/g, '').toWellFormed(); }

/** @param {string} value */
export function normalize(value) { return value.replace(/\s+/g, ' ').trim(); }

/** @param {string} text @param {number} index */
function safeBoundary(text, index) {
  const before = text.charCodeAt(index - 1), after = text.charCodeAt(index);
  return before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF ? index - 1 : index;
}

/** @param {{page:number|null,text:string}[]} pages */
export function chunkPages(pages) {
  const chunks = [];
  for (const page of pages) {
    const text = normalize(cleanDocumentText(page.text));
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + 1400, text.length);
      if (end < text.length) {
        const boundary = text.lastIndexOf(' ', end);
        if (boundary > start + 1000) end = boundary;
      }
      end = safeBoundary(text, end);
      chunks.push({ page: page.page, content: text.slice(start, end) });
      if (chunks.length > MAX_CHUNKS) throw new DocumentInputError(`This document exceeds ${MAX_CHUNKS} chunks. Upload a shorter document or split it into chapters.`);
      if (end === text.length) break;
      start = safeBoundary(text, end - 150);
    }
  }
  if (!chunks.length) throw new DocumentInputError('No readable text found. Scanned PDFs need OCR before uploading.');
  return chunks;
}

/** @param {string} raw */
export function parseJson(raw) {
  const clean = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(clean);
}

/** @param {unknown} result @param {{id:string,title:string,page:number|null,content:string}[]} chunks */
export function validateClaimsDetailed(result, chunks) {
  /** @param {string} reason @param {number|null} [claimIndex] */
  const fail = (reason, claimIndex = null) => ({ claims: null, issue: { reason, claimIndex } });
  const candidate = /** @type {{answerable?:boolean,claims?:unknown[]}} */ (result);
  if (!candidate || candidate.answerable !== true || !Array.isArray(candidate.claims)) return fail('invalid_shape');
  if (!candidate.claims.length || candidate.claims.length > 4) return fail('invalid_count');
  const claims = [];
  for (const [index, item] of candidate.claims.entries()) {
    const claim = /** @type {{text?:string,chunkId?:string,quote?:string}} */ (item);
    if (!claim || typeof claim.text !== 'string' || typeof claim.quote !== 'string' || typeof claim.chunkId !== 'string') return fail('invalid_field', index);
    const source = chunks.find(chunk => chunk.id === claim.chunkId);
    if (!source) return fail('unknown_chunk', index);
    const quote = normalize(claim.quote);
    if (quote.length < 12 || quote.length > 1400) return fail('quote_length', index);
    if (!normalize(source.content).includes(quote)) return fail('quote_not_exact', index);
    if (!claim.text.trim() || claim.text.length > 700) return fail('text_length', index);
    claims.push({ text: claim.text.trim(), quote, chunkId: source.id, title: source.title, page: source.page });
  }
  return { claims, issue: null };
}

/** @param {unknown} result @param {{id:string,title:string,page:number|null,content:string}[]} chunks */
export function validateClaims(result, chunks) { return validateClaimsDetailed(result, chunks).claims; }

/** @param {string} key */
async function encryptionKey(key) {
  const bytes = Uint8Array.from(atob(key), c => c.charCodeAt(0));
  if (bytes.length !== 32) throw new Error('CREDENTIAL_ENCRYPTION_KEY must be 32 random bytes, base64 encoded.');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt','decrypt']);
}
/** @param {string} key @param {string} value @param {string} owner */
export async function encryptSecret(key, value, owner) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(owner)}, await encryptionKey(key), new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...iv)) + '.' + btoa(String.fromCharCode(...new Uint8Array(data)));
}
/** @param {string} key @param {string} value @param {string} owner */
export async function decryptSecret(key, value, owner) {
  const [iv, cipher] = value.split('.').map(part => Uint8Array.from(atob(part), c => c.charCodeAt(0)));
  const data = await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(owner)}, await encryptionKey(key), cipher);
  return new TextDecoder().decode(data);
}
/** @param {string} value */
export async function sha256(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(b=>b.toString(16).padStart(2,'0')).join('');
}
export function randomSecret() { return Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b=>b.toString(16).padStart(2,'0')).join(''); }
/** @param {unknown} value */
export function validateEmbedding(value) {
  if (!Array.isArray(value) || value.length !== DIMENSIONS || !value.every(n=>typeof n==='number' && Number.isFinite(n))) throw new Error('The embedding endpoint returned an incompatible vector.');
  return value;
}
