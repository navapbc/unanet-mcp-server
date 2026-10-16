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

Two derived files are generated from the spec by `npm run build-catalog` and are
also committed (regenerate after every `fetch-spec`):

- `api-catalog.json` — one entry per operation (method, path, tag, summary,
  params, request/response schema names) plus a `kind` classification:
  `read` (GET or POST search/retrieve), `write` (plain create/update), or
  `sensitive` (submit/approve/disapprove/delete/post/void/cancel/send/extract/
  lock/auth, plus reads that can return credentials, tokens, bank, payroll or
  configuration data). The MCP tool `unanet_api_read` only executes `read`
  operations; there is no generic writer.
- `api-schemas.json` — shallow (one-level) view of every component schema, used
  by `unanet_api_describe_operation` to expand request/response bodies.
