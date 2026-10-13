// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * redaction — strip secrets from raw text BEFORE it is stored.
 *
 * **Why this is the most important file in the capture path.** Capture
 * copies whole transcripts. A transcript contains everything that went
 * through a terminal: `env` output, `cat .env`, curl headers, a token
 * someone pasted by mistake. Without this stage, capture would be a
 * secret leak *with version history* — and git forgets nothing.
 *
 * **Stance: redact too much rather than too little.** A wrongly
 * redacted hash costs readability. A leaked token costs a key rotation
 * and possibly a great deal more. When in doubt, redact.
 *
 * **What this is NOT:** a guarantee. Regexes catch known shapes. A
 * secret in a shape not listed here gets through. So the rule stands:
 * don't put secrets in your terminal. This is the net, not a reason to
 * climb without a rope.
 *
 * CANARY FILE — this file deliberately contains sample secrets (the
 * self-test canaries). The pre-commit hook skips files carrying this
 * marker, otherwise it could never be committed.
 */

/**
 * Patterns. Order matters — specific before generic, otherwise the
 * broad assignment patterns eat the precision of the narrow ones.
 *
 * Every pattern carries a name so the redaction can say WHAT it
 * removed: `[REDACTED:openai-key]` is a usable hint, `[REDACTED]` is
 * just a hole.
 */
/**
 * Separator and space classes that also accept the Unicode look-alikes.
 *
 * A secret written `NAME＝value` with a FULLWIDTH EQUALS SIGN (U+FF1D)
 * passed every assignment pattern unredacted — measured 2026-09-05, it
 * reached disk and passed the pre-commit hook. The patterns hang on
 * `[:=]` and `\s`, so the fix belongs there and nowhere else.
 *
 * Deliberately NOT solved by normalising the text: NFKC changes string
 * length (ﬁ becomes fi), which breaks the offsets `String.replace`
 * relies on, and it would rewrite legitimate full-width content that a
 * user wrote on purpose. Widening the class leaves the text untouched
 * and cannot introduce a new failure class.
 *
 * Covered: fullwidth = : - _ , the modifier and mathematical colons,
 * the non-breaking and ideographic spaces, and the zero-width joiners
 * that can pad a key name.
 */
export const SEP = '[:=\\uFF1D\\uFF1A\\u2236\\u02D0\\u205D]';
export const SP = '[\\s\\u00A0\\u1680\\u2000-\\u200D\\u202F\\u205F\\u2060\\u3000\\uFEFF]';

/**
 * A marker this module has already put in the text: `[REDACTED]`, `[REDACTED:type]`, `[REDACTED:env:NAME]`. Bounded name,
 * so the repetitions around it stay linear.
 */
const MARKER = '\\[REDACTED(?::[A-Za-z0-9_.:-]{0,64})?\\]';

/** The words that make a key a secret's key, for the two json-secret rules below (one list, no second copy). */
const JSON_KEY_WORDS = 'password|passwd|passphrase|secret|token|api[_-]?key|apikey|private_key|access_key|client_secret|refresh_token';

