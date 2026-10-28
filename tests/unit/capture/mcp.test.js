import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import T from "../../../capture/lib/transcript.js";
import S from "../../../capture/lib/search.js";

// Temp dirs (repos, synthetic test audio) are removed after this file's tests.
const made = [];
const mkdtemp = (prefix) => {
  const d = fs.mkdtempSync(prefix);
  made.push(d);
  return d;
};
afterAll(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

let dir;
beforeAll(() => {
  dir = mkdtemp(path.join(os.tmpdir(), "qpc-mcp-"));
  const call = (day, apps, lines) =>
    fs.writeFileSync(
      path.join(dir, T.fileName(new Date(2026, 9, day, 10), apps)),
      T.toMarkdown({
        start: new Date(2026, 9, day, 10),
        end: new Date(2026, 9, day, 10, 30),
        apps,
        model: "base.en",
        audioKept: false,
        lines,
      }),
    );
  call(
    20,
    ["Zoom"],
    [
      {
        at: 1,
        who: "them",
        speaker: "Speaker 1",
        text: "Let's talk about the budget.",
      },
      { at: 5, who: "you", text: "Hosting cost forty thousand." },
      { at: 9, who: "them", speaker: "Speaker 2", text: "That seems high." },
      { at: 14, who: "you", text: "Unrelated chat about lunch." },
      { at: 20, who: "you", text: "More unrelated chat." },
      { at: 26, who: "them", speaker: "Speaker 1", text: "Bye." },
    ],
  );
  call(
    25,
    ["Microsoft Teams"],
    [{ at: 2, who: "them", text: "Hiring plan for Q1." }],
  );
  fs.mkdirSync(path.join(dir, "ambient"));
  fs.writeFileSync(
    path.join(dir, "ambient", "x.md"),
    T.toMarkdown({
      start: new Date(2026, 9, 26, 9),
      end: new Date(2026, 9, 26, 9, 10),
      apps: [],
      title: "Ambient",
      model: "base.en",
      audioKept: false,
      lines: [{ at: 0, who: "you", text: "budget notes to self" }],
    }),
  );
});

describe("transcript search", () => {
  it("does not follow symlinks outside the transcript folder", () => {
    const outside = mkdtemp(path.join(os.tmpdir(), "qpc-outside-"));
    fs.writeFileSync(path.join(outside, "private.md"), "do not read");
    fs.symlinkSync(path.join(outside, "private.md"), path.join(dir, "link.md"));
    expect(S.transcriptFiles(dir)).not.toContain("link.md");
  });
  it("needs every word, returns matches with context and speaker labels", () => {
    const [hit, ...rest] = S.search(dir, {
      query: "hosting forty",
      context: 1,
    });
    expect(rest).toEqual([]);
    expect(hit.file).toBe("2026-10-20-1000-zoom.md");
    expect(hit.markdown).toContain(
      "[00:00:01] [them] (Speaker 1) Let's talk about the budget.",
    );
    expect(hit.markdown).toContain(
      "[00:00:05] [you] Hosting cost forty thousand.",
    );
    expect(hit.markdown).not.toContain("More unrelated chat");
  });

  it("filters by date and includes ambient transcripts", () => {
    expect(
      S.search(dir, { query: "budget" })
        .map((h) => h.file)
        .sort(),
    ).toEqual(["2026-10-20-1000-zoom.md", "ambient/x.md"]);
    expect(
      S.search(dir, { query: "budget", from: "2026-10-21" }).map((h) => h.file),
    ).toEqual(["ambient/x.md"]);
    expect(S.search(dir, { query: "", limit: 1 }).map((h) => h.file)).toEqual([
      "ambient/x.md",
    ]);
  });
});

describe("MCP server over stdio", () => {
  it("initializes, lists one read-only tool and answers search_transcripts", async () => {
    const child = spawn(process.execPath, [
      path.join(__dirname, "..", "..", "..", "capture", "mcp", "server.js"),
      dir,
    ]);
    const replies = [];
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        replies.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
      }
    });
    const send = (m) =>
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
    send({
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/list" });
    send({
      id: 3,
      method: "tools/call",
      params: { name: "search_transcripts", arguments: { query: "hiring" } },
    });
    send({ id: 4, method: "nope" });
    for (let t = 0; replies.length < 4 && t < 100; t++)
      await new Promise((r) => setTimeout(r, 20));
    child.kill();
    const byId = Object.fromEntries(replies.map((r) => [r.id, r]));
    expect(byId[1].result.serverInfo.name).toBe("quietpls-mcp");
    expect(byId[2].result.tools.map((t) => t.name)).toEqual([
      "search_transcripts",
    ]);
    expect(byId[3].result.content[0].text).toContain(
      "[00:00:02] [them] Hiring plan for Q1.",
    );
    expect(byId[4].error.code).toBe(-32601);
    expect(replies).toHaveLength(4); // the notification got no reply
  });
});
