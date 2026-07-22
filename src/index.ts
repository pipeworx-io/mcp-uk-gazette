interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
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
  return fetch(url, {
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
  return res.json() as Promise<Feed>;
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
  const doc = (await res.json()) as { '@graph'?: LdNode[] };
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
