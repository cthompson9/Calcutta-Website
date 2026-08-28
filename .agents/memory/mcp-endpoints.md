---
name: MCP endpoints
description: Authenticated MCP server at /api/mcp using OAuth; legacy GET shims were removed.
---

## Notes

- The legacy unauthenticated `/api/mcp/get_*` GET shims no longer exist.
- Use the authenticated MCP endpoint at `/api/mcp` and OAuth discovery endpoints
  instead; clients receive the server's declared tools after authentication.
