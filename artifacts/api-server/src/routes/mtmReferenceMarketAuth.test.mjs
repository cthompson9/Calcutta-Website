import assert from "node:assert/strict";
import test from "node:test";
import { hasReferenceReadAuthorization } from "./mtm.ts";

test("reference-market REST auth accepts MCP/admin bearer tokens only", () => {
  const previousMcp = process.env.MCP_API_KEY;
  const previousAdmin = process.env.ADMIN_API_KEY;
  process.env.MCP_API_KEY = "mcp-test-key";
  process.env.ADMIN_API_KEY = "admin-test-key";
  try {
    assert.equal(hasReferenceReadAuthorization("Bearer mcp-test-key"), true);
    assert.equal(hasReferenceReadAuthorization("Bearer admin-test-key"), true);
    assert.equal(hasReferenceReadAuthorization("Bearer wrong"), false);
    assert.equal(hasReferenceReadAuthorization(undefined), false);
    assert.equal(hasReferenceReadAuthorization("mcp-test-key"), false);
  } finally {
    if (previousMcp === undefined) delete process.env.MCP_API_KEY;
    else process.env.MCP_API_KEY = previousMcp;
    if (previousAdmin === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = previousAdmin;
  }
});