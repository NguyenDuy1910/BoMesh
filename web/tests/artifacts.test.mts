import assert from "node:assert/strict";
import test from "node:test";

import { turnWork } from "../src/modules/chat/work.ts";
import { artifactSizeLabel, turnArtifacts } from "../src/modules/chat/artifacts.ts";
import { ARTIFACT_ANNOTATION_TYPE, DOCUMENT_CITATION_TYPE } from "../src/modules/chat/types.ts";
import type { ChatMessage, OutputTextAnnotation, TurnState } from "../src/modules/chat/types.ts";
import type { ArtifactRevision, LocalArtifactRevision } from "../src/modules/chat/api.ts";
import { conversationFiles } from "../src/modules/chat/components/files/conversation-files.ts";
import { diffLines, diffMarkdown, diffSheet, sheetHasChanges } from "../src/modules/chat/components/files/diff.ts";
import { exportFormatsFor, mergeFileRevisions } from "../src/modules/chat/components/files/file-model.ts";
import { htmlToMarkdown, type MarkdownSourceNode } from "../src/modules/chat/components/files/html-markdown.ts";
import { columnLetter, parseDelimited, sheetsFromBlocks, type Sheet } from "../src/modules/chat/components/files/sheet.ts";

function artifact(overrides: Partial<Record<string, unknown>> = {}): OutputTextAnnotation {
  return {
    type: ARTIFACT_ANNOTATION_TYPE,
    start_index: 18,
    end_index: 18,
    artifact: {
      id: "artifact-1",
      title: "Q3 memo",
      file_name: "Q3-memo.md",
      mime_type: "text/markdown",
      revision: 1,
      size_bytes: 2048,
      updated_at: "2026-09-06T00:00:00+00:00",
      ...overrides,
    },
  };
}

function turnWithAnnotations(perResponse: OutputTextAnnotation[][]): TurnState {
  const responses: TurnState["responses"] = {};
  const responseOrder: string[] = [];
  perResponse.forEach((annotations, index) => {
    const id = `response-${index}`;
    responseOrder.push(id);
    responses[id] = {
      id,
      status: "completed",
      itemOrder: ["message"],
      items: {
        message: {
          type: "message",
          id: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "The memo is ready.", annotations }],
        },
      },
    };
  });
  return { id: "turn", status: "completed", responses, responseOrder };
}

test("collects a produced file once, from its annotation", () => {
  const artifacts = turnArtifacts(turnWithAnnotations([[artifact()]]));

  assert.equal(artifacts.length, 1);
  assert.deepEqual(artifacts[0], {
    id: "artifact-1",
    title: "Q3 memo",
    fileName: "Q3-memo.md",
    mimeType: "text/markdown",
    revision: 1,
    sizeBytes: 2048,
    updatedAt: "2026-09-06T00:00:00+00:00",
  });
});

test("a file presented twice keeps its newest revision and first position", () => {
  const artifacts = turnArtifacts(turnWithAnnotations([
    [artifact({ revision: 1 }), artifact({ id: "artifact-2", title: "Checklist" })],
    [artifact({ revision: 2, size_bytes: 4096 })],
  ]));

  assert.deepEqual(artifacts.map((entry) => [entry.id, entry.revision]), [
    ["artifact-1", 2],
    ["artifact-2", 1],
  ]);
  assert.equal(artifacts[0]?.sizeBytes, 4096);
});

test("collects an explicitly exported workspace artifact from tool progress", () => {
  const turn: TurnState = {
    id: "turn-1",
    status: "streaming",
    responseOrder: [],
    responses: {},
    runtimeActivities: [{
      callId: "export-1",
      toolName: "export_sandbox_file",
      state: "completed",
      startedAt: 1,
      progress: {
        artifact: {
          id: "artifact-1",
          title: "Analysis",
          file_name: "analysis.csv",
          mime_type: "text/csv",
          revision: 1,
          size_bytes: 42,
          updated_at: "2026-09-10T00:00:00Z",
        },
      },
    }],
  };

  assert.deepEqual(turnArtifacts(turn), [{
    id: "artifact-1",
    title: "Analysis",
    fileName: "analysis.csv",
    mimeType: "text/csv",
    revision: 1,
    sizeBytes: 42,
    updatedAt: "2026-09-10T00:00:00Z",
  }]);
});

