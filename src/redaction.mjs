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
export const PATTERNS = Object.freeze([
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
  ['json-blob',       /\beyJ[A-Za-z0-9_-]{40,}={0,2}(?![A-Za-z0-9_.-])/g],
  ['pem-block',       /-----BEGIN[^-]{0,40}-----[\s\S]*?-----END[^-]{0,40}-----/g],
  ['ssh-key',         /\bssh-(?:rsa|ed25519|dss)\s+[A-Za-z0-9+/=]{50,}/g],

  // --- Headers / URLs ------------------------------------------------
  ['bearer',          /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}=*/g],
  ['basic-auth',      /\b[Bb]asic\s+[A-Za-z0-9+/]{20,}=*/g],
  ['url-credentials', /\b([a-z][a-z0-9+.-]*):\/\/[^\s:@/]+:[^\s@/]+@/gi],
  ['x-api-key',       /\b(x-api-key|api[_-]?key|apikey)\s*[:=]\s*["']?[A-Za-z0-9._-]{16,}["']?/gi],

  // --- Environment variables -----------------------------------------
  // Covers `export FOO_TOKEN=...`, `FOO_SECRET: ...`, `"password": "..."`
  ['env-secret',
    // The prefix before the keyword is OPTIONAL. It used to be
    // [A-Za-z_][A-Za-z0-9_]* — at least one character — which let a
    // bare `token=...` in a URL slip through.
    /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|APIKEY|API_KEY|PRIVATE_KEY|CREDENTIAL|SESSION_KEY)[A-Za-z0-9_]*)\s*[:=]\s*["']?([^\s"'`,;&]{8,})["']?/gi],

  // Lowercase in JSON/YAML: "password": "...", secret: ...
  ['json-secret',
    /(["']?(?:password|passwd|secret|token|api_key|apikey|private_key|access_key|client_secret|refresh_token)["']?\s*[:=]\s*)["']([^"'\s]{8,})["']/gi],
]);

/**
 * If a match looks like one of these, it is NOT a secret — a
 * placeholder, an example, something already redacted. Otherwise we
 * redact our own documentation and the error messages turn to mush.
 */
const HARMLESS = [
  /^(x{3,}|\*{3,}|\.{3,}|-{3,})$/i,
  /^(your|my|test|example|sample|dummy|fake|placeholder|redacted|changeme)/i,
  /^(<|\{|\$\{|%|\[)/,            // <TOKEN>, ${VAR}, {{secret}}, [redacted]
  /^(null|undefined|none|nil|true|false|empty)$/i,
  /^REDACTED/,
  /^\.\.\./,
];

/**
 * A "value" that itself looks like another assignment is prose ABOUT
 * secrets, not a secret.
 *
 * Writing down which patterns are still missing — `token=/api_key=` —
 * makes the env pattern match itself. Whoever writes about the rules
 * trips them; without this exception you can never commit your own bug
 * report about the redaction.
 *
 * Deliberately narrow: it requires a keyword FOLLOWED by `=` or `:`. A
 * real secret like `supersecrettoken123` contains 'token' but no second
 * assignment, so it still gets redacted.
 */
const PROSE_ABOUT_SECRETS =
  /(token|secret|password|passwd|passphrase|apikey|api_key|private_key|credential|session_key)\s*[:=]/i;

function isHarmless(s) {
  const t = String(s).trim();
  if (t.length < 8) return true;
  if (PROSE_ABOUT_SECRETS.test(t)) return true;
  return HARMLESS.some((r) => r.test(t));
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
        const [name, value] = real;
        if (isHarmless(value)) return match;
        counter.set(type, (counter.get(type) ?? 0) + 1);
        return `${name}=[REDACTED:${type}]`;
      }
      if (type === 'json-secret' && real.length >= 2) {
        const [prefix, value] = real;
        if (isHarmless(value)) return match;
        counter.set(type, (counter.get(type) ?? 0) + 1);
        return `${prefix}"[REDACTED:${type}]"`;
      }
      if (type === 'url-credentials' && real.length >= 1) {
        counter.set(type, (counter.get(type) ?? 0) + 1);
        return `${real[0]}://[REDACTED:${type}]@`;
      }

      if (isHarmless(match)) return match;
      counter.set(type, (counter.get(type) ?? 0) + 1);
      return `[REDACTED:${type}]`;
    });
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
const ENV_HARMLESS = /^(PATH|HOME|PWD|OLDPWD|SHELL|TERM|LANG|LC_[A-Z]+|USER|LOGNAME|HOSTNAME|TMPDIR|EDITOR|PAGER|SHLVL|_|NODE_PATH|npm_.*|XDG_.*|LS_COLORS|MANPATH|INFOPATH|GIT_CONFIG_.*|GIT_(DIR|WORK_TREE|INDEX_FILE|AUTHOR_.*|COMMITTER_.*|EDITOR|PAGER|EXEC_PATH|PREFIX)|CI|GITHUB_(WORKSPACE|REPOSITORY|REF.*|SHA|ACTOR|WORKFLOW|RUN_.*|ACTION.*|EVENT_NAME|BASE_REF|HEAD_REF|SERVER_URL|API_URL|GRAPHQL_URL|JOB|PATH|ENV|STEP_SUMMARY|OUTPUT|STATE))$/;

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
    if (ENV_HARMLESS.test(name)) continue;
    if (envValueHarmless(value)) continue;
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

const CANARIES = Object.freeze([
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
export const CANARY_COUNT = 12;

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
