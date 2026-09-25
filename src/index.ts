interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * UK Gazette MCP — The Gazette (www.thegazette.co.uk), the UK's official
 * public record (London / Edinburgh / Belfast editions). Keyless JSON API.
 *
 * Tools:
 * - gazette_search_notices: full-text + filtered search of all published notices
 * - gazette_insolvency_notices: corporate/personal insolvency search (company distress)
 * - gazette_deceased_estates: deceased-estates notices (probate/heir research)
 * - gazette_get_notice: structured JSON-LD detail for one notice
 * - gazette_notice_categories: browse the notice-category taxonomy
 *
 * QUIRKS (all verified live 2026-07-21 — the official DevDocs are stale):
 * - Notice-type filter param is `noticetypes` (PLURAL). The documented
 *   `noticetype` is silently IGNORED and returns the unfiltered set.
 * - Edition filtering is PATH-based: /{service}/{edition}/notice with a
 *   lowercase edition segment. The documented `edition=` query param 303s.
 * - `categorycode` accepts the website's G-codes (G205010000) and the docs'
 *   legacy 2-digit codes, multiple values joined with '+'.
 * - Single-notice JSON: /notice/{id}/data.jsonld works; the documented
 *   `.json?view=linked-data` returns 202 forever (async view never ready).
 * - /notice-taxonomy is auth-gated (500s anonymously) — the CATEGORIES table
 *   below was extracted from the public search form instead.
 * - Upstream has multi-day 500 outages on record (2026-07 was one); the
 *   fetch helper retries once on 5xx.
 * - Requests with NO User-Agent are 403'd (any UA passes). CF Workers' fetch
 *   sends none by default, so every request here must set one explicitly.
 * - NEVER send `Accept: application/json` — the search endpoints and
 *   data.jsonld 500 on it (content-negotiation bug; the .json/.jsonld suffix
 *   already selects the format). Send the wildcard Accept instead (see
 *   rawFetch). This masqueraded as a CF-egress block for a whole debug
 *   cycle, because local curl defaults to the wildcard.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'UK Gazette');
}


const BASE_URL = 'https://www.thegazette.co.uk';