test("a container file citation never reaches the client as one", () => {
  // The backend consumes the provider's own citation and republishes it as a
  // Product file, so an unknown provider annotation contributes nothing.
  const provider: OutputTextAnnotation = {
    type: "container_file_citation",
    container_id: "cntr_1",
    file_id: "cfile_1",
    filename: "/mnt/data/Q3-memo.md",
  };

  assert.deepEqual(turnArtifacts(turnWithAnnotations([[provider]])), []);
});

test("citation and unknown annotations are ignored", () => {
  const citation: OutputTextAnnotation = {
    type: DOCUMENT_CITATION_TYPE,
    citation: { id: "e1", item_id: "item-1", chunk_id: "chunk-1" },
  };
  assert.deepEqual(turnArtifacts(turnWithAnnotations([[citation, { type: "file_path", path: "/x" }]])), []);
  assert.deepEqual(turnArtifacts(undefined), []);
});

test("sizes read naturally", () => {
  assert.equal(artifactSizeLabel(512), "512 B");
  assert.equal(artifactSizeLabel(2048), "2.0 KB");
  assert.equal(artifactSizeLabel(3 * 1024 * 1024), "3.0 MB");
});

test("a file revised within one turn shows once at its newest revision and reads as updated", () => {
  const turn = turnWithAnnotations([
    [artifact({ revision: 1 })],
    [artifact({ revision: 3, size_bytes: 4096 }), artifact({ id: "artifact-2", title: "Totals", file_name: "totals.xlsx", revision: 1 })],
  ]);

  assert.deepEqual(turnArtifacts(turn).map(({ id, revision }) => [id, revision]), [["artifact-1", 3], ["artifact-2", 1]]);
  assert.equal(turnWork(turn).summary, "Created 1 file · Updated 1 file");
});

function serverRevision(revision: number, extra: Partial<ArtifactRevision> = {}): ArtifactRevision {
  return { revision, summary: `Agent version ${revision}`, size_bytes: 100 * revision, created_at: null, download_url: `https://files/${revision}`, ...extra };
}

function keptRevision(revision: number, restoredFrom: number | null = null): LocalArtifactRevision {
  return {
    revision,
    summary: restoredFrom ? `Restored version ${restoredFrom}` : "Edited by you",
    size_bytes: 10,
    created_at: "2026-10-05T10:00:00Z",
    download_url: null,
    restored_from: restoredFrom,
    content: `# Version ${revision}`,
    mime_type: "text/markdown",
  };
}

test("versions list the server's first, then the ones kept in this browser", () => {
  const merged = mergeFileRevisions(
    [serverRevision(2), serverRevision(1), serverRevision(2, { summary: "duplicate" })],
    [keptRevision(4), keptRevision(3)],
  );

  assert.deepEqual(merged.map((entry) => [entry.revision, entry.local, entry.author]), [
    [1, false, "assistant"],
    [2, false, "assistant"],
    [3, true, "you"],
    [4, true, "you"],
  ]);
  assert.equal(merged[2]?.content, "# Version 3");
  assert.equal(merged[2]?.downloadUrl, null);
});

test("a kept version whose number the assistant reused moves after the server's", () => {
  const merged = mergeFileRevisions(
    [serverRevision(1), serverRevision(2), serverRevision(3, { restored_from: 1 })],
    [keptRevision(3, 2), keptRevision(4, 3)],
  );

  assert.deepEqual(merged.map((entry) => [entry.revision, entry.local, entry.restoredFrom]), [
    [1, false, null],
    [2, false, null],
    [3, false, 1],
    [4, true, 2],
    [5, true, 4],
  ]);
  assert.equal(merged[2]?.author, "you", "a restore is a person's even without an author field");
});

test("the current revision is listed even when the server omits it from revisions", () => {
  const merged = mergeFileRevisions([serverRevision(1)], [], serverRevision(2));
  assert.deepEqual(merged.map((entry) => entry.revision), [1, 2]);
});

test("Markdown changes are compared block by block, ignoring how a bullet is written", () => {
  const changes = diffMarkdown(
    "# Plan\n\nIntro text.\n\n- one\n- two\n",
    "# Plan\n\nIntro text, revised.\n\n* one\n- two\n- three\n",
  );

  assert.deepEqual(changes.map((change) => [change.status, change.text]), [
    ["same", "# Plan"],
    ["removed", "Intro text."],
    ["added", "Intro text, revised."],
    ["same", "* one"],
    ["same", "- two"],
    ["added", "- three"],
  ]);
  assert.ok(diffMarkdown("A **bold** word\n", "A __bold__ word\n").every((change) => change.status === "same"));
});

