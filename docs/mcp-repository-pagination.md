# Repository Inspection MCP Contract

Repository tools must return a `structuredContent` object using the following
contract. A JSON `text` content item with the same object is accepted for
compatibility, but new servers should use `structuredContent`.

```json
{
  "protocol": "codexh.repository.v1",
  "kind": "repository_tree",
  "summary": "Top-level projects under /",
  "items": [
    { "path": "src", "type": "directory" },
    { "path": "src/index.ts", "type": "file", "size": 1842 }
  ],
  "returnedCount": 2,
  "totalCount": 240,
  "page": 1,
  "hasMore": true,
  "nextCursor": "opaque-server-cursor"
}
```

## Inputs

All repository inspection tools accept `path`, `cursor`, and `maxResults`.
`get_repo_structure` additionally accepts `maxDepth`.

- `get_repo_structure`: default `maxDepth` is 2, maximum 3; default
  `maxResults` is 100, maximum 200.
- `search_files`: default `maxResults` is 20, maximum 50.
- File-reading tools: default `maxResults` is 200 lines, maximum 500 lines.

`cursor` is opaque and valid only for a short server-defined period. If the
repository changes or the cursor expires, return an MCP error explaining that
the client must restart from the current `path`.

## Result Rules

- `kind` is one of `repository_tree`, `file_search`, or `file_read`.
- `items` contain only compact metadata. Search matches may include `line` and
  a short `preview`; do not emit Markdown trees, icons, or full file contents.
- Set `hasMore` and provide `nextCursor` whenever another page exists.
- Keep the raw response available to MCP tooling, but do not duplicate it in
  human-formatted `text` output. CodeXH stores the raw result in tool details
  and sends only a compact page summary to the model.
