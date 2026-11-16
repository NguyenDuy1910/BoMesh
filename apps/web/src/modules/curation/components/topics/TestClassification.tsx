"use client";

import { Button, Input, TextField } from "@heroui/react";
import { useMutation } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, Info } from "lucide-react";
import { useState, type ReactNode } from "react";

import { StatusChip } from "@/components/ui";
import { ApiError, errorMessage } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";

import { testTopicClassification, type TestClassificationRequest, type Topic } from "../../api";
import { PlainSelect } from "../parts";
import { Sec, type RuleOptions } from "./TopicSignals";

const ANY = "__any";

/** Why a test couldn't run, in words. */
function testError(error: unknown): string {
  if (error instanceof ApiError && error.code === "FAILED_PRECONDITION") return "No rule matches and no assistant model is set up, so nothing can be tested.";
  if (error instanceof ApiError && error.code === "UNAVAILABLE") return "The assistant didn’t answer. Try again.";
  return errorMessage(error);
}

/**
 * Test classification (preview `testSec`): a sample title, optionally in a collection or from a source, classified the
 * way processing would (rules first, else the assistant), with this topic's unsaved changes. Nothing is stored.
 */
export function TestClassification({ topic, draft, topics, options }: { topic: Topic; draft: Topic | null; topics: readonly Topic[]; options: RuleOptions }) {
  const { id: ws } = useWorkspace();
  const [title, setTitle] = useState("");
  const [collection, setCollection] = useState("");
  const [source, setSource] = useState("");
  const run = useMutation({ mutationFn: (body: TestClassificationRequest) => testTopicClassification(ws, body) });

  const test = () => {
    const t = title.trim();
    if (!t) return;
    run.mutate({ title: t, collection: collection || undefined, source: source || undefined, topics: draft ? [draft] : undefined });
  };

  let out: ReactNode = null;
  if (run.isError) {
    out = (
      <p className="tx-test__verdict is-warn" role="alert">
        <AlertCircle className="i i-sm" aria-hidden />
        <span>{testError(run.error)}</span>
      </p>
    );
  } else if (run.data) {
    const results = run.data.results ?? [];
    const byName = new Map(topics.map((t) => [t.name ?? "", t]));
    const rank = results.findIndex((r) => r.topic === topic.name);
    const verdict =
      rank === 0 ? (
        <p className="tx-test__verdict is-ok">
          <CheckCircle2 className="i i-sm" aria-hidden />
          <span>This topic comes first.</span>
        </p>
      ) : rank > 0 ? (
        <p className="tx-test__verdict">
          <Info className="i i-sm" aria-hidden />
          <span>This topic is among the matches.</span>
        </p>
      ) : (
        <p className="tx-test__verdict is-warn">
          <AlertCircle className="i i-sm" aria-hidden />
          <span>This topic isn’t among the matches. Add a keyword, synonym or rule this title would hit.</span>
        </p>
      );
    out = (
      <>
        {verdict}
        {results.length ? (
          <ol className="tx-results">
            {results.map((r, i) => {
              const tp = byName.get(r.topic ?? "");
              const dm = byName.get(tp?.parentTopic ?? "");
              return (
                <li key={`${r.topic}-${i}`} className={`tx-result${r.topic === topic.name ? " is-self" : ""}`}>
                  <span className="tx-result__rank">{i + 1}</span>
                  <div className="tx-result__main">
                    <div className="tx-result__name">
                      {dm ? (
                        <>
                          <span className="muted" translate="no">
                            {dm.displayName}
                          </span>
                          <span className="muted" aria-hidden="true">
                            {" · "}
                          </span>
                        </>
                      ) : null}
                      <span className="medium" translate="no">
                        {tp?.displayName ?? r.topic}
                      </span>
                    </div>
                  </div>
                  <StatusChip label={r.reason === "RULE" ? "Rule" : "Assistant"} tone={r.reason === "RULE" ? "accent" : "default"} size="sm" dot={false} />
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="tx-sec__empty">No topic matched. The document would wait for a person to pick its topic.</p>
        )}
        {run.data.summary ? (
          <p className="tx-test__summary" translate="no">
            {run.data.summary}
          </p>
        ) : null}
      </>
    );
  }

  return (
    <Sec
      title="Test classification"
      desc={
        <>
          <span>Try a title. Pick a collection or source to check rules.</span>
          {draft ? <span> Uses your unsaved changes.</span> : null}
        </>
      }
    >
      <div className="tx-test">
        <div className="tx-test__form">
          <TextField aria-label="Document title" value={title} onChange={setTitle} maxLength={1024} className="tx-test__q">
            <Input placeholder="A title, e.g. Refund procedure 2027.pdf" spellCheck={false} translate="no" onKeyDown={(e) => e.key === "Enter" && test()} />
          </TextField>
          <PlainSelect className="tx-test__src" label="Collection" value={collection || ANY} options={[[ANY, "Any collection"], ...options.collections]} onChange={(v) => setCollection(v === ANY ? "" : v)} />
          <PlainSelect className="tx-test__src" label="Source" value={source || ANY} options={[[ANY, "Any source"], ...options.sources]} onChange={(v) => setSource(v === ANY ? "" : v)} />
          <Button variant="secondary" size="sm" isPending={run.isPending} isDisabled={!title.trim()} onPress={test}>
            Test
          </Button>
        </div>
        <div className="tx-test__out" aria-live="polite">
          {out}
        </div>
      </div>
    </Sec>
  );
}
