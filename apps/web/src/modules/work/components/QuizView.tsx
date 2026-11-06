"use client";

import { Button, Input, Label, ProgressBar, Skeleton, TextArea, TextField } from "@heroui/react";
import { ArrowLeft, ArrowRight, BookOpen, Check, CircleCheck, CircleX, EyeOff, List, Pencil, Play, Plus, RefreshCw, RotateCcw, Send, Trash2, TriangleAlert, Users, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Callout, confirm, EmptyState, ErrorState, IconButton, ItemIcon, Section, SkeletonRows, Tip, toast } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { pct, plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import { isSpaceStaff, newWorkHref, workflowsFor } from "../kinds";
import { parseQuiz, QUIZ_KEYS, serializeQuiz, type QuizQuestion } from "../model";
import { useArtifactText } from "../queries";
import { WorkMarkdown } from "./parts";
import type { WorkViewProps } from "./WorkItemPage";

/** "Publish to <space>" for a staff quiz still private (preview `quizActions`). Publishing shares it with the space. */
export function QuizActions({ artifact: a, canEdit, space, actions }: WorkViewProps) {
  if (!canEdit || !space || !isSpaceStaff(space) || a.audience === "SPACE") return null;
  const publish = async () => {
    const ok = await confirm({
      title: `Publish to ${space.displayName}?`,
      description: `Members of ${space.displayName} can open it from Work and take it.`,
      confirmLabel: "Publish",
      tone: "accent",
    });
    if (ok) await actions.setAudience("SPACE", `Published to ${space.displayName}`);
  };
  return (
    <Button variant="primary" onPress={() => void publish()} isDisabled={a.state !== "ACTIVE"}>
      <Send className="i" aria-hidden />
      Publish to {space.displayName}
    </Button>
  );
}

/** Quiz: answer key for the teaching team, take flow for learners (preview `renderQuiz`). */
export function QuizView(props: WorkViewProps) {
  const { artifact: a, canEdit, space } = props;
  const text = useArtifactText(a);
  if (text.isPending && a.revision) return <SkeletonRows rows={6} />;
  if (text.isError)
    return (a.hiddenSourceCount ?? 0) > 0 ? (
      <Callout tone="warning" icon={TriangleAlert} title="This quiz is hidden from you" description="It uses sources you can no longer open. Ask the owner to share them again." />
    ) : (
      <ErrorState error={text.error} onRetry={() => void text.refetch()} />
    );
  const qs = parseQuiz(text.data ?? "");
  if (!qs)
    return (
      <div className="stack gap-16">
        <Callout title="Shown as written" description="The questions couldn’t be read one by one, so the quiz is shown as the assistant wrote it." />
        <div className="card card--lg">
          <WorkMarkdown text={text.data ?? ""} className="guide-sec__body" />
        </div>
      </div>
    );
  if (canEdit && isSpaceStaff(space)) return <StaffView {...props} questions={qs} />;
  return <TakeFlow {...props} questions={qs} practice={canEdit} />;
}

/* ═══════════════ Teaching team: questions with the answer key ═══════════════ */

interface EditState {
  id: string;
  isNew: boolean;
  q: string;
  options: string[];
  answer: number;
  explain: string;
  err: string;
}

function StaffView({ artifact: a, space, actions, questions }: WorkViewProps & { questions: QuizQuestion[] }) {
  const [edit, setEdit] = useState<EditState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const published = a.audience === "SPACE";
  const generating = a.state === "GENERATING";

  const save = async (next: QuizQuestion[], summary: string) => {
    try {
      await actions.commit(serializeQuiz(next), summary);
      return true;
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
      return false;
    }
  };

  const saveEdit = async () => {
    if (!edit) return;
    if (!edit.q.trim() || edit.options.some((o) => !o.trim())) {
      setEdit({ ...edit, err: "Write the question and all four answers." });
      return;
    }
    const q: QuizQuestion = { id: edit.id, q: edit.q.trim(), options: edit.options.map((o) => o.trim()), answer: edit.answer, explain: edit.explain.trim() };
    const next = edit.isNew ? [...questions, q] : questions.map((x) => (x.id === edit.id ? q : x));
    const i = next.findIndex((x) => x.id === edit.id);
    if (await save(next, edit.isNew ? "Added a question" : `Edited question ${i + 1}`)) {
      setEdit(null);
      toast(edit.isNew ? "Question added" : "Question saved");
    }
  };
  const remove = async (i: number) => {
    if (questions.length === 1) {
      toast("A quiz needs at least one question.", { tone: "danger" });
      return;
    }
    const next = questions.filter((_, j) => j !== i);
    if (await save(next, `Removed question ${i + 1}`))
      toast(`Removed question ${i + 1}`, { undo: () => void save(questions, `Restored question ${i + 1}`) });
  };
  const regen = async (q: QuizQuestion, i: number) => {
    setBusy(q.id);
    const ok = await actions.revise(
      { instructions: `Replace only question ${i + 1} (“${q.q}”) with a different question from the materials. Keep every other question and the answer key format exactly as they are.` },
      { failure: "Couldn’t replace the question" },
    );
    setBusy(null);
    if (ok) toast("Question replaced");
  };
  const open = (q: QuizQuestion | null) =>
    setEdit(
      q
        ? { id: q.id, isNew: false, q: q.q, options: [...q.options, "", "", "", ""].slice(0, 4), answer: Math.max(0, q.answer), explain: q.explain, err: "" }
        : { id: `q${Date.now()}`, isNew: true, q: "", options: ["", "", "", ""], answer: 0, explain: "", err: "" },
    );

  return (
    <>
      <div className="quiz-status">
        {published ? (
          <>
            <Users className="i i-sm" aria-hidden />
            <span>
              Published to <span translate="no">{space?.displayName}</span>
            </span>
          </>
        ) : (
          <>
            <EyeOff className="i i-sm" aria-hidden />
            <span>Draft — only the teaching team can see it. Check the questions, then publish.</span>
          </>
        )}
      </div>
      <div className="quiz-list" translate="no">
        {questions.map((q, i) =>
          edit && edit.id === q.id ? (
            <QuestionEditor key={q.id} state={edit} index={i} onChange={setEdit} onSave={() => void saveEdit()} onCancel={() => setEdit(null)} />
          ) : busy === q.id ? (
            <div key={q.id} className="card quiz-q" aria-busy="true">
              <Skeleton className="skeleton--line" style={{ width: "70%" }} />
              <Skeleton className="skeleton--line" style={{ width: "45%" }} />
              <Skeleton className="skeleton--line" style={{ width: "55%" }} />
            </div>
          ) : (
            <div key={q.id} className="card quiz-q">
              <div className="quiz-q__head">
                <span className="quiz-q__n">{i + 1}</span>
                <div className="quiz-q__text">{q.q}</div>
                <div className="quiz-q__acts" translate="yes">
                  <IconButton icon={Pencil} tip="Edit" size="sm" onPress={() => open(q)} isDisabled={!!edit || generating} />
                  <IconButton icon={RefreshCw} tip="Regenerate" size="sm" onPress={() => void regen(q, i)} isDisabled={!!edit || !!busy || generating} />
                  <IconButton icon={Trash2} tip="Remove" size="sm" onPress={() => void remove(i)} isDisabled={!!edit || generating} />
                </div>
              </div>
              <ol className="quiz-key">
                {q.options.map((o, j) => (
                  <li key={j} className={`quiz-key__opt${j === q.answer ? " is-correct" : ""}`}>
                    <span className="quiz-opt__key">{QUIZ_KEYS[j]}</span>
                    <span className="grow">{o}</span>
                    {j === q.answer ? (
                      <span className="quiz-key__tag" translate="yes">
                        <Check className="i i-sm" aria-hidden />
                        Correct
                      </span>
                    ) : null}
                  </li>
                ))}
              </ol>
              {q.explain ? <div className="quiz-q__explain">{q.explain}</div> : null}
              {q.answer < 0 ? (
                <div className="quiz-q__foot" translate="yes">
                  <span className="t-xs muted">No answer marked — edit the question to set one.</span>
                </div>
              ) : null}
            </div>
          ),
        )}
        {edit?.isNew ? <QuestionEditor state={edit} index={questions.length} onChange={setEdit} onSave={() => void saveEdit()} onCancel={() => setEdit(null)} /> : null}
      </div>
      {edit ? null : (
        <div className="quiz-add">
          <Button variant="tertiary" onPress={() => open(null)} isDisabled={generating}>
            <Plus className="i" aria-hidden />
            Add question
          </Button>
        </div>
      )}
    </>
  );
}

function QuestionEditor({ state: e, index, onChange, onSave, onCancel }: { state: EditState; index: number; onChange: (s: EditState) => void; onSave: () => void; onCancel: () => void }) {
  const missing = e.err ? e.options.map((o) => !o.trim()) : [];
  return (
    <div className="card quiz-q quiz-q--edit" translate="yes">
      <div className="t-subheading">{e.isNew ? "New question" : `Edit question ${index + 1}`}</div>
      <TextField className="field" value={e.q} onChange={(q) => onChange({ ...e, q, err: "" })} isInvalid={!!e.err && !e.q.trim()} isRequired autoFocus>
        <Label>Question</Label>
        <TextArea rows={2} translate="no" />
      </TextField>
      <div className="field">
        <span className="label">
          Answers<span className="label__req" aria-hidden="true">*</span>
        </span>
        <div className="quiz-edit__opts">
          {e.options.map((o, j) => (
            <div key={j} className="quiz-edit__opt">
              <Tip content="Mark as correct">
                <button
                  type="button"
                  className={`quiz-edit__key${e.answer === j ? " is-on" : ""}`}
                  aria-pressed={e.answer === j}
                  aria-label={`Mark answer ${QUIZ_KEYS[j]} as correct`}
                  onClick={() => onChange({ ...e, answer: j })}
                >
                  {e.answer === j ? <Check className="i i-sm" aria-hidden /> : QUIZ_KEYS[j]}
                </button>
              </Tip>
              <TextField
                aria-label={`Answer ${QUIZ_KEYS[j]}`}
                value={o}
                onChange={(v) => onChange({ ...e, options: e.options.map((x, k) => (k === j ? v : x)), err: "" })}
                isInvalid={missing[j]}
                className="grow"
              >
                <Input placeholder={`Answer ${QUIZ_KEYS[j]}`} translate="no" />
              </TextField>
            </div>
          ))}
        </div>
        <div className="description">Select a letter to mark the correct answer.</div>
      </div>
      <TextField className="field" value={e.explain} onChange={(explain) => onChange({ ...e, explain })}>
        <Label>
          Explanation <span className="label__opt">(optional)</span>
        </Label>
        <TextArea rows={2} translate="no" />
        <span className="description">Students see it after they answer.</span>
      </TextField>
      {e.err ? (
        <div className="field-error" role="alert">
          <X className="i" aria-hidden />
          <span>{e.err}</span>
        </div>
      ) : null}
      <div className="quiz-edit__foot">
        <span className="grow" />
        <Button variant="ghost" onPress={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" onPress={onSave}>
          Save
        </Button>
      </div>
    </div>
  );
}

/* ═══════════════ Learners: take the quiz ═══════════════ */

interface Attempt {
  answers: (number | null)[];
  score: number;
}

function TakeFlow({ artifact: a, space, questions: qs, practice }: WorkViewProps & { questions: QuizQuestion[]; practice: boolean }) {
  const router = useRouter();
  const { settings } = useWorkspace();
  const [mode, setMode] = useState<"start" | "taking" | "result">("start");
  const [i, setI] = useState(0);
  const [answers, setAnswers] = useState<(number | null)[]>([]);
  const [last, setLast] = useState<Attempt | null>(null);
  const keyed = qs.filter((q) => q.answer >= 0);
  if (!keyed.length) return <EmptyState icon={List} title="This quiz has no questions" boxed />;

  const n = keyed.length;
  const scroll = () => document.getElementById("scroll")?.scrollTo({ top: 0 });
  const start = () => {
    setAnswers([]);
    setI(0);
    setMode("taking");
    scroll();
  };
  const finish = (picked: (number | null)[]) => {
    const score = keyed.filter((q, j) => picked[j] === q.answer).length;
    setLast({ answers: picked, score });
    setMode("result");
    scroll();
    toast(`${score} of ${n} correct`);
  };
  const submit = async () => {
    const picked = keyed.map((_, j) => answers[j] ?? null);
    const open = picked.filter((x) => x === null).length;
    if (practice && !open) return finish(picked);
    const ok = await confirm({
      title: open ? `Submit with ${plural(open, "unanswered question")}?` : "Submit your answers?",
      description: open ? "Unanswered questions count as wrong." : "You’ll see your score and why each answer is right.",
      confirmLabel: "Submit",
      tone: "accent",
    });
    if (ok) finish(picked);
  };

  if (mode === "taking") {
    const q = keyed[Math.min(i, n - 1)];
    const ans = answers[i] ?? null;
    const locked = practice && ans !== null;
    const right = ans === q.answer;
    const answered = answers.filter((x) => x !== null && x !== undefined).length;
    return (
      <div className="card card--lg quiz-take">
        <div className="quiz-take__top">
          <span className="t-sm medium">
            Question {i + 1} of {n}
          </span>
          <span className="t-sm muted num">{answered} answered</span>
        </div>
        <ProgressBar aria-label={`Question ${i + 1} of ${n}`} value={((i + 1) / n) * 100}>
          <ProgressBar.Track>
            <ProgressBar.Fill />
          </ProgressBar.Track>
        </ProgressBar>
        <h2 className="quiz-take__q" id="qt-label" translate="no">
          {q.q}
        </h2>
        <div className="quiz-opts" role="radiogroup" aria-labelledby="qt-label" translate="no">
          {q.options.map((o, j) => {
            const st = locked ? (j === q.answer ? "is-correct" : j === ans ? "is-wrong" : "") : "";
            return (
              <label key={j} className={`quiz-opt ${ans === j ? "is-picked" : ""} ${st}`}>
                <input
                  type="radio"
                  name={`qt-${q.id}`}
                  value={j}
                  checked={ans === j}
                  disabled={locked}
                  onChange={() => setAnswers((prev) => Object.assign([...prev], { [i]: j }))}
                />
                <span className="quiz-opt__key">{QUIZ_KEYS[j]}</span>
                <span className="quiz-opt__text">{o}</span>
                {locked && j === q.answer ? <CircleCheck className="i quiz-opt__icon" aria-hidden /> : locked && j === ans ? <CircleX className="i quiz-opt__icon" aria-hidden /> : null}
              </label>
            );
          })}
        </div>
        {locked ? (
          <div className={`quiz-feedback ${right ? "is-right" : "is-wrong"}`} role="status">
            <div className="quiz-feedback__title">
              {right ? <CircleCheck className="i i-sm" aria-hidden /> : <CircleX className="i i-sm" aria-hidden />}
              {right ? "Correct" : `Not quite — the answer is ${QUIZ_KEYS[q.answer]}`}
            </div>
            {q.explain ? <p translate="no">{q.explain}</p> : null}
          </div>
        ) : null}
        <div className="quiz-take__nav">
          <Button variant="tertiary" onPress={() => setI(Math.max(0, i - 1))} isDisabled={i === 0}>
            <ArrowLeft className="i" aria-hidden />
            Back
          </Button>
          <Button variant="ghost" onPress={() => setMode(last ? "result" : "start")}>
            Exit
          </Button>
          <span className="grow" />
          {i === n - 1 ? (
            <Button variant="primary" onPress={() => void submit()}>
              <Check className="i" aria-hidden />
              {practice ? "See results" : "Submit"}
            </Button>
          ) : (
            <Button variant={ans !== null ? "primary" : "tertiary"} onPress={() => setI(i + 1)}>
              Next
              <ArrowRight className="i" aria-hidden />
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (mode === "result" && last) {
    const p = pct(last.score, n);
    const missed = keyed.filter((q, j) => last.answers[j] !== q.answer);
    const msg = p >= 80 ? "Strong result." : p >= 50 ? "A good base — a few things to review." : "Worth another look at the materials.";
    const canGuide = (space ? workflowsFor(settings, space) : []).some((f) => f.id === "STUDY_GUIDE");
    const short = (a.displayName ?? "").split(" — ")[0];
    return (
      <>
        <div className="card card--lg quiz-score">
          <div className="quiz-score__row">
            <div>
              <div className="t-label">Your score</div>
              <div className="quiz-score__num num">
                {last.score}
                <span>/{n}</span>
              </div>
            </div>
            <div className="grow">
              <div className="t-subheading">{msg}</div>
              <div className="t-sm muted">
                {p}%{missed.length ? ` · ${plural(missed.length, "question")} to review` : ""}
              </div>
            </div>
          </div>
          <ProgressBar aria-label="Score" value={p} color={p >= 80 ? "success" : p >= 50 ? "warning" : "danger"}>
            <ProgressBar.Track>
              <ProgressBar.Fill />
            </ProgressBar.Track>
          </ProgressBar>
          <div className="quiz-next">
            <div className="t-label">Next step</div>
            <div className="row gap-8 wrap">
              {canGuide ? (
                <Button
                  variant="primary"
                  onPress={() =>
                    router.push(
                      newWorkHref({
                        workflow: "STUDY_GUIDE",
                        space: a.space ? resourceId(a.space) : undefined,
                        docs: a.sourceItems,
                        title: missed.length ? `${short} — what I missed` : `${short} — study guide`,
                      }),
                    )
                  }
                >
                  <BookOpen className="i" aria-hidden />
                  {missed.length ? "Make a study guide on what I missed" : "Make a study guide"}
                </Button>
              ) : null}
              <Button variant="tertiary" onPress={start}>
                <RotateCcw className="i" aria-hidden />
                Try again
              </Button>
            </div>
          </div>
        </div>
        <Section title="Your answers">
          <div className="quiz-list" translate="no">
            {keyed.map((q, j) => {
              const ans = last.answers[j];
              const ok = ans === q.answer;
              return (
                <div key={q.id} className="card quiz-q quiz-q--review">
                  <div className="quiz-q__head">
                    <span className={`quiz-q__n ${ok ? "is-right" : "is-wrong"}`} aria-label={ok ? "Correct" : "Incorrect"}>
                      {ok ? <Check className="i i-sm" aria-hidden /> : <X className="i i-sm" aria-hidden />}
                    </span>
                    <div className="quiz-q__text">
                      {j + 1}. {q.q}
                    </div>
                  </div>
                  <ol className="quiz-key">
                    {q.options.map((o, k) => (
                      <li key={k} className={`quiz-key__opt ${k === q.answer ? "is-correct" : k === ans ? "is-wrong" : ""}`}>
                        <span className="quiz-opt__key">{QUIZ_KEYS[k]}</span>
                        <span className="grow">{o}</span>
                        {k === q.answer ? (
                          <span className="quiz-key__tag" translate="yes">
                            <Check className="i i-sm" aria-hidden />
                            {k === ans ? "Your answer" : "Correct answer"}
                          </span>
                        ) : k === ans ? (
                          <span className="quiz-key__tag" translate="yes">
                            <X className="i i-sm" aria-hidden />
                            Your answer
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                  {ans === null ? (
                    <div className="t-xs muted" translate="yes">
                      Not answered
                    </div>
                  ) : null}
                  {q.explain ? <div className="quiz-q__explain">{q.explain}</div> : null}
                </div>
              );
            })}
          </div>
        </Section>
      </>
    );
  }

  return (
    <div className="card card--lg quiz-start">
      <ItemIcon icon={practice ? Play : CircleCheck} tone="accent" />
      <div>
        <h2 className="t-heading">{practice ? "Practice quiz" : "Ready when you are"}</h2>
        <p className="t-sm muted mt-4">
          {practice ? "Each answer is checked right away and explained." : "Answer every question, then submit. You’ll see your score and why each answer is right."}
        </p>
      </div>
      <div className="quiz-facts">
        <span className="quiz-fact">{plural(n, "question")}</span>
        <span className="quiz-fact">No time limit</span>
        {practice ? <span className="quiz-fact">Instant feedback</span> : null}
      </div>
      <div className="row gap-8 wrap">
        <Button variant="primary" onPress={start}>
          <Play className="i" aria-hidden />
          {last ? "Try again" : "Start quiz"}
        </Button>
        {last ? (
          <Button variant="tertiary" onPress={() => setMode("result")}>
            See last result
          </Button>
        ) : null}
      </div>
    </div>
  );
}