const tools: McpToolExport['tools'] = [
  {
    name: 'gazette_search_notices',
    description:
      'Search The Gazette — the UK\'s official public record of statutory notices (London, Edinburgh and Belfast editions, archive back to 1665). Full-text search plus filters for notice category, publication date range, edition, and location. Covers company events (liquidations, administrations, winding-up petitions, name changes), personal insolvency, deceased estates, road/planning orders, honours, state and royal notices. Use for "official UK notices about X", "gazette notices for company Y", "road closure orders near Z". Example: gazette_search_notices({ query: "Tesco", category: "corporate insolvency" })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Full-text search — company name, person, place, or any words appearing in the notice text' },
        category: { type: 'string', description: 'Notice category — a name like "corporate insolvency", "wills & probate", "road restrictions", or a code from gazette_notice_categories (G-code or legacy 2-digit)' },
        notice_types: { type: 'string', description: 'Advanced: one or more 4-digit notice type codes joined with "+", e.g. "2450" (petitions to wind up)' },
        edition: { type: 'string', description: 'Restrict to one edition: "london", "edinburgh", or "belfast"' },
        published_after: { type: 'string', description: 'Earliest publication date, YYYY-MM-DD' },
        published_before: { type: 'string', description: 'Latest publication date, YYYY-MM-DD' },
        location: { type: 'string', description: 'UK postcode or town/city name to search around (needs distance_miles, default 5)' },
        distance_miles: { type: 'number', description: 'Radius in miles around location (default 5)' },
        sort: { type: 'string', description: '"newest" (default) or "oldest"' },
        page: { type: 'number', description: 'Results page, starting at 1' },
        limit: { type: 'number', description: 'Results per page, 1-50 (default 10)' },
      },
      required: [],
    },
  },
  {
    name: 'gazette_insolvency_notices',
    description:
      'Search official UK insolvency notices in The Gazette — the statutory public record where liquidations, administrations, winding-up petitions and orders, bankruptcy orders, creditors\' meetings, and notices to creditors MUST be published. The go-to source for "is UK company X in liquidation/administration", monitoring company distress, or tracking personal bankruptcies. Search by company name or Companies House number (both are indexed). scope narrows to "corporate" or "personal" insolvency. Example: gazette_insolvency_notices({ company: "Wilko", scope: "corporate" })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        company: { type: 'string', description: 'Company name, Companies House number, or person name to search' },
        scope: { type: 'string', description: '"corporate" (default), "personal", or "all"' },
        notice_types: { type: 'string', description: 'Advanced: 4-digit notice type codes joined with "+", e.g. "2450" petitions to wind up' },
        published_after: { type: 'string', description: 'Earliest publication date, YYYY-MM-DD' },
        published_before: { type: 'string', description: 'Latest publication date, YYYY-MM-DD' },
        page: { type: 'number', description: 'Results page, starting at 1' },
        limit: { type: 'number', description: 'Results per page, 1-50 (default 10)' },
      },
      required: [],
    },
  },
  {
    name: 'gazette_deceased_estates',
    description:
      'Search UK deceased-estates notices in The Gazette (Trustee Act 1925 s.27 notices) — executors advertise a death so creditors and claimants can come forward before the estate is distributed. Used for probate research, tracing an estate, checking whether a death notice was placed, and finding the claim deadline. Filter by name, date of death, claim expiry date, or location. Example: gazette_deceased_estates({ name: "John Smith", died_after: "2026-01-01" })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Name of the deceased person' },
        died_after: { type: 'string', description: 'Earliest date of death, YYYY-MM-DD' },
        died_before: { type: 'string', description: 'Latest date of death, YYYY-MM-DD' },
        claim_expires_after: { type: 'string', description: 'Earliest claim-expiry date, YYYY-MM-DD (find estates still open to claims by setting this to today)' },
        claim_expires_before: { type: 'string', description: 'Latest claim-expiry date, YYYY-MM-DD' },
        location: { type: 'string', description: 'UK postcode or town/city name to search around (needs distance_miles, default 5)' },
        distance_miles: { type: 'number', description: 'Radius in miles around location (default 5)' },
        page: { type: 'number', description: 'Results page, starting at 1' },
        limit: { type: 'number', description: 'Results per page, 1-50 (default 10)' },
      },
      required: [],
    },
  },
  {
    name: 'gazette_get_notice',
    description:
      'Get the structured record for one Gazette notice by its ID (from any gazette search tool, or a thegazette.co.uk/notice/<id> URL). Returns the notice type, publication date, gazette edition and issue, companies named (with Companies House numbers), people, addresses with coordinates, related legislation, and key dates. Example: gazette_get_notice({ notice_id: "4123456" })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        notice_id: { type: 'string', description: 'Notice ID — numeric (e.g. "4123456") or legacy alphanumeric (e.g. "L-60768-1986497")' },
      },
      required: ['notice_id'],
    },
  },
  {
    name: 'gazette_notice_categories',
    description:
      'Browse The Gazette\'s notice-category taxonomy — the category codes accepted by gazette_search_notices. Optionally filter by a search word. Categories span companies (insolvency, name changes, mergers), people (bankruptcy, deceased estates, honours), environment & infrastructure (planning, roads, property), state/royal/church notices, and money (pensions, coinage). Example: gazette_notice_categories({ search: "insolvency" })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        search: { type: 'string', description: 'Optional word to filter category names, e.g. "insolvency", "roads", "probate"' },
      },
      required: [],
    },
  },
];