export const PATTERNS = Object.freeze([
  // --- Signed URLs (presigned upload/download links) -----------------
  // A presigned URL carries its credential in the query string:
  // `X-Amz-Signature` is the signature, `X-Amz-Credential` names the
  // access key, `X-Amz-Security-Token` the session token. Measured on a
  // dummy: `X-Amz-Signature=<64 hex>` survived raw capture untouched,
  // `X-Amz-Credential` lost only its AKIA prefix (aws-key-id), and in the
  // URL-encoded (`%3D`/`%26`) or JSON-escaped (`\u0026`) form nothing hit.
  //
  // Listed FIRST so the whole value falls. The parameter name and the
  // equals sign (also `%3D`) stay, only the value becomes the marker. The
  // value ends at `&`, `%26`, `&amp;`, `\u0026`, a quote, whitespace, an
  // angle bracket or a backslash (`\/` inside the value is allowed).
  //
  // The names are provider-specific (X-Amz-*, X-Goog-*) and appear only in
  // signed URLs, so false positives are rare. NOT included: a bare
  // `Signature=` / `GoogleAccessId=` (SigV2, GCS V2, CloudFront) - too
  // general a name; `AWSAccessKeyId=AKIA...` is caught by aws-key-id.
  // Azure SAS `sig=` is below, but only together with `sv=<date>` in the
  // same query text (both orders, 800-character window, linear).
  ['signed-url',
    /(?<=^|[^A-Za-z0-9]|%[0-9A-Fa-f]{2}|\\u0026)(X-(?:Amz-(?:Security-Token|Signature|Credential)|Goog-(?:Signature|Credential))(?:=|%3D|%253D))((?:\\\/|(?!%26|&amp;)[^&\s"'`<>\\]){8,4096})/gi],
  ['signed-url',
    /(?<=^|[^A-Za-z0-9]|%[0-9A-Fa-f]{2}|\\u0026)(sv(?:=|%3D)\d{4}-\d{2}-\d{2}(?:[^\s"'`<>\\]|\\u0026){0,800}?(?:&|%26|\\u0026|&amp;)sig(?:=|%3D))((?:\\\/|(?!%26|&amp;)[^&\s"'`<>\\]){16,4096})/gi],
  ['signed-url',
    /(?<=[?&]|%26|\\u0026|&amp;)(sig(?:=|%3D))((?:\\\/|(?!%26|&amp;)[^&\s"'`<>\\]){16,4096})(?=(?:[^\s"'`<>\\]|\\u0026){0,800}?(?:[?&]|%26|\\u0026|&amp;)sv(?:=|%3D)\d{4}-\d{2}-\d{2})/gi],

  // --- The viewer's own ways in (Fable run 2026-10-11, ported from lucky-mem) ------------
  //
  // The access token travels as a link (`/?k=<token>`) and as the cookie `mem_k=<token>`; the password session as the
  // cookie `mem_session=<token>`. None of these forms carries the word token, secret or password, so the assignment
  // patterns below never saw them, and raw capture, output and the stored lines gave them away in clear text. The
  // name and the `=` stay, the value falls (like the signed URL). `k=` counts only after `?`, `&` (also encoded:
  // %3F, %26; `;k=` inside a URL, below) and from 16 characters of value on: a single letter as a name is too general, a short `k=5` is no
  // access. The value falls WHOLE, there is no upper cap (a cap would leave the tail of a long value behind).
  // The value is token-shaped (review 2026-10-12: `let a=1;k=someObject.longName` was caught): letters, digits, `_ ~ + / -`
  // and %XX escapes, and it must not run on into code - not `.name`, not a call. `;k=` counts only INSIDE a URL (after a `?`
  // or `&` without a space in between), as a URL path parameter; in code a `;` is a statement end.
  ['viewer-access',
    /(?<=[?&]|%3F|%26|\\u0026|&amp;)(k(?:=|%3D))((?:[A-Za-z0-9_~+/-]|%[0-9A-Fa-f]{2}){16,})(?![A-Za-z0-9_~+/%-]|\.[A-Za-z_$]|\()/gi],
  ['viewer-access',
    /(?=k(?:=|%3D))(?<=(?:[?&]|%3F|%26)[^\s"'<>]{0,200}(?:;|%3B))(k(?:=|%3D))((?:[A-Za-z0-9_~+/-]|%[0-9A-Fa-f]{2}){16,})(?![A-Za-z0-9_~+/%-]|\.[A-Za-z_$]|\()/gi],
  ['viewer-access',
    /(?<![A-Za-z0-9_])((?:mem_k|mem_session)(?:=|%3D))([A-Za-z0-9_.~%+/-]{8,})/gi],

  // --- Provider keys with an unambiguous prefix ----------------------
  ['anthropic-key',   /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['openai-key',      /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}/g],
  ['voyage-key',      /\bpa-[A-Za-z0-9_-]{30,}/g],
  ['github-token',    /\bgh[pousr]_[A-Za-z0-9]{30,}/g],
  ['github-pat',      /\bgithub_pat_[A-Za-z0-9_]{50,}/g],
  ['slack-token',     /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ['stripe-key',      /\b[rs]k_(live|test)_[A-Za-z0-9]{20,}/g],
  ['google-key',      /\bAIza[A-Za-z0-9_-]{30,}/g],
  ['aws-key-id',      /\b(?:AKIA|ASIA|AROA|AIDA)[A-Z0-9]{16}\b/g],
  ['hf-token',        /\bhf_[A-Za-z0-9]{30,}/g],
  ['npm-token',       /\bnpm_[A-Za-z0-9]{30,}/g],
  ['telegram-token',  /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/g],

  // --- Structured secrets -------------------------------------------
  ['jwt',             /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  // A base64-encoded JSON object IN ONE PIECE, without the two dots of
  // a JWT. That is what a Cloudflare tunnel token looks like; it got
  // through in the field because the jwt pattern demands three
  // segments. 'eyJ' is base64 for '{"', so it is nearly always a data
  // blob rather than prose; past 40 characters a chance match is
  // unrealistic.
  //
  // **A full stop is not a third segment (2026-10-01).** The tail used to
  // forbid ANY following dot so the pattern would not bite into a JWT.
  // That let the blob through whenever a sentence ended with it:
  // `tunnel token eyJ... . Please keep this private.` (bench/value-report.mjs,
  // json-blob 4 of 5). Now only a dot followed by token characters, the
  // JWT shape, stops it.
  ['json-blob',       /\beyJ[A-Za-z0-9_-]{40,}={0,2}(?![A-Za-z0-9_-]|\.[A-Za-z0-9_-])/g],
  // The span between BEGIN and END is bounded (8 KB; a 4096-bit RSA key is ~3.2 KB): without the bound a text with many
  // BEGIN lines and no END scanned to its end from each of them, quadratic (2.8 MB took 38 s).
  ['pem-block',       /-----BEGIN[^-]{0,40}-----[\s\S]{0,8192}?-----END[^-]{0,40}-----/g],
  // The same block WITHOUT its END line: a text that was cut inside the key (a cap, a window, a truncated paste)
  // keeps the header and a long run of key material, and the pattern above needs the END to see any of it
  // (mask-before-cut round: ~1990 characters of a key survived `questiontext.prepare` this way). Runs after the
  // pattern above, so a complete block has already fallen; what is left is open. Only the key MATERIAL falls:
  // the header, then base64 runs of 20+ characters (lines, or the literal \n of a JSON string between them).
  // A header alone ("-----BEGIN CERTIFICATE-----" in prose) is not touched.
  // Unambiguous by construction (no two ways to read the same characters, so no backtracking blow-up): blank space; then
  // header lines (`Proc-Type: 4,ENCRYPTED`: a letter-led name, a colon, a bounded value, a line end); then base64 runs.
  ['pem-block',       /-----BEGIN[^-]{0,40}-----(?:\s|\\[nr])*(?:[A-Za-z][A-Za-z0-9-]{0,30}:[^\n\\]{0,61}(?:\r?\n|\\n)(?:\s|\\[nr])*)*(?:[A-Za-z0-9+/=]{20,}(?:\s|\\[nr])*)+/g],
  ['ssh-key',         /\bssh-(?:rsa|ed25519|dss)\s+[A-Za-z0-9+/=]{50,}/g],

  // --- Headers / URLs ------------------------------------------------
  ['bearer',          /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}=*/g],
  ['basic-auth',      /\b[Bb]asic\s+[A-Za-z0-9+/]{20,}=*/g],
  // Scheme bounded (2026-09-26): unbounded, it restarted at every word
  // boundary of a long run like 'a.b-c+d...' and went quadratic (lucky-mem
  // measured 64,000 chars in 1718 ms). Real schemes are short.
  ['url-credentials', /\b([a-z][a-z0-9+.-]{0,31}):\/\/[^\s:@/]+:[^\s@/]+@/gi],
  // The value may run THROUGH a marker an earlier rule left in it (`Ab3x...K9mQ[REDACTED:x]Z`, `[REDACTED:x]Z`): a marker
  // does not end the value, or the stump after it stays in the clear (torn-marker finding, 2026-10-13).
  ['x-api-key',       new RegExp(`\\b(x-api-key|api[_-]?key|apikey)${SP}*${SEP}${SP}*["']?(?:[A-Za-z0-9._-]{16,}(?:${MARKER}[A-Za-z0-9._-]*)*|(?:${MARKER})+[A-Za-z0-9_-][A-Za-z0-9._-]*)["']?`, 'gi')],

  // --- Environment variables -----------------------------------------
  // Covers `export FOO_TOKEN=...`, `FOO_SECRET: ...`, `"password": "..."`
  ['env-secret',
    // The prefix before the keyword is OPTIONAL. It used to be
    // [A-Za-z_][A-Za-z0-9_]* — at least one character — which let a
    // bare `token=...` in a URL slip through.
    new RegExp(`\\b([A-Za-z0-9_]{0,64}(?:TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|APIKEY|API_KEY|PRIVATE_KEY|CREDENTIAL|SESSION_KEY)[A-Za-z0-9_]{0,64})${SP}*${SEP}${SP}*["']?([^\\s"'\`,;&]{6,})["']?`, 'gi')],

  // CLI flag form with a space instead of `=`: `--token ey...`,
  // `--api-key sk-...`, `cloudflared tunnel run --token <blob>`. The
  // assignment pattern above demands `:`/`=` and let the flag form
  // through — measured against lucky-mem's redaktion.mjs, which closed
  // this the same day for the same reason (a Cloudflare tunnel token
  // passed as `--token`). Type stays `env-secret`, so the same
  // harmless-value/placeholder/$VAR exceptions apply; value >=12, or it
  // would catch short example words. The flag name itself is left in
  // place.
  ['env-secret',
    /(--?(?:token|api[-_]?key|apikey|secret|password|passwd|passphrase|auth[-_]?token|access[-_]?token|refresh[-_]?token|client[-_]?secret|private[-_]?key))\s+["']?([^\s"'`,;&]{12,})["']?/gi],

  // Lowercase in JSON/YAML: "password": "...", secret: ...
  //
  // **The keyword may sit anywhere in the key, not only as the whole key
  // (2026-09-26).** Measured against main before this change, every one
  // of these went through untouched, value in plain text:
  //
  //     {"secretKey": "..."}      {"passwordHash": "..."}
  //     {"tokenPage": "..."}      {"apiKeyId": "..."}
  //     {"secret-value": "..."}   {"tokenValue": "..."}
  //
  // Each of the two assignment rules carried half the shape. `env-secret`
  // allows letters around the keyword but wants the separator right after
  // the name, so the closing quote of a JSON key defeats it. `json-secret`
  // took the quote and allowed nothing around the keyword. Together they
  // covered everything except the most common case: in JSON the key is
  // usually `secretKey`, not `secret`. The same hole was found and closed
  // in lucky-mem the same day; this is the English rebuild, not a copy.
  //
  // Widening the key needs HARMLESS_KEY below, or every pagination
  // cursor (`nextPageToken`) turns into a finding.
  //
  // **Bounded, and anchored to a word start.** With `*` before AND after
  // the keyword, a long run with no separator backtracked catastrophically:
  // 4,000 chars of 'tokentoken...' took 4.8 s, and test/entry-size-cap
  // never finished. Key names are short: at most 64 characters on either
  // side of the keyword. The price, named: a key with more than 64
  // characters before the keyword is no longer caught by THIS rule.
  //
  // **Escaped quotes (2026-10-01).** A JSON object carried as a string
  // inside a JSON log line has `\"` instead of `"`:
  // `{"msg":"{\"secretKey\": \"...\"}"}`. The backslash in front of the
  // quote defeated the pattern (bench/value-report.mjs, json-secret 4 of
  // 5). Up to three backslashes are now allowed before each quote (escaped
  // once or twice). The value takes a backslash only when it does NOT start
  // the closing escaped quote; otherwise it would swallow the `\` and the
  // redaction would break the escape sequence.
  ['json-secret',
    new RegExp(`(?<![A-Za-z0-9_])(["']?[A-Za-z0-9_]{0,64}(?:${JSON_KEY_WORDS})[A-Za-z0-9_-]{0,64}\\\\{0,3}["']?${SP}*${SEP}${SP}*)\\\\{0,3}["']((?:[^"'\\s\\\\]|\\\\(?!\\\\{0,2}["'])){6,})\\\\{0,3}["']`, 'gi')],

  // --- The keyword-free pair: address, then a credential ------------
  //
  // Measured against lucky-mem's redaktion.mjs (its `zugangspaar`
  // pattern): a person handing over an access in prose writes an
  // address, a separator, a secret — with NO keyword at all
  // ("admin: someone@example.com / aB3xY9kQ7mZ2pL5wQ1"). None of the
  // patterns above fire, because none of them look for this without a
  // TOKEN/SECRET/PASSWORD-shaped name nearby.
  //
  // Deliberately narrow so it does not redact every email address that
  // happens to sit near a slash: the local part is bounded, the value
  // must mix letters with a digit or punctuation (a plain word after
  // the separator is not flagged), and it starts at a boundary (the
  // same over-eager-backtracking fix `url-credentials` already needed).
  ['credential-pair',
    /(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]+\.[A-Za-z]{2,})(\s*[/|:]\s*)((?=[^\s]*[0-9!#$%&*+?@^_-])[^\s"'`,;]{6,})/g],
]);

// **A placeholder is a placeholder only as a WHOLE value** (owner decision 2026-10-13, both houses). The old rule
// excused every value that merely STARTED with `your`, `my`, `test` ...: `password=mySecret123!` and
// `password=test1234` went through unmasked. Now the whole value must be one of the placeholder words
// (`your`, `my`, `dein`, `ihr`, `beispiel`, `example`, `sample`, `dummy`, `fake`, `placeholder`), alone or
// followed by exactly one generic word (`password`, `key`, `api_key`, `token`, `secret`, `value` ...), joined by
// `_` or `-` or not at all: `your_password`, `my-token`, `example`. `test...` is no placeholder at all.
const PLACEHOLDER_WORD = '(?:dein|deine|deinen|deiner|ihr|ihre|ihren|your|my|beispiel|example|sample|dummy|fake|placeholder)';
const GENERIC_WORD = '(?:password|passwort|passwd|pass|pw|passphrase|key|api[_-]?key|apikey|token|secret|geheimnis|value|wert|credential|credentials|schluessel|code|id)';
const PLACEHOLDER_VALUE = new RegExp(`^${PLACEHOLDER_WORD}(?:[_-]?${GENERIC_WORD})?$`, 'i');
/**
 * If a match looks like one of these, it is NOT a secret — a
 * placeholder, an example, something already redacted. Otherwise we
 * redact our own documentation and the error messages turn to mush.
 */
const HARMLESS = [
  /^(x{3,}|\*{3,}|\.{3,}|-{3,})$/i,
  PLACEHOLDER_VALUE,
  /^(redacted|changeme)$/i,
  /^(<|\{|\$\{|%|\[)/,            // <TOKEN>, ${VAR}, {{secret}}, [redacted]
  /^(null|undefined|none|nil|true|false|empty)$/i,
  /^REDACTED/,
  /^\.\.\./,
  // The three values `fetch`'s `credentials` option accepts. Measured
  // against lucky-mem's redaktion.mjs, which added this same exception
  // after `credentials: 'same-origin'` (CREDENTIAL is one of the
  // env-secret keywords) was flagged as a finding — the three values are
  // fetch-standard vocabulary, published on every site on the web, never
  // a secret. Anchored (^...$), not a prefix: a rule that reports
  // innocent code gets switched off, and then it also stops catching the
  // real thing.
  /^(same-origin|include|omit)$/,
];

/**
 * Keys that NAME a token but never grant access: pagination cursors.
 *
 * `HARMLESS` judges the VALUE, and a cursor's value is arbitrary — only
 * the key says it is not a credential. Found in lucky-mem on 2026-09-26:
 * two `nextPageToken` values from a Google Drive listing (208 and 636
 * characters) held its CI red. A cursor is opaque, short-lived and
 * grants nothing on its own.
 *
 * **Why not simply require a word boundary before `token`.** That is the
 * obvious way out and a real weakening: `authToken`, `accessToken`,
 * `sessionToken` (a live credential in AWS) and `idToken` ARE secrets.
 * An exception by NAME takes out exactly the four known cursor names and
 * leaves everything else sharp.
 *
 * Anchored to the END of the key: `pageToken` is exempt,
 * `pageTokenSecret` is not.
 */
const HARMLESS_KEY = [
  // Google (nextPageToken, pageToken), AWS (nextToken),
  // Azure and S3 (continuationToken) — each also in snake_case.
  /(?:^|[^A-Za-z0-9])(?:next_?page_?token|page_?token|next_?token|continuation_?token)$/i,
];

/** Does this key name something that grants no access? See HARMLESS_KEY. */
export function isHarmlessKey(name) {
  const bare = String(name ?? '').trim().replace(/^["'\s]+/, '').replace(/[\\"'\s:=]+$/, '');
  return HARMLESS_KEY.some((r) => r.test(bare));
}

/**
 * A REFERENCE to a secret is not the secret.
 *
 * `const token = process.env.GITHUB_TOKEN;` was being rewritten to
 * `const token=[REDACTED:env-secret];` — reported from the field on
 * 2026-09-08. The `env-secret` pattern matches anything to the right of
 * a name containing TOKEN/SECRET/PASSWORD, and it never looked at what
 * that anything WAS. In code that is nearly always an expression.
 *
 * Why this is the safe direction and not a hole: every shape below
 * names a place where a value is FETCHED FROM. A generated credential
 * cannot look like this — it has no `process.env.` prefix, no
 * parentheses, no `$env:`. And the exemption is still gated on
 * `looksLikeCredential` in `isHarmless`, so a value that carries a
 * base64-ish run with letters AND digits is redacted even if it is
 * dressed up as a call.
 *
 * What it deliberately does NOT cover: `config.token`, `settings.key`,
 * `data.password`. Those are plain property reads and a config object
 * really can hold an inlined literal in the same line elsewhere. Narrow
 * beats clever here.
 */
const IS_REFERENCE = [
  /^process\.env[.[]/,             // process.env.X, process.env['X']
  // A parameter or local literally NAMED `env` — the house style for
  // "the environment this was configured from", so that a service does
  // not read `process.env` behind its caller's back. `env.FOO_TOKEN`
  // names an environment variable exactly as much as `process.env.FOO_TOKEN`
  // does; it is not one. Found on 2026-09-09, when this rule stopped a
  // commit of `token: env.CHEAP_MEM_SERVE_TOKEN || ''`.
  //
  // Deliberately anchored to the bare name `env`, not to any object
  // with an `env` property: `config.env.x` could be anything. And the
  // `looksLikeCredential` gate still applies, so a value that merely
  // starts with those four characters and IS credential-shaped is
  // still caught.
  /^env[.[]/,                      // env.X, env['X']
  /^(os\.environ[.[]|os\.getenv\()/, // Python
  /^\$env:/i,                      // PowerShell $env:GITHUB_TOKEN
  /^E?NV\[/i,                      // ENV['X'], env[...]
  /^(await\s+)?[A-Za-z_$][\w$.]*\(.*\)$/, // getToken(), await readSecret(x)
];

/**
 * Does this value look like an actual credential?
 *
 * Criterion: a contiguous run of at least 12 characters from the
 * base64/hex alphabet that mixes LETTERS AND DIGITS. Prose almost
 * never does that; generated keys almost always do.
 */
function looksLikeCredential(s) {
  const runs = String(s).match(/[A-Za-z0-9_\-+/=]{12,}/g) ?? [];
  return runs.some((r) => /[A-Za-z]/.test(r) && /\d/.test(r));
}

/**
 * A "value" that itself looks like another assignment is prose ABOUT
 * secrets, not a secret.
 *
 * Writing down which patterns are still missing makes the env pattern
 * match itself. Whoever writes about the rules trips them.
 *
 * **The first version of this exception was a hole.** It tests the
 * VALUE, and a real secret is allowed to contain a colon:
 * `MY_TOKEN=secret:aB3xY9kQ7mZ2pL5wQ1` therefore looked like prose and
 * survived unredacted. Three of four realistic shapes got through.
 *
 * So the exception now applies ONLY when the value contains nothing
 * that looks like a credential. When in doubt, redact: an unreadable
 * line of documentation costs readability, a leaked secret costs a key
 * rotation.
 */
const PROSE_ABOUT_SECRETS =
  /(token|secret|password|passwd|passphrase|apikey|api_key|private_key|credential|session_key)\s*[:=]/i;

// A value that BEGINS with a marker is harmless only while nothing but closing punctuation follows it. `[REDACTED:x]T` is
// the front of a value an earlier rule tore in half: the marker stands for the part that fell, `T` is the part that did
// not (torn-marker finding, 2026-10-13). A value of markers alone stays as it is (idempotence).
const MARKER_LED = new RegExp(`^(?:${MARKER})+`);
const MARKER_ONLY = new RegExp(`^(?:${MARKER}|\\s)*$`);
function markerLedWithTail(t) {
  const m = MARKER_LED.exec(t);
  // What may follow without being a stump: closing punctuation, or a delimiter the value patterns do not stop at on their
  // own (a backslash, as in the JSON-escaped `\u0026` between URL parameters; the encoded `&`, `;`, `,` and quotes).
  return m !== null && !/^(?:[)\]}>.]*$|\\|%(?:26|3B|2C|22|27))/i.test(t.slice(m[0].length));
}

function isHarmless(s) {
  const t = String(s).trim();
  if (markerLedWithTail(t)) return false;
  // Six characters count when the value carries a digit or a special
  // character (the German-style and pair patterns already match at six);
  // a plain short word stays at eight. Audit finding B#2.
  // Short values must also be one plain token (no backslash, brace or
  // other escape syntax) with at least one letter.
  if (t.length < 8) {
    const shortSecret = t.length >= 6 && /[0-9!#$%&*+?@^_-]/.test(t)
      && /^[A-Za-z0-9!#$%&*+?@^_-]+$/.test(t) && /[A-Za-z]/.test(t);
    if (!shortSecret) return true;
  }
  if (PROSE_ABOUT_SECRETS.test(t) && !looksLikeCredential(t)) return true;
  // A reference to a secret is not the secret — but only while the value
  // itself carries nothing credential-shaped. Same gate as the prose rule.
  if (IS_REFERENCE.some((r) => r.test(t)) && !looksLikeCredential(t)) return true;
  return HARMLESS.some((r) => r.test(t));
}

// --- A string value under a secret's key: the WHOLE string -------------------------------------------------------
//
// `json-secret` above masks a value without blanks. A password is often a phrase, and a value an earlier rule has already
// cut holds a marker and a stump: `{"password": "correct horse battery staple"}` stayed in the clear, and so did
// `{"api_key": "T [REDACTED:x] T"}` (measured 2026-10-13, torn-marker finding). So the string is taken as a string:
// from the opening quote to the closing quote of the same kind that is not escaped, blanks, escaped quotes and markers
// inside it included. This is a scan in code, not a pattern, because "not escaped" is a count (the backslashes in front
// of the quote), and the end must be found without backtracking.
//
// - **Nesting.** A JSON object carried as a string inside a JSON log line has `\"` where the inner one has `"` (up to
//   three backslashes in front of the opening quote, as `json-secret` allows). The closing quote has the same
//   backslashes in front of it, and an inner escaped quote has more; the run is compared modulo 2, 4 or 8.
// - **No cap on the string, a cap on the missing end.** A string that ends is masked to its end, however long (a cap would
//   leave the tail of a long value behind). If no closing quote follows (cut text), the next JSON_STRING_CAP characters
//   fall; what lies beyond is no longer taken for the value.
// - **Linear.** The head is the bounded pattern `json-secret` uses. The scan moves forward only; a search that found no
//   closing quote of a kind is not repeated for that kind (`failedFrom`), and a masked value is not scanned again.
// - **Quotes.** A double-quoted value under any key; a single-quoted value too (shell and Python spelling). The value has to
//   be worth masking: the same exceptions as `json-secret` (harmless key, harmless value, kebab key needs a credential
//   shape), where a value with blanks is harmless only as a whole bracketed placeholder, a whole placeholder phrase, a
//   reference, a short word, or markers alone.
const JSON_STRING_CAP = 4096;
const JSON_SUFFIX_MAX = 12;
const JSON_HEAD = new RegExp(`(?<![A-Za-z0-9_])((["']?)[A-Za-z0-9_]{0,64}(?:${JSON_KEY_WORDS})([A-Za-z0-9_-]{0,64})(\\\\{0,3}["']?)${SP}*${SEP}${SP}*)(\\\\{0,3})(["'])`, 'gi');
const BRACKET_WHOLE = /^(?:<[^<>]{0,200}>|\{\{[^{}]{0,200}\}\}|\$\{[^{}]{0,200}\}|\[[^[\]]{0,200}\])$/;
const PLACEHOLDER_PHRASE = new RegExp(`^${PLACEHOLDER_WORD}[ _-]${GENERIC_WORD.replace('api[_-]?key', 'api[ _-]?key')}$`, 'i');

const PROSE_WORDS = 12;
function isProse(value) {
  let words = 0;
  for (const _ of value.matchAll(/\S+/g)) { // eslint-disable-line no-unused-vars
    words += 1;
    if (words >= PROSE_WORDS) return !looksLikeCredential(value);
  }
  return false;
}

/**
 * Is this key a kebab-case slug (`secret-leak`)? The hyphen INSIDE the keyword (`api-key`, `x-api-key`) does not make it
 * one: a header name is a key, not a vocabulary entry.
 */
function isKebabKey(key) {
  return /[A-Za-z0-9]-[A-Za-z0-9]/.test(key.replace(/[\\"'\s:=]+$/, '').replace(/(?:x-)?api-key/gi, 'apikey'));
}

function harmlessString(value) {
  const t = value.trim();
  if (!/\s/.test(t)) return isHarmless(t);
  if (t.length < 8 || MARKER_ONLY.test(t) || BRACKET_WHOLE.test(t) || PLACEHOLDER_PHRASE.test(t)) return true;
  return IS_REFERENCE.some((r) => r.test(t)) && !looksLikeCredential(t);
}

/**
 * Where the string opened at `from` ends. Returns `{close, to}`: `close` is the index of the closing quote (one of the
 * same kind, with `r0` backslashes in front of it, or more by a multiple of the modulus), or -1; `to` is how far the
 * search got (the text end, or the line end where it stopped: a raw line break cannot occur inside a JSON string, so a
 * quote on a later line closes some other string).
 */
function findClosingQuote(text, from, quote, r0) {
  const mod = r0 === 0 ? 2 : r0 <= 2 ? 4 : 8;
  let i = from;
  for (;;) {
    const q = text.indexOf(quote, i);
    // The nearest line break before the quote (or before the end): searched only up to the quote found.
    const stop = q < 0 ? text.length : q;
    const nl = findLineBreak(text, i, stop);
    if (nl >= 0) return { close: -1, to: nl, lineEnd: true };
    if (q < 0) return { close: -1, to: text.length, lineEnd: false };
    let run = 0;
    while (q - 1 - run >= from && text.charCodeAt(q - 1 - run) === 92) run += 1;
    if (run % mod === r0) return { close: q, to: q, lineEnd: false };
    i = q + 1;
  }
}

function findLineBreak(text, from, to) {
  for (let i = from; i < to; i += 1) {
    const c = text.charCodeAt(i);
    if (c === 10 || c === 13) return i;
  }
  return -1;
}

function redactJsonStrings(text, counter) {
  if (text.indexOf('"') < 0 && text.indexOf("'") < 0) return text;
  const re = new RegExp(JSON_HEAD.source, JSON_HEAD.flags);
  const failedFrom = new Map();
  let out = '';
  let copied = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const head = m[1];
    const suffix = m[3];
    const keyClose = m[4];
    const r0 = m[5].length;
    const quote = m[6];
    const start = m.index + m[0].length;
    // `indexOf('FOO_TOKEN=')`: a key that no quote closes, with a quote of the same kind in front of it (its own opening
    // one, or the one before an unquoted key), sits INSIDE a string literal, and the quote after the `=` closes it. That is
    // code, not a value.
    if (!/["']/.test(keyClose) && (m[2] || text[m.index - 1]) === quote) continue;
    const kind = `${quote}${r0}`;
    let found = failedFrom.get(kind);
    if (found === undefined || start >= found.to) {
      found = findClosingQuote(text, start, quote, r0);
      if (found.close < 0) failedFrom.set(kind, found);
    }
    // The line ended before the string did. Behind a key that a quote closes (`"password": "abc def`) that is a cut or broken
    // JSON line, and the rest of the line is the value. Behind a key that no quote closes it is code (`'FOO_PASSWORD=', x`):
    // not a string value, it stays with `json-secret` above.
    if (found.close < 0 && found.lineEnd && !/["']/.test(keyClose)) continue;
    const close = found.close;
    const end = close >= 0 ? close - r0 : Math.min(found.to, start + JSON_STRING_CAP);
    if (end <= start) continue;
    const value = text.slice(start, end);
    if (isHarmlessKey(head)) continue;
    // A value past the cap is no placeholder; the exceptions look at short values only.
    if (value.length <= JSON_STRING_CAP && harmlessString(value)) continue;
    // A value with blanks may be a sentence instead of a secret. Behind a key that a quote closes (`"password": "..."`, JSON
    // and its relatives) it is taken, unless the key goes on long after the keyword AND the value reads as prose:
    // `"token_system_is_a_facade": "<a paragraph>"`. Behind a bare key (`secrets: '...'` in code, `PASSWORD='...'` in an env
    // file) the key must end with the keyword (give or take a short suffix: `passwordHash`, `token_value`) and the value
    // must not read as prose (twelve words, no credential-shaped run). The gaps, named: a passphrase of twelve plain words
    // behind a bare key; a key with a long suffix behind which a phrase stands. The value without blanks is taken under every key.
    if (/\s/.test(value)) {
      const quotedKey = /["']/.test(keyClose);
      const longKey = suffix.length > JSON_SUFFIX_MAX;
      const prose = value.length <= JSON_STRING_CAP && isProse(value);
      if (quotedKey ? (longKey && prose) : (longKey || prose)) continue;
    }
    if (isKebabKey(head) && !looksLikeCredential(value)) continue;
    counter.set('json-secret', (counter.get('json-secret') ?? 0) + 1);
    out += `${text.slice(copied, start)}[REDACTED:json-secret]`;
    copied = end;
    re.lastIndex = end;
  }
  return copied === 0 ? text : out + text.slice(copied);
}

/**
 * Replace ONE group inside a match and leave every other byte alone.
 *
 * The old code rebuilt the match as `${name}=[REDACTED:...]`. That
 * hardcoded `=` and dropped whatever stood between name and value:
 * `const token = X` came back as `const token=[REDACTED]`, and a YAML
 * line `FOO_TOKEN: X` came back with a `=` it never had. A redaction
 * that reformats the surrounding code is a second, quieter corruption —
 * the digest then reads source that never existed.
 *
 * `lastIndexOf` and not `indexOf`: the value sits at the END of the
 * match, and a short value can also occur inside the key name
 * (`TOKEN_TOKEN=TOKEN`).
 */
function replaceValue(match, value, replacementText) {
  const at = match.lastIndexOf(value);
  if (at < 0) return match;
  return match.slice(0, at) + replacementText + match.slice(at + value.length);
}

/**
 * Redact a string.
 *
 * Returns `{text, found}` — `found` is a list of `{type, count}` so
 * the caller can report WHAT was removed without ever seeing the value.
 *
 * **The redacted value is never retained.** Not in a log, not in a
 * return value, not in a file. Whoever needs it has it at the source.
 */
export function redact(text) {
  if (typeof text !== 'string' || !text) return { text: text ?? '', found: [] };

  const counter = new Map();
  let out = text;

  for (const [type, pattern] of PATTERNS) {
    // Fresh RegExp per pass — `g` flags carry lastIndex with them.
    const r = new RegExp(pattern.source, pattern.flags);
    out = out.replace(r, (match, ...groups) => {
      // For the assignment patterns the value sits in the last group;
      // we keep the key name and redact only the right-hand side.
      const real = groups.slice(0, -2).filter((g) => typeof g === 'string');

      if (type === 'env-secret' && real.length >= 2) {
        // No HARMLESS_KEY here on purpose: `NEXT_TOKEN=...` in an
        // environment is not a JSON cursor, and it was redacted before.
        const [, value] = real;
        if (isHarmless(value)) return match;
        counter.set(type, (counter.get(type) ?? 0) + 1);
        return replaceValue(match, value, `[REDACTED:${type}]`);
      }
      if (type === 'json-secret' && real.length >= 2) {
        const [key, value] = real;
        if (isHarmlessKey(key)) return match;
        if (isHarmless(value)) return match;
        // **A kebab-case key needs a credential-shaped value.** Widening
        // the key reached `'secret-leak': '...'` in src/errorclass.mjs — a
        // map from one error-class slug to another, no secret anywhere,
        // and the pre-commit hook would have blocked the next edit of
        // that file. Kebab keys are vocabulary far more often than
        // configuration, so there (and only there) the value must also
        // look like a key: letters AND digits in a run of 12+.
        // The gap this leaves, named: a diceware-style passphrase
        // (`"secret-value": "correct-horse-battery"`) under a kebab key.
        // camelCase and bare keys are untouched.
        if (isKebabKey(key) && !looksLikeCredential(value)) return match;
        counter.set(type, (counter.get(type) ?? 0) + 1);
        return replaceValue(match, value, `[REDACTED:${type}]`);
      }
      // Signed URL: the name and the equals sign stay, the value falls.
      if ((type === 'signed-url' || type === 'viewer-access') && real.length >= 2) {
        const [head, value] = real;
        if (isHarmless(value)) return match;
        counter.set(type, (counter.get(type) ?? 0) + 1);
        return `${head}[REDACTED:${type}]`;
      }
      if (type === 'url-credentials' && real.length >= 1) {
        counter.set(type, (counter.get(type) ?? 0) + 1);
        return `${real[0]}://[REDACTED:${type}]@`;
      }
      // The pair form keeps the address and the separator — it is not
      // itself a secret, and whoever reads the finding should know WHOSE
      // access is meant, or the report is not actionable.
      if (type === 'credential-pair' && real.length >= 3) {
        const [who, sep, value] = real;
        if (isHarmless(value)) return match;
        // `git@github.com:Owner/repo.git` is an scp-style remote, not an address followed by a credential: the
        // separator is a bare colon and the "value" is a repository path (a `.git` suffix, or `owner/repo` after the `git` user). A bare secret after `git@host:` is still masked.
        if (sep === ':' && (/\.git$/i.test(value) || (/^git@/i.test(who) && /^[\w.-]+\/[\w./-]+$/.test(value)))) return match;
        counter.set(type, (counter.get(type) ?? 0) + 1);
        return `${who}${sep}[REDACTED:${type}]`;
      }

      if (isHarmless(match)) return match;
      counter.set(type, (counter.get(type) ?? 0) + 1);
      return `[REDACTED:${type}]`;
    });
    // The whole-string pass follows the pattern of the same name (see redactJsonStrings).
    if (type === 'json-secret') out = redactJsonStrings(out, counter);
  }

  return {
    text: out,
    found: [...counter].map(([type, count]) => ({ type, count })),
  };
}

/**
 * Redact a whole object recursively (for JSONL lines from a
 * transcript). Keys are left alone; only values are examined.
 */
export function redactObject(o, found = new Map()) {
  if (typeof o === 'string') {
    const r = redact(o);
    for (const f of r.found) found.set(f.type, (found.get(f.type) ?? 0) + f.count);
    return r.text;
  }
  if (Array.isArray(o)) return o.map((x) => redactObject(x, found));
  if (o && typeof o === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(o)) out[k] = redactObject(v, found);
    return out;
  }
  return o;
}

// --- Layer 2: match against the actual values ------------------------
//
// Patterns catch known SHAPES. This layer catches the concrete secrets
// currently in play, whether or not their shape was ever listed. While
// capturing, they sit in `process.env`; an exact text match finds them
// reliably.
//
// **The value is never retained.** It is read, searched for, replaced —
// and then falls out of memory. Neither log nor return value nor file
// ever sees it.

/**
 * Variable names that are never a secret, however long.
 *
 * GIT_CONFIG_* earns its place the hard way: git sets those itself
 * while running a hook (`git -c key=value ...` becomes GIT_CONFIG_KEY_n
 * / GIT_CONFIG_VALUE_n). They hold configuration — a branch name, a
 * user name, a path. This repo's own first commit was refused because
 * one of those values also appeared in the README.
 *
 * That is the failure mode of layer 2 in general: it matches VALUES,
 * so any long-ish env value that happens to be ordinary text produces
 * a false positive. Silencing it by shortening the list would be
 * wrong; naming the specific offenders is the honest fix.
 */
// **The Windows half was missing, and that made the tool unusable there.**
// The list knew USER and LOGNAME but not USERNAME. On a machine where
// the account is `Administrator`, that name sits inside every path
// under `C:\\Users\\` — so redaction replaced every path it saw, and
// the pre-commit hook refused every commit that mentioned one. Reported
// 2026-09-07 from a fresh Windows install and reproduced here.
//
// Case-insensitive for the same reason: Windows environment variable
// names are case-insensitive, and a program may hand us `Username` or
// `USERPROFILE` in whatever case it likes. A list that only matches one
// spelling is a list with holes in it.
//
// These names are harmless because they identify a MACHINE or an
// ACCOUNT, not a credential. The value check below still applies to
// everything not on this list.
const ENV_HARMLESS = /^(PATH|HOME|PWD|OLDPWD|SHELL|TERM|LANG|LC_[A-Z]+|USER|LOGNAME|HOSTNAME|TMPDIR|EDITOR|PAGER|SHLVL|_|NODE_PATH|npm_.*|XDG_.*|LS_COLORS|MANPATH|INFOPATH|GIT_CONFIG_.*|GIT_(DIR|WORK_TREE|INDEX_FILE|AUTHOR_.*|COMMITTER_.*|EDITOR|PAGER|EXEC_PATH|PREFIX)|CI|GITHUB_(WORKSPACE|REPOSITORY|REF.*|SHA|ACTOR|WORKFLOW|RUN_.*|ACTION.*|EVENT_NAME|BASE_REF|HEAD_REF|SERVER_URL|API_URL|GRAPHQL_URL|JOB|PATH|ENV|STEP_SUMMARY|OUTPUT|STATE)|USERNAME|USERPROFILE|USERDOMAIN(_ROAMINGPROFILE)?|COMPUTERNAME|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|ALLUSERSPROFILE|PROGRAMDATA|PROGRAMFILES(\(X86\))?|PROGRAMW6432|COMMONPROGRAMFILES(\(X86\)|W6432)?|SYSTEMROOT|SYSTEMDRIVE|WINDIR|TEMP|TMP|COMSPEC|PATHEXT|PSMODULEPATH|PUBLIC|SESSIONNAME|OS|PROCESSOR_.*|NUMBER_OF_PROCESSORS|LOGONSERVER|DRIVERDATA|ONEDRIVE.*)$/i;

// A harmless-looking NAME never outweighs a secret-looking one. The
// list above is case-insensitive and has wildcards (`npm_.*`), so
// without this check NPM_TOKEN or npm_config__authToken rode through as
// "harmless" and their values were never matched (audit 2026-09-30,
// B2). `_AUTH` only counts at a word end or before `_`, so
// GIT_AUTHOR_NAME stays harmless.
const ENV_SECRET_NAME = /(TOKEN|SECRET|PASSW(OR)?D|CREDENTIAL|API_?KEY|PRIVATE_?KEY|_AUTH($|_)|AUTHTOKEN)/i;

function envNameHarmless(name) {
  return ENV_HARMLESS.test(name) && !ENV_SECRET_NAME.test(name);
}

/** Values that look like a path, a URL without credentials, or a
 *  version — long, but not a secret. */
function envValueHarmless(v) {
  if (v.length < 12) return true;
  if (v.includes('/') && !v.includes('://')) return true;     // path
  if (/^https?:\/\/[^@]*$/.test(v)) return true;              // URL, no creds
  if (/^[\d.]+$/.test(v)) return true;                        // version
  if (/^[a-z0-9_.-]+$/.test(v) && !/\d/.test(v)) return true; // plain words
  return false;
}

/**
 * A session's own id is not a secret (error 1rmp6w45nul6, mirrored from
 * lucky-mem d341ee2b: the raw capture of cloud sessions never reached the
 * repo).
 *
 * In cloud sessions the id sits in CLAUDE_CODE_SESSION_ID (a UUID) and
 * CLAUDE_CODE_REMOTE_SESSION_ID (`session_01...` / `cse_01...`). The raw
 * capture carries it by design (stamp and file name in raw-record.jsonl,
 * raw/...--<uuid>.jsonl.gz); the env match took it for a secret and the
 * pre-commit rejected every raw-capture commit.
 *
 * Deliberately a pair of name AND shape: exactly these two names, and only
 * when the value has the id shape. Anything else in those names (a token)
 * stays a secret; every other variable (CONTAINER_ID, *_UUID, *_TOKEN)
 * stays untouched. The pattern layer (`redact`) is not involved.
 */
const SESSION_ID_NAMES = /^CLAUDE_CODE_(?:REMOTE_)?SESSION_ID$/;
const SESSION_ID_SHAPE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?:session|cse)_01[A-Za-z0-9]{16,40})$/;
function isSessionId(name, value) {
  return SESSION_ID_NAMES.test(name) && SESSION_ID_SHAPE.test(value);
}

/**
 * Collect the values to match against.
 *
 * Every env value that is long enough and not obviously harmless is
 * taken — not only the ones with `TOKEN` in the name. A secret in
 * `MY_THING=...` is just as much a secret.
 *
 * Sorted longest first, so a longer value is replaced before a shorter
 * one contained inside it can cut the replacement in half.
 */
export function envSecrets(env = process.env) {
  const out = [];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue;
    if (envNameHarmless(name)) continue;
    if (envValueHarmless(value)) continue;
    if (isSessionId(name, value)) continue;
    out.push({ name, value });
  }
  out.sort((a, b) => b.value.length - a.value.length);
  return out;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Match text against the real env values. Second layer, runs AFTER the
 * patterns (whatever they already redacted is gone).
 */
export function redactAgainstEnv(text, secrets = envSecrets()) {
  if (typeof text !== 'string' || !text) return { text: text ?? '', found: [] };
  let out = text;
  const counter = new Map();
  for (const { name, value } of secrets) {
    if (!out.includes(value)) continue;
    const r = new RegExp(escapeRegex(value), 'g');
    let n = 0;
    out = out.replace(r, () => { n += 1; return `[REDACTED:env:${name}]`; });
    if (n) counter.set(`env:${name}`, (counter.get(`env:${name}`) ?? 0) + n);
  }
  return { text: out, found: [...counter].map(([type, count]) => ({ type, count })) };
}

// --- Layer 3: canary -------------------------------------------------
//
// A self-test that runs BEFORE every capture. If a rule falls over —
// through a typo, an "improvement", a botched merge — the redaction
// does not stay quiet; the capture aborts.
//
// A silent failure is the most dangerous state: everything keeps
// running, just unprotected.

/**
 * Exported so nothing else has to write a second copy of these samples.
 *
 * `bench/atlas/phase-doctor.mjs` needs the exact aws-key-id sample twice:
 * once to plant it in a capture, once to patch it back out of a copy of
 * this file. Hard-coding it there made two problems at once — a second
 * source of truth that silently rots when a sample moves, and a literal
 * that looks exactly like a leaked credential to this repo's own
 * pre-commit scanner, which reported it and was right to.
 */
export const CANARIES = Object.freeze([
  ['anthropic-key', `sk-ant-api03-${'K'.repeat(28)}`],
  ['openai-key',    `sk-${'K'.repeat(32)}`],
  ['github-token',  `ghp_${'K'.repeat(36)}`],
  ['voyage-key',    `pa-${'K'.repeat(34)}`],
  ['aws-key-id',    'AKIAIOSFODNN7EXAMPLE'],
  ['jwt',           'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.KKKKKKKKKKKKKKKK'],
  ['bearer',        `Authorization: Bearer ${'K'.repeat(32)}`],
  ['env-secret',    'export DB_PASSWORD=NotSecret123abc'],
  ['env-secret-bare', 'https://example.test/x?token=NotSecretButLongEnough123'],
  ['json-blob',     `eyJ${'K'.repeat(60)}`],
  ['url-credentials', 'postgres://user:SecretWord99@host:5432/db'],
  ['pem-block',     '-----BEGIN RSA PRIVATE KEY-----\nKKKK==\n-----END RSA PRIVATE KEY-----'],
  ['signed-url',    `https://example.test/x?X-Amz-Signature=${'k7'.repeat(32)}&X-Amz-Expires=60`],
  ['viewer-access', `https://mem.example.test/?k=${'K'.repeat(32)}`],
]);

/**
 * How many canaries there MUST be.
 *
 * Without this number the self-test could be defeated by deleting a
 * rule *together with its canary* — nothing would look wrong, because
 * nobody asks any more. Carrying the number by hand is tedious and
 * that is exactly the point: whoever removes a canary has to say so
 * here.
 */
export const CANARY_COUNT = 14;

/**
 * Check that the redaction still does what it claims.
 * Returns `{ok: true}` or `{ok: false, failed: [...]}`.
 */
export function selfTest() {
  const failed = [];

  if (CANARIES.length < CANARY_COUNT) {
    failed.push({
      type: '(inventory)',
      reason: `only ${CANARIES.length} of ${CANARY_COUNT} canaries present`,
    });
  }

  for (const [expected, sample] of CANARIES) {
    const e = redact(sample);
    if (e.found.length === 0) {
      failed.push({ type: expected, reason: 'nothing-caught' });
      continue;
    }
    // The canary must not survive in the result.
    if (/K{16,}/.test(e.text) || e.text.includes('SecretWord99')
        || e.text.includes('NotSecret123abc')) {
      failed.push({ type: expected, reason: 'value-remained' });
    }
  }
  return failed.length === 0
    ? { ok: true, checked: CANARIES.length }
    : { ok: false, checked: CANARIES.length, failed };
}

/**
 * Convenience entry point for capture: object in, `{object, found}`
 * out. Runs both layers — patterns, then the env match.
 *
 * `secrets` is injectable so the env layer can be tested without real
 * secrets.
 */
export function redactEntry(o, { secrets = null } = {}) {
  const found = new Map();
  let object = redactObject(o, found);

  const s = secrets ?? envSecrets();
  if (s.length) object = envPass(object, s, found);

  return {
    object,
    found: [...found].map(([type, count]) => ({ type, count })),
  };
}

function envPass(o, secrets, found) {
  if (typeof o === 'string') {
    const r = redactAgainstEnv(o, secrets);
    for (const f of r.found) found.set(f.type, (found.get(f.type) ?? 0) + f.count);
    return r.text;
  }
  if (Array.isArray(o)) return o.map((x) => envPass(x, secrets, found));
  if (o && typeof o === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(o)) out[k] = envPass(v, secrets, found);
    return out;
  }
  return o;
}
