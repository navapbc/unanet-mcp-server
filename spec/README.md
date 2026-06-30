# Unanet REST API spec

`unanet-openapi.json` is the full Unanet Platform REST API OpenAPI spec used as
the reference for building out MCP tools.

- Spec version observed: `26.4.0.10440 (core 26.4.0.+)`
- ~1267 operations, 86 resource groups (tags), 960 schemas

The blob is **committed to the repo** so it is backed up and versioned on GitHub. Refresh it to a newer spec version with:

```bash
npm run fetch-spec
# or directly:
curl -s -o spec/unanet-openapi.json https://dev.portal.unanet.io/platform/rest/openapi.json
```

A navigable, Obsidian-friendly catalog and an MCP coverage/roadmap tracker live
in the Second Brain at `nava/projects/unanet-mcp-server/`:

- `unanet-rest-api-catalog.md` — all operations grouped by resource group
- `mcp-coverage.md` — what is exposed via MCP and the build-out order