test("plain text changes are compared line by line", () => {
  assert.deepEqual(diffLines("alpha\nbeta\n\ngamma", "alpha\ngamma\ndelta").map((change) => [change.status, change.text]), [
    ["same", "alpha"],
    ["removed", "beta"],
    ["same", "gamma"],
    ["added", "delta"],
  ]);
});

const vendorsV1: Sheet = {
  name: "Vendors",
  columns: ["Vendor", "Spend"],
  rows: [["Acme", "10"], ["Bolt", "20"], ["Core", "30"]],
  totalRows: 3,
};

test("sheet changes mark added columns and rows, changed and moved cells, and removed rows", () => {
  const diff = diffSheet(vendorsV1, {
    name: "Vendors",
    columns: ["Vendor", "Spend", "Approver"],
    rows: [["Core", "30", "CFO"], ["Acme", "15", "VP"], ["Dyna", "5", "Owner"]],
    totalRows: 3,
  });

  assert.deepEqual(diff.columns, [
    { name: "Vendor", status: "same" },
    { name: "Spend", status: "same" },
    { name: "Approver", status: "added" },
  ]);
  assert.deepEqual(diff.rows.map((row) => [row.number, row.status, row.cells.map((cell) => cell.status)]), [
    [2, "same", ["same", "same", "added"]],
    [3, "moved", ["same", "changed", "added"]],
    [4, "added", ["added", "added", "added"]],
  ]);
  assert.deepEqual(diff.removedRows, [["Bolt", "20", ""]]);
  assert.deepEqual(diff.counts, { addedRows: 1, removedRows: 1, movedRows: 1, changedCells: 1, addedColumns: 1, removedColumns: 0 });
});

test("a re-sorted sheet has changes; an identical one has none", () => {
  const sorted = { ...vendorsV1, rows: [...vendorsV1.rows].reverse() };
  assert.equal(sheetHasChanges(diffSheet(vendorsV1, sorted)), true);
  assert.equal(sheetHasChanges(diffSheet(vendorsV1, structuredClone(vendorsV1))), false);
  assert.deepEqual(diffSheet(vendorsV1, { ...vendorsV1, columns: ["Vendor"], rows: vendorsV1.rows.map((row) => [row[0]!]) }).removedColumns, ["Spend"]);
});

test("rows repeating a first cell are matched by occurrence", () => {
  const before: Sheet = { name: "S", columns: ["Team", "Cost"], rows: [["Ops", "1"], ["Ops", "2"]], totalRows: 2 };
  const diff = diffSheet(before, { ...before, rows: [["Ops", "1"], ["Ops", "3"]] });
  assert.deepEqual(diff.rows.map((row) => row.cells[1]?.status), ["same", "changed"]);
});

