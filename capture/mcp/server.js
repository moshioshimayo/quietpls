#!/usr/bin/env node
"use strict";

// quietpls-mcp: read-only MCP server (stdio) over a Capture (beta) transcripts folder.
//   node capture/mcp/server.js /path/to/transcripts   (or: npm run capture:mcp -- /path)
// One tool: search_transcripts(query, from?, to?, limit?) → markdown chunks.
// Newline-delimited JSON-RPC 2.0 on stdin/stdout; it never writes to the folder.
// Always-on transcripts (ambient/<date>-<time>-always-on.md) older than
// AMBIENT_KEEP_HOURS are never returned, even when the desktop app hasn't run to
// delete them. Default 24 (the app's default); set QP_AMBIENT_KEEP_HOURS to match a
// changed retention setting.
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { search } = require("../lib/search");
const { OWN_FILE } = require("../lib/ambient");

const AMBIENT_KEEP_HOURS =
  Number(process.env.QP_AMBIENT_KEEP_HOURS) > 0
    ? Number(process.env.QP_AMBIENT_KEEP_HOURS)
    : 24;

/** An always-on file past retention: its name's local start time, else its mtime. */
function expiredAmbient(rel, now = Date.now()) {
  const name = path.basename(rel);
  if (path.dirname(rel) !== "ambient" || !OWN_FILE.test(name)) return false;
  const [, y, mo, d, h, mi] = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})/.exec(
    name,
  );
  let t = new Date(+y, mo - 1, +d, +h, +mi).getTime();
  if (!Number.isFinite(t)) t = fs.statSync(path.join(dir, rel)).mtimeMs;
  return now - t > AMBIENT_KEEP_HOURS * 3600 * 1000;
}

const dir = path.resolve(
  process.argv[2] || process.env.QUIETPLS_TRANSCRIPTS || ".",
);
if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
  process.stderr.write(`quietpls-mcp: folder not found: ${dir}\n`);
  process.exit(1);
}

const TOOL = {
  name: "search_transcripts",
  description:
    "Search the user's local call transcripts (one markdown file per call; lines look like " +
    '"[00:01:05] [them] (Speaker 1) text" where [you] is the user\'s mic and [them] is the other side). ' +
    "Every query word must appear. Returns matching lines with surrounding context as markdown, " +
    "best matches first. Leave query empty to get whole recent transcripts.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Words to find (case-insensitive). Empty = recent transcripts.",
      },
      from: {
        type: "string",
        description: "Only calls starting at or after this ISO date/time.",
      },
      to: {
        type: "string",
        description: "Only calls starting at or before this ISO date/time.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        default: 5,
        description: "Max transcripts to return.",
      },
    },
  },
  annotations: { readOnlyHint: true },
};

function handle(msg) {
  const { id, method, params = {} } = msg;
  switch (method) {
    case "initialize":
      return {
        protocolVersion: params.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: {
          name: "quietpls-mcp",
          version: require("../../package.json").version,
        },
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: [TOOL] };
    case "tools/call": {
      if (params.name !== TOOL.name)
        throw Object.assign(new Error(`Unknown tool: ${params.name}`), {
          code: -32602,
        });
      const args = params.arguments || {};
      if (
        (args.query !== undefined && typeof args.query !== "string") ||
        [args.from, args.to].some(
          (d) =>
            d !== undefined &&
            (typeof d !== "string" || !Number.isFinite(Date.parse(d))),
        ) ||
        (args.limit !== undefined &&
          (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 50))
      ) {
        throw Object.assign(
          new Error("Expected query text, ISO date bounds and limit 1–50."),
          { code: -32602 },
        );
      }
      const hits = search(dir, {
        ...args,
        include: (rel) => !expiredAmbient(rel),
      });
      const text = hits.length
        ? hits.map((h) => h.markdown).join("\n\n---\n\n")
        : `No transcripts match${params.arguments && params.arguments.query ? ` "${params.arguments.query}"` : ""}.`;
      return { content: [{ type: "text", text }], isError: false };
    }
    default:
      if (id === undefined) return undefined; // notification (e.g. notifications/initialized)
      throw Object.assign(new Error(`Method not found: ${method}`), {
        code: -32601,
      });
  }
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
  }
  try {
    const result = handle(msg);
    if (msg.id !== undefined && result !== undefined)
      send({ jsonrpc: "2.0", id: msg.id, result });
  } catch (e) {
    if (msg.id !== undefined)
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: e.code || -32603, message: e.message },
      });
  }
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