// ---------------------------------------------------------------------------
// Notice categories, extracted from the public search form 2026-07-21 (the
// /notice-taxonomy endpoint is auth-gated). First digit after G is the level
// (1 = top, 2/3 = mid, 4 = leaf); all levels work as categorycode filters.
const CATEGORIES: Array<{ code: string; name: string }> = [
  { code: 'G101000000', name: 'State' },
  { code: 'G102000000', name: 'Royal family' },
  { code: 'G103000000', name: 'Parliament Assemblies & Government' },
  { code: 'G104000000', name: 'Church' },
  { code: 'G105000000', name: 'Companies' },
  { code: 'G106000000', name: 'People' },
  { code: 'G107000000', name: 'Money' },
  { code: 'G108000000', name: 'Environment & infrastructure' },
  { code: 'G110000000', name: 'Health & medicine' },
  { code: 'G111000000', name: 'Honours & awards' },
  { code: 'G201010000', name: 'Departments of State' },
  { code: 'G205010000', name: 'Corporate insolvency' },
  { code: 'G205020000', name: 'Mutual societies' },
  { code: 'G205020200', name: 'Partnerships' },
  { code: 'G206010000', name: 'Appointments & retirements' },
  { code: 'G206030000', name: 'Personal insolvency' },
  { code: 'G206040000', name: 'Wills & probate' },
  { code: 'G208010000', name: 'Communications' },
  { code: 'G208020000', name: 'Planning' },
  { code: 'G208030000', name: 'Property & land' },
  { code: 'G208040000', name: 'Roads & highways' },
  { code: 'G210000000', name: 'Public health: Coronavirus' },
  { code: 'G211010000', name: 'State Awards' },
  { code: 'G211040000', name: 'Decorations and Medals' },
  { code: 'G305010100', name: 'Administration' },
  { code: 'G305010200', name: "Creditors' voluntary liquidation" },
  { code: 'G305010300', name: 'Liquidation by the Court' },
  { code: 'G305010400', name: "Members' voluntary liquidation" },
  { code: 'G305010500', name: 'Receivership' },
  { code: 'G306010300', name: 'State appointments' },
  { code: 'G401000001', name: 'Arms, crests & badges' },
  { code: 'G401000003', name: 'Proclamations' },
  { code: 'G401010001', name: 'Crown Office' },
  { code: 'G401010002', name: 'HM Treasury' },
  { code: 'G401010003', name: 'Home Office' },
  { code: 'G401010004', name: 'Ministry of Defence' },
  { code: 'G401010005', name: 'Privy Council Office' },
  { code: 'G401010006', name: 'Scottish Government' },
  { code: 'G402000001', name: 'Loyal addresses and responses' },
  { code: 'G402000002', name: 'Royal occasions' },
  { code: 'G403000003', name: 'Legislation & treaties' },
  { code: 'G404000001', name: 'Church buildings' },
  { code: 'G404000003', name: 'Registration for solemnising marriage' },
  { code: 'G405000001', name: 'Changes in capital structure' },
  { code: 'G405000002', name: 'Companies House documents' },
  { code: 'G405000003', name: 'Companies removed from register' },
  { code: 'G405000004', name: 'Companies restored to the register' },
  { code: 'G405000005', name: 'Company director disqualification order' },
  { code: 'G405000006', name: 'Competition' },
  { code: 'G405000007', name: 'European Economic Interest Grouping' },
  { code: 'G405000008', name: 'Pre-emption offers to shareholders' },
  { code: 'G405000009', name: 'Schemes of arrangement' },
  { code: 'G405000010', name: 'Takeovers, transfers & mergers' },
  { code: 'G405000011', name: 'Employment Agencies' },
  { code: 'G405010001', name: 'Insolvency practitioner applications' },
  { code: 'G405010002', name: 'Moratoria' },
  { code: 'G405010003', name: 'Notices of dividends' },
  { code: 'G405010004', name: 'Other corporate insolvency notices' },
  { code: 'G405010005', name: 'Overseas territories & cross-border insolvencies' },
  { code: 'G405010006', name: 'Re-use of a prohibited name' },
  { code: 'G405010007', name: 'Qualifying decision procedure' },
  { code: 'G405020001', name: 'Building societies' },
  { code: 'G405020002', name: 'Friendly societies' },
  { code: 'G405020003', name: 'Industrial & provident societies' },
  { code: 'G405020004', name: 'Co-operative and Community Benefit Societies' },
  { code: 'G405020201', name: 'Bankruptcy orders' },
  { code: 'G405020202', name: 'Change in the members of a partnership' },
  { code: 'G405020203', name: 'Dissolution of partnership' },
  { code: 'G405020204', name: 'Petitions to wind-up' },
  { code: 'G405020206', name: 'Transfer of interest' },
  { code: 'G405020207', name: 'Winding-up order' },
  { code: 'G406000002', name: 'Changes of name or arms' },
  { code: 'G406010002', name: 'Parliamentary & Assembly appointments' },
  { code: 'G406010003', name: 'Royal household appointments' },
  { code: 'G406030001', name: 'Administration orders' },
  { code: 'G406030002', name: 'Amendment of title of proceedings' },
  { code: 'G406030003', name: 'Annulment or rescindment' },
  { code: 'G406030004', name: 'Appointment and release of trustees' },
  { code: 'G406030005', name: 'Bankruptcy orders' },
  { code: 'G406030006', name: 'Discharge from bankruptcy' },
  { code: 'G406030007', name: 'Final Meetings' },
  { code: 'G406030008', name: 'Meeting of creditors' },
  { code: 'G406030009', name: 'Notices of dividends' },
  { code: 'G406030010', name: 'Notices to creditors' },
  { code: 'G406030011', name: 'Public examinations' },
  { code: 'G406030012', name: 'Recall of sequestration' },
  { code: 'G406030013', name: 'Sequestrations' },
  { code: 'G406030014', name: 'Statutory demands' },
  { code: 'G406030015', name: 'Substituted service of petition' },
  { code: 'G406030016', name: 'Trust deeds' },
  { code: 'G406030017', name: 'Deemed consent' },
  { code: 'G406030018', name: 'Qualifying decision procedure' },
  { code: 'G406040001', name: 'Deceased estates' },
  { code: 'G406040002', name: 'Missing wills' },
  { code: 'G406040003', name: 'Unclaimed estates' },
  { code: 'G407000001', name: 'Coinage & banknotes' },
  { code: 'G407000002', name: 'Pensions' },
  { code: 'G407000004', name: 'Savings & investments' },
  { code: 'G408000001', name: 'Agriculture, forestry & fisheries' },
  { code: 'G408000002', name: 'Animals & animal products' },
  { code: 'G408000003', name: 'Countryside, parks & nature reserves' },
  { code: 'G408000004', name: 'Energy' },
  { code: 'G408000005', name: 'Environmental protection' },
  { code: 'G408000006', name: 'Ports & harbours' },
  { code: 'G408000007', name: 'Transport' },
  { code: 'G408000008', name: 'Water' },
  { code: 'G408010001', name: 'Postal services' },
  { code: 'G408010002', name: 'Telecommunications' },
  { code: 'G408020001', name: 'Burial grounds' },
  { code: 'G408020004', name: 'Town planning' },
  { code: 'G408030001', name: 'Acquisition & disposal of land' },
  { code: 'G408030002', name: 'Property disclaimers' },
  { code: 'G408030003', name: 'Seizure & detainment of property' },
  { code: 'G408040001', name: 'Cycle tracks, bus lanes & tramways' },
  { code: 'G408040002', name: 'Parking, waiting & loading' },
  { code: 'G408040004', name: 'Road restrictions' },
  { code: 'G410000002', name: 'Medicines & medical equipment' },
  { code: 'G410000003', name: 'Public health' },
  { code: 'G410000004', name: 'Veterinary medicines' },
  { code: 'G411000001', name: 'Other Notices' },
  { code: 'G411010001', name: 'Knights Bachelor' },
  { code: 'G411010002', name: 'Order of the Garter' },
  { code: 'G411010003', name: 'Order of the Thistle' },
  { code: 'G411010004', name: 'Order of the Bath' },
  { code: 'G411010006', name: 'Order of St Michael and St George' },
  { code: 'G411010011', name: 'The Royal Victorian Order' },
  { code: 'G411010012', name: 'Order of Merit' },
  { code: 'G411010014', name: 'Order of the British Empire' },
  { code: 'G411010015', name: 'Order of the Companions of Honour' },
  { code: 'G411020001', name: 'Order of St John' },
  { code: 'G411040012', name: 'George Medal' },
  { code: 'G411040023', name: 'British Empire Medal' },
];

const EDITIONS = ['london', 'edinburgh', 'belfast'];

// ---------------------------------------------------------------------------

interface FeedEntry {
  id?: string;
  'f:status'?: string;
  'f:notice-code'?: string;
  title?: string;
  published?: string;
  updated?: string;
  category?: { '@term'?: string } | Array<{ '@term'?: string }>;
  content?: string;
}

interface Feed {
  'f:total'?: string;
  'f:page-number'?: string;
  entry?: FeedEntry[];
}

// UA required (no-UA → 403); Accept MUST stay */* (application/json → 500).
async function rawFetch(url: string): Promise<Response> {
  return pwFetch(url, {
    headers: { Accept: '*/*', 'User-Agent': 'Pipeworx/1.0 (pipeworx.io)' },
  });
}

async function gazetteFetch(path: string, params: URLSearchParams): Promise<Feed> {
  const url = `${BASE_URL}${path}?${params}`;
  let res = await rawFetch(url);
  if (res.status >= 500) {
    // The Gazette has documented multi-day 5xx spells; one retry rides out blips.
    await new Promise((r) => setTimeout(r, 1500));
    res = await rawFetch(url);
  }
  if (!res.ok) {
    throw new Error(
      res.status >= 500
        ? `UK Gazette: upstream outage (HTTP ${res.status}) for ${path} — thegazette.co.uk has multi-day 5xx spells; retry later.`
        : `UK Gazette: upstream error (HTTP ${res.status}) for ${path}. The API is keyless — a 4xx usually means an invalid filter value; check dates are YYYY-MM-DD and codes come from gazette_notice_categories.`,
    );
  }
  // The Gazette's 5xx spells have a 200-shaped cousin: it also serves an empty
  // body and an HTML holding page under a 200. 5 of 6 external calls in 24h
  // died on `Unexpected end of JSON input`, which reads as our parser breaking.
  return parseJson<Feed>(res, 'UK Gazette');
}