test("download formats offered depend on what the file is", () => {
  assert.deepEqual(exportFormatsFor("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "q3.xlsx"), ["csv", "pdf", "md"]);
  assert.deepEqual(exportFormatsFor("text/csv", "q3.csv"), ["pdf", "md"]);
  assert.deepEqual(exportFormatsFor("text/markdown", "plan.md"), ["pdf"]);
  assert.deepEqual(exportFormatsFor("text/plain", "notes.txt"), ["pdf"]);
  assert.deepEqual(exportFormatsFor("application/json", "data.json"), ["pdf", "md"]);
  assert.deepEqual(exportFormatsFor("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "memo.docx"), ["pdf", "md"]);
  assert.deepEqual(exportFormatsFor("application/pdf", "brief.pdf"), ["md"]);
  assert.deepEqual(exportFormatsFor("image/png", "chart.png"), []);
  assert.deepEqual(exportFormatsFor("application/zip", "bundle.zip"), []);
});

test("delimited text keeps quoted delimiters, quotes and line breaks", () => {
  assert.deepEqual(parseDelimited('\uFEFFName,Note\r\n"Acme, Inc.","said ""hi""\nthen left"\r\nBolt,\n\n'), [
    ["Name", "Note"],
    ["Acme, Inc.", 'said "hi"\nthen left'],
    ["Bolt", ""],
  ]);
  assert.deepEqual([columnLetter(0), columnLetter(25), columnLetter(26), columnLetter(701)], ["A", "Z", "AA", "ZZ"]);
});

test("a workbook rendition becomes named sheets", () => {
  const sheets = sheetsFromBlocks([
    { id: "h1", kind: "heading", level: 1, text: "Needs review", page: 1 },
    { id: "t1", kind: "table", caption: null, columns: ["Vendor"], rows: [["Acme"]], total_rows: 40, page: 1 },
    { id: "t2", kind: "table", caption: "Totals", columns: ["Sum"], rows: [["9"]], total_rows: 1, page: 2 },
    { id: "t3", kind: "table", caption: null, columns: ["X"], rows: [], total_rows: 0, page: 3 },
  ]);
  assert.deepEqual(sheets.map((sheet) => [sheet.name, sheet.totalRows]), [["Needs review", 40], ["Totals", 1], ["Sheet 3", 0]]);
});

function element(nodeName: string, childNodes: MarkdownSourceNode[] = [], attributes: Record<string, string> = {}): MarkdownSourceNode {
  return {
    nodeType: 1,
    nodeName,
    childNodes,
    get textContent() { return childNodes.map((child) => child.textContent).join(""); },
    getAttribute: (name) => attributes[name] ?? null,
  };
}
const text = (value: string): MarkdownSourceNode => ({ nodeType: 3, nodeName: "#text", textContent: value, childNodes: [] });

test("an edited document is saved back as Markdown", () => {
  const markdown = htmlToMarkdown(element("DIV", [
    element("H2", [text("Vendor review")]),
    element("P", [text("Eleven need "), element("STRONG", [text("attention ")]), text("now, "), element("EM", [text("before")]), text(" renewal.")]),
    element("UL", [element("LI", [text("CloudHost")]), element("LI", [text("Payroll "), element("UL", [element("LI", [text("HR")])])])]),
    element("OL", [element("LI", [text("Ask")]), element("LI", [text("Sign")])]),
    element("DIV", [element("BUTTON", [text("Copy")]), element("PRE", [element("CODE", [text("select 1;\n")], { class: "language-sql" })])]),
    element("TABLE", [element("TBODY", [element("TR", [element("TH", [text("Vendor")]), element("TH", [text("Ends")])]), element("TR", [element("TD", [text("Mail|Wave")]), element("TD", [text("Oct 15")])])])]),
    text("A typed line with a * star"),
  ]));

  assert.equal(markdown, [
    "## Vendor review",
    "Eleven need **attention** now, *before* renewal.",
    "- CloudHost\n- Payroll\n  - HR",
    "1. Ask\n2. Sign",
    "```sql\nselect 1;\n```",
    "| Vendor | Ends |\n| --- | --- |\n| Mail\\|Wave | Oct 15 |",
    "A typed line with a \\* star",
  ].join("\n\n") + "\n");
});

test("files in a chat: each made file once at its newest version, then attachments", () => {
  const messages: Pick<ChatMessage, "id" | "role" | "parts" | "turn">[] = [
    {
      id: "u1",
      role: "user",
      parts: [
        { type: "text", text: "Summarize", state: "done" },
        { type: "data-document", data: { id: "doc-1", fileName: "vendors.xlsx", contentType: "application/vnd.ms-excel", sizeBytes: 10, mode: "indexed", status: "available" } },
      ],
    },
    { id: "a1", role: "assistant", parts: [], turn: turnWithAnnotations([[artifact({ revision: 1 })]]) },
    {
      id: "u2",
      role: "user",
      parts: [{ type: "data-document", data: { id: "doc-1", fileName: "vendors.xlsx", contentType: "application/vnd.ms-excel", sizeBytes: 10, mode: "indexed", status: "available" } }],
    },
    { id: "a2", role: "assistant", parts: [], turn: turnWithAnnotations([[artifact({ revision: 2, size_bytes: 4096 })]]) },
  ];

  const files = conversationFiles(messages);
  assert.deepEqual(files.map((file) => [file.kind, file.id, file.messageId]), [
    ["attached", "attached:doc-1", "u1"],
    ["made", "made:artifact-1", "a1"],
  ]);
  const made = files.find((file) => file.kind === "made");
  assert.equal(made?.kind === "made" && made.artifact.revision, 2);
});
