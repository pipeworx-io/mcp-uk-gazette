# mcp-uk-gazette

UK Gazette MCP — The Gazette (www.thegazette.co.uk), the UK's official

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `gazette_search_notices` | Search The Gazette — the UK's official public record of statutory notices (London, Edinburgh and Belfast editions, archive back to 1665). Full-text search plus filters for notice category, publication date range, edition, and location. Covers company events (liquidations, administrations, winding-up petitions, name changes), personal insolvency, deceased estates, road/planning orders, honours, state and royal notices. Use for "official UK notices about X", "gazette notices for company Y", "road closure orders near Z". Example: gazette_search_notices({ query: "Tesco", category: "corporate insolvency" }) |
| `gazette_insolvency_notices` | Search official UK insolvency notices in The Gazette — the statutory public record where liquidations, administrations, winding-up petitions and orders, bankruptcy orders, creditors' meetings, and notices to creditors MUST be published. The go-to source for "is UK company X in liquidation/administration", monitoring company distress, or tracking personal bankruptcies. Search by company name or Companies House number (both are indexed). scope narrows to "corporate" or "personal" insolvency. Example: gazette_insolvency_notices({ company: "Wilko", scope: "corporate" }) |
| `gazette_deceased_estates` | Search UK deceased-estates notices in The Gazette (Trustee Act 1925 s.27 notices) — executors advertise a death so creditors and claimants can come forward before the estate is distributed. Used for probate research, tracing an estate, checking whether a death notice was placed, and finding the claim deadline. Filter by name, date of death, claim expiry date, or location. Example: gazette_deceased_estates({ name: "John Smith", died_after: "2026-01-01" }) |
| `gazette_get_notice` | Get the structured record for one Gazette notice by its ID (from any gazette search tool, or a thegazette.co.uk/notice/<id> URL). Returns the notice type, publication date, gazette edition and issue, companies named (with Companies House numbers), people, addresses with coordinates, related legislation, and key dates. Example: gazette_get_notice({ notice_id: "4123456" }) |
| `gazette_notice_categories` | Browse The Gazette's notice-category taxonomy — the category codes accepted by gazette_search_notices. Optionally filter by a search word. Categories span companies (insolvency, name changes, mergers), people (bankruptcy, deceased estates, honours), environment & infrastructure (planning, roads, property), state/royal/church notices, and money (pensions, coinage). Example: gazette_notice_categories({ search: "insolvency" }) |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "uk-gazette": {
      "url": "https://gateway.pipeworx.io/uk-gazette/mcp"
    }
  }
}
```

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Uk Gazette data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