function resolveCategory(input: string): { codes: string; matched?: string[] } {
  const raw = input.trim();
  // Pass explicit codes straight through (G-codes or legacy 2-digit, +-joined).
  if (/^(G\d{9}|\d{2})(\+(G\d{9}|\d{2}))*$/i.test(raw)) return { codes: raw };
  const q = raw.toLowerCase();
  const exact = CATEGORIES.filter((c) => c.name.toLowerCase() === q);
  const partial = exact.length > 0 ? exact : CATEGORIES.filter((c) => c.name.toLowerCase().includes(q));
  if (partial.length === 0) {
    throw new Error(
      `Unknown category "${input}". Call gazette_notice_categories({ search: "${input}" }) to browse valid categories, or pass a G-code directly.`,
    );
  }
  const picked = partial.slice(0, 6);
  return { codes: picked.map((c) => c.code).join('+'), matched: picked.map((c) => c.name) };
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function shapeEntry(e: FeedEntry) {
  const id = (e.id ?? '').split('/').pop() ?? '';
  const cats = Array.isArray(e.category) ? e.category : e.category ? [e.category] : [];
  const snippet = e.content ? stripHtml(e.content) : undefined;
  return {
    notice_id: id,
    title: e.title,
    notice_code: e['f:notice-code'] ?? undefined,
    category: cats.map((c) => c['@term']).filter(Boolean).join('; ') || undefined,
    published: e.published ? String(e.published).slice(0, 10) : undefined,
    snippet: snippet ? (snippet.length > 400 ? `${snippet.slice(0, 400)}…` : snippet) : undefined,
    url: `${BASE_URL}/notice/${id}`,
  };
}

function addCommonParams(params: URLSearchParams, args: Record<string, unknown>) {
  const page = Math.max(Number(args.page) || 1, 1);
  const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
  params.set('results-page', String(page));
  params.set('results-page-size', String(limit));
  if (args.published_after) params.set('start-publish-date', String(args.published_after));
  if (args.published_before) params.set('end-publish-date', String(args.published_before));
  if (args.location) {
    params.set('location-postcode-1', String(args.location));
    params.set('location-distance-1', String(Math.min(Math.max(Number(args.distance_miles) || 5, 1), 30)));
  }
  return { page, limit };
}

async function runSearch(
  service: string,
  edition: string | undefined,
  params: URLSearchParams,
  page: number,
  limit: number,
  extra: Record<string, unknown> = {},
) {
  const path = edition ? `/${service}/${edition}/notice/data.json` : `/${service}/notice/data.json`;
  const feed = await gazetteFetch(path, params);
  const entries = (feed.entry ?? []).map(shapeEntry);
  const total = Number(feed['f:total'] ?? entries.length);
  return {
    ...extra,
    total_matches: total,
    page,
    page_size: limit,
    total_pages: limit > 0 ? Math.ceil(total / limit) : 1,
    count: entries.length,
    note:
      entries.length === 0
        ? 'No notices matched. Broaden the text query, widen the date range, or drop the category filter. Note the archive is deepest for London (back to 1665).'
        : undefined,
    notices: entries,
    source: 'The Gazette (www.thegazette.co.uk) — official UK public record. Crown copyright, Open Government Licence v3.0.',
  };
}

async function searchNotices(args: Record<string, unknown>) {
  const params = new URLSearchParams();
  const { page, limit } = addCommonParams(params, args);
  if (args.query) params.set('text', String(args.query));

  let matchedCategories: string[] | undefined;
  if (args.category) {
    const r = resolveCategory(String(args.category));
    params.set('categorycode', r.codes);
    matchedCategories = r.matched;
  }
  // Docs say `noticetype`, but only the plural `noticetypes` actually filters.
  if (args.notice_types) params.set('noticetypes', String(args.notice_types));
  if (args.sort) params.set('sort-by', String(args.sort) === 'oldest' ? 'oldest-date' : 'latest-date');

  let edition: string | undefined;
  if (args.edition) {
    edition = String(args.edition).trim().toLowerCase();
    if (!EDITIONS.includes(edition)) {
      throw new Error(`edition must be one of ${EDITIONS.join(', ')} (got "${args.edition}")`);
    }
  }

  return runSearch('all-notices', edition, params, page, limit, {
    query: args.query || undefined,
    categories_matched: matchedCategories,
  });
}

async function insolvencyNotices(args: Record<string, unknown>) {
  const params = new URLSearchParams();
  const { page, limit } = addCommonParams(params, args);
  if (args.company) params.set('text', String(args.company));
  if (args.notice_types) params.set('noticetypes', String(args.notice_types));
  params.set('sort-by', 'latest-date');

  const scope = String(args.scope ?? 'corporate').toLowerCase();
  // Corporate = G205010000, personal = G206030000; the /insolvency service is
  // both. Category filter beats the service path because it composes with text.
  if (scope === 'corporate') params.set('categorycode', 'G205010000');
  else if (scope === 'personal') params.set('categorycode', 'G206030000');
  else if (scope !== 'all') throw new Error(`scope must be "corporate", "personal", or "all" (got "${args.scope}")`);

  const service = scope === 'all' ? 'insolvency' : 'all-notices';
  return runSearch(service, undefined, params, page, limit, {
    company: args.company || undefined,
    scope,
  });
}

async function deceasedEstates(args: Record<string, unknown>) {
  const params = new URLSearchParams();
  const { page, limit } = addCommonParams(params, args);
  if (args.name) params.set('text', String(args.name));
  if (args.died_after) params.set('start-date-of-death', String(args.died_after));
  if (args.died_before) params.set('end-date-of-death', String(args.died_before));
  if (args.claim_expires_after) params.set('start-claim-expiry-date', String(args.claim_expires_after));
  if (args.claim_expires_before) params.set('end-claim-expiry-date', String(args.claim_expires_before));
  params.set('sort-by', 'latest-date');

  return runSearch('wills-and-probate', undefined, params, page, limit, {
    name: args.name || undefined,
  });
}

// ---------------------------------------------------------------------------
// Single-notice detail via JSON-LD graph.

interface LdNode {
  '@id'?: string;
  '@type'?: string | string[];
  [key: string]: unknown;
}

function ldTypes(n: LdNode): string[] {
  const t = n['@type'];
  return Array.isArray(t) ? t : t ? [t] : [];
}

function ldStr(v: unknown): string | undefined {
  // Trim: Gazette JSON-LD values carry stray whitespace (e.g. "09166948 ").
  if (typeof v === 'string') return v.trim();
  if (v && typeof v === 'object' && '@value' in (v as object)) return String((v as { '@value': unknown })['@value']).trim();
  return undefined;
}

async function getNotice(args: Record<string, unknown>) {
  const id = String(args.notice_id ?? args.id ?? '')
    .trim()
    .replace(/^https?:\/\/[^/]+\/(id\/)?notice\//, '')
    .replace(/[/?#].*$/, '');
  if (!/^[A-Za-z0-9-]+$/.test(id) || id.length === 0) {
    throw new Error(`gazette_get_notice needs a notice_id like "4123456" (from a gazette search tool). Got "${args.notice_id}".`);
  }

  const res = await rawFetch(`${BASE_URL}/notice/${id}/data.jsonld`);
  if (res.status === 404) {
    throw new Error(`UK Gazette: no notice with ID "${id}". IDs come from gazette_search_notices / gazette_insolvency_notices results.`);
  }
  if (!res.ok) {
    throw new Error(`UK Gazette: upstream error (HTTP ${res.status}) fetching notice ${id} — retry later.`);
  }
  const doc = await parseJson<{ '@graph'?: LdNode[] }>(res, 'UK Gazette');
  const graph = doc['@graph'] ?? [];

  const companies = graph
    .filter((n) => ldTypes(n).some((t) => t.startsWith('gazorg:')))
    .map((n) => ({
      name: ldStr(n.name),
      company_number: ldStr(n.companyNumber),
      type: ldTypes(n).find((t) => t.startsWith('gazorg:'))?.replace('gazorg:', ''),
    }))
    .filter((c) => c.name || c.company_number);

  const people = graph
    .filter((n) => ldTypes(n).some((t) => t === 'person:Person' || t === 'foaf:Person'))
    .map((n) => ldStr(n.name) ?? [ldStr(n.forename), ldStr(n.surname)].filter(Boolean).join(' '))
    .filter(Boolean);

  const addresses = graph
    .filter((n) => ldTypes(n).includes('vcard:Address'))
    .map((n) => ldStr(n.label))
    .filter(Boolean);

  const legislation = graph
    .filter((n) => ldTypes(n).some((t) => t.startsWith('legislation:')))
    .map((n) => ldStr(n['rdfs:label']))
    .filter(Boolean);

  const noticeNode = graph.find((n) => ldTypes(n).includes('gaz:Notice'));
  const editionNode = graph.find((n) => ldTypes(n).includes('gaz:Edition'));
  const noticeType = noticeNode
    ? ldTypes(noticeNode).find((t) => t !== 'gaz:Notice')?.split(':').pop()
    : undefined;

  const dates = graph
    .flatMap((n) =>
      ['relatedDate', 'hasStartDate', 'hasEndDate', 'dateOfDeath', 'hasClaimExpiryDate']
        .map((k) => (n[k] != null ? { kind: k, date: ldStr(n[k]) } : null))
        .filter(Boolean) as Array<{ kind: string; date?: string }>,
    )
    .filter((d) => d.date);

  return {
    notice_id: id,
    url: `${BASE_URL}/notice/${id}`,
    // Camel-case type name from the ontology, e.g. CreditorsMeetingsOfCreditorsNotice.
    notice_type: noticeType,
    notice_code: noticeNode ? ldStr(noticeNode['gaz:hasNoticeCode']) : undefined,
    notice_number: noticeNode ? ldStr(noticeNode['gaz:hasNoticeNumber']) : undefined,
    published: noticeNode ? ldStr(noticeNode.hasPublicationDate)?.slice(0, 10) : undefined,
    edition: editionNode ? ldStr(editionNode.editionName) : undefined,
    companies: companies.length > 0 ? companies : undefined,
    people: people.length > 0 ? people : undefined,
    addresses: addresses.length > 0 ? addresses : undefined,
    legislation: legislation.length > 0 ? legislation : undefined,
    dates: dates.length > 0 ? dates : undefined,
    source: 'The Gazette (www.thegazette.co.uk) — official UK public record. Crown copyright, Open Government Licence v3.0.',
  };
}

function noticeCategories(args: Record<string, unknown>) {
  const q = String(args.search ?? '').trim().toLowerCase();
  const matches = q ? CATEGORIES.filter((c) => c.name.toLowerCase().includes(q)) : CATEGORIES;
  return {
    count: matches.length,
    note:
      matches.length === 0
        ? `No category name contains "${args.search}". Try a broader word (e.g. "insolvency", "roads", "estates"), or call without search to list all.`
        : 'Pass a code (or the category name itself) as `category` in gazette_search_notices.',
    categories: matches,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'gazette_search_notices':
      return searchNotices(args);
    case 'gazette_insolvency_notices':
      return insolvencyNotices(args);
    case 'gazette_deceased_estates':
      return deceasedEstates(args);
    case 'gazette_get_notice':
      return getNotice(args);
    case 'gazette_notice_categories':
      return noticeCategories(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool } satisfies McpToolExport;
