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
      title: `Công bố cho ${space.displayName}?`,
      description: `Thành viên của ${space.displayName} có thể mở bài này từ mục Công việc và làm bài.`,
      confirmLabel: "Công bố",
      tone: "accent",
    });
    if (ok) await actions.setAudience("SPACE", `Đã công bố cho ${space.displayName}`);
  };
  return (
    <Button variant="primary" onPress={() => void publish()} isDisabled={a.state !== "ACTIVE"}>
      <Send className="i" aria-hidden />
      {`Công bố vào ${space.displayName}`}
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
      <Callout tone="warning" icon={TriangleAlert} title="Bài kiểm tra này bị ẩn với bạn" description="Nội dung dùng nguồn bạn không còn mở được. Hãy nhờ chủ sở hữu chia sẻ lại." />
    ) : (
      <ErrorState error={text.error} onRetry={() => void text.refetch()} />
    );
  const qs = parseQuiz(text.data ?? "");
  if (!qs)
    return (
      <div className="stack gap-16">
        <Callout title="Hiển thị nguyên văn" description="Không tách được từng câu hỏi, nên bài kiểm tra được hiển thị đúng như trợ lý đã viết." />
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
      setEdit({ ...edit, err: "Nhập câu hỏi và cả bốn đáp án." });
      return;
    }
    const q: QuizQuestion = { id: edit.id, q: edit.q.trim(), options: edit.options.map((o) => o.trim()), answer: edit.answer, explain: edit.explain.trim() };
    const next = edit.isNew ? [...questions, q] : questions.map((x) => (x.id === edit.id ? q : x));
    const i = next.findIndex((x) => x.id === edit.id);
    if (await save(next, edit.isNew ? "Đã thêm một câu hỏi" : `Đã sửa câu hỏi ${i + 1}`)) {
      setEdit(null);
      toast(edit.isNew ? "Đã thêm câu hỏi" : "Đã lưu câu hỏi");
    }
  };
  const remove = async (i: number) => {
    if (questions.length === 1) {
      toast("Bài kiểm tra cần ít nhất một câu hỏi.", { tone: "danger" });
      return;
    }
    const next = questions.filter((_, j) => j !== i);
    if (await save(next, `Đã xóa câu hỏi ${i + 1}`))
      toast(`Đã xóa câu hỏi ${i + 1}`, { undo: () => void save(questions, `Đã khôi phục câu hỏi ${i + 1}`) });
  };
  const regen = async (q: QuizQuestion, i: number) => {
    setBusy(q.id);
    const ok = await actions.revise(
      { instructions: `Replace only question ${i + 1} (“${q.q}”) with a different question from the materials. Keep every other question and the answer key format exactly as they are.` },
      { failure: "Không thay được câu hỏi" },
    );
    setBusy(null);
    if (ok) toast("Đã thay câu hỏi");
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
              Đã công bố cho <span translate="no">{space?.displayName}</span>
            </span>
          </>
        ) : (
          <>
            <EyeOff className="i i-sm" aria-hidden />
            <span>Bản nháp — chỉ nhóm giảng dạy nhìn thấy. Hãy kiểm tra các câu hỏi rồi công bố.</span>
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
                  <IconButton icon={Pencil} tip="Chỉnh sửa" size="sm" onPress={() => open(q)} isDisabled={!!edit || generating} />
                  <IconButton icon={RefreshCw} tip="Tạo lại" size="sm" onPress={() => void regen(q, i)} isDisabled={!!edit || !!busy || generating} />
                  <IconButton icon={Trash2} tip="Gỡ" size="sm" onPress={() => void remove(i)} isDisabled={!!edit || generating} />
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
                        Đúng
                      </span>
                    ) : null}
                  </li>
                ))}
              </ol>
              {q.explain ? <div className="quiz-q__explain">{q.explain}</div> : null}
              {q.answer < 0 ? (
                <div className="quiz-q__foot" translate="yes">
                  <span className="t-xs muted">Chưa đánh dấu đáp án — hãy sửa câu hỏi để chọn một đáp án.</span>
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
            Thêm câu hỏi
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
      <div className="t-subheading">{e.isNew ? "Câu hỏi mới" : `Sửa câu hỏi ${index + 1}`}</div>
      <TextField className="field" value={e.q} onChange={(q) => onChange({ ...e, q, err: "" })} isInvalid={!!e.err && !e.q.trim()} isRequired autoFocus>
        <Label>Câu hỏi</Label>
        <TextArea rows={2} translate="no" />
      </TextField>
      <div className="field">
        <span className="label">
          Câu trả lời<span className="label__req" aria-hidden="true">*</span>
        </span>
        <div className="quiz-edit__opts">
          {e.options.map((o, j) => (
            <div key={j} className="quiz-edit__opt">
              <Tip content="Đánh dấu là đúng">
                <button
                  type="button"
                  className={`quiz-edit__key${e.answer === j ? " is-on" : ""}`}
                  aria-pressed={e.answer === j}
                  aria-label={`Đánh dấu đáp án ${QUIZ_KEYS[j]} là đúng`}
                  onClick={() => onChange({ ...e, answer: j })}
                >
                  {e.answer === j ? <Check className="i i-sm" aria-hidden /> : QUIZ_KEYS[j]}
                </button>
              </Tip>
              <TextField
                aria-label={`Đáp án ${QUIZ_KEYS[j]}`}
                value={o}
                onChange={(v) => onChange({ ...e, options: e.options.map((x, k) => (k === j ? v : x)), err: "" })}
                isInvalid={missing[j]}
                className="grow"
              >
                <Input placeholder={`Đáp án ${QUIZ_KEYS[j]}`} translate="no" />
              </TextField>
            </div>
          ))}
        </div>
        <div className="description">Chọn một chữ cái để đánh dấu đáp án đúng.</div>
      </div>
      <TextField className="field" value={e.explain} onChange={(explain) => onChange({ ...e, explain })}>
        <Label>
          Giải thích <span className="label__opt">(không bắt buộc)</span>
        </Label>
        <TextArea rows={2} translate="no" />
        <span className="description">Sinh viên thấy nội dung này sau khi trả lời.</span>
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
          Hủy
        </Button>
        <Button variant="primary" onPress={onSave}>
          Lưu
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
  if (!keyed.length) return <EmptyState icon={List} title="Bài kiểm tra này chưa có câu hỏi" boxed />;

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
    toast(`Đúng ${score}/${n} câu`);
  };
  const submit = async () => {
    const picked = keyed.map((_, j) => answers[j] ?? null);
    const open = picked.filter((x) => x === null).length;
    if (practice && !open) return finish(picked);
    const ok = await confirm({
      title: open ? `Nộp bài với ${plural(open, "câu chưa trả lời")}?` : "Nộp bài?",
      description: open ? "Câu chưa trả lời được tính là sai." : "Bạn sẽ thấy điểm số và lý do mỗi đáp án đúng.",
      confirmLabel: "Gửi",
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
          <span className="t-sm medium">{`Câu ${i + 1}/${n}`}</span>
          <span className="t-sm muted num">{`${answered} đã trả lời`}</span>
        </div>
        <ProgressBar aria-label={`Câu ${i + 1}/${n}`} value={((i + 1) / n) * 100}>
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
              {right ? "Đúng" : `Chưa đúng — đáp án là ${QUIZ_KEYS[q.answer]}`}
            </div>
            {q.explain ? <p translate="no">{q.explain}</p> : null}
          </div>
        ) : null}
        <div className="quiz-take__nav">
          <Button variant="tertiary" onPress={() => setI(Math.max(0, i - 1))} isDisabled={i === 0}>
            <ArrowLeft className="i" aria-hidden />
            Quay lại
          </Button>
          <Button variant="ghost" onPress={() => setMode(last ? "result" : "start")}>
            Thoát
          </Button>
          <span className="grow" />
          {i === n - 1 ? (
            <Button variant="primary" onPress={() => void submit()}>
              <Check className="i" aria-hidden />
              {practice ? "Xem kết quả" : "Gửi"}
            </Button>
          ) : (
            <Button variant={ans !== null ? "primary" : "tertiary"} onPress={() => setI(i + 1)}>
              Tiếp
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
    const msg = p >= 80 ? "Kết quả tốt." : p >= 50 ? "Nền tảng tốt — còn vài điểm cần ôn lại." : "Nên xem lại tài liệu.";
    const canGuide = (space ? workflowsFor(settings, space) : []).some((f) => f.id === "STUDY_GUIDE");
    const short = (a.displayName ?? "").split(" — ")[0];
    return (
      <>
        <div className="card card--lg quiz-score">
          <div className="quiz-score__row">
            <div>
              <div className="t-label">Điểm của bạn</div>
              <div className="quiz-score__num num">
                {last.score}
                <span>/{n}</span>
              </div>
            </div>
            <div className="grow">
              <div className="t-subheading">{msg}</div>
              <div className="t-sm muted">
                {p}%{missed.length ? `· ${plural(missed.length, "question")} cần ôn lại` : ""}
              </div>
            </div>
          </div>
          <ProgressBar aria-label="Điểm" value={p} color={p >= 80 ? "success" : p >= 50 ? "warning" : "danger"}>
            <ProgressBar.Track>
              <ProgressBar.Fill />
            </ProgressBar.Track>
          </ProgressBar>
          <div className="quiz-next">
            <div className="t-label">Bước tiếp theo</div>
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
                        title: missed.length ? `${short} — những câu tôi làm sai` : `${short} — tài liệu ôn tập`,
                      }),
                    )
                  }
                >
                  <BookOpen className="i" aria-hidden />
                  {missed.length ? "Tạo tài liệu ôn tập về phần tôi làm sai" : "Tạo tài liệu ôn tập"}
                </Button>
              ) : null}
              <Button variant="tertiary" onPress={start}>
                <RotateCcw className="i" aria-hidden />
                Thử lại
              </Button>
            </div>
          </div>
        </div>
        <Section title="Bài làm của bạn">
          <div className="quiz-list" translate="no">
            {keyed.map((q, j) => {
              const ans = last.answers[j];
              const ok = ans === q.answer;
              return (
                <div key={q.id} className="card quiz-q quiz-q--review">
                  <div className="quiz-q__head">
                    <span className={`quiz-q__n ${ok ? "is-right" : "is-wrong"}`} aria-label={ok ? "Đúng" : "Sai"}>
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
                            {k === ans ? "Câu trả lời của bạn" : "Đáp án đúng"}
                          </span>
                        ) : k === ans ? (
                          <span className="quiz-key__tag" translate="yes">
                            <X className="i i-sm" aria-hidden />
                            Câu trả lời của bạn
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                  {ans === null ? (
                    <div className="t-xs muted" translate="yes">
                      Chưa trả lời
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
        <h2 className="t-heading">{practice ? "Bài luyện tập" : "Bắt đầu khi bạn sẵn sàng"}</h2>
        <p className="t-sm muted mt-4">
          {practice ? "Mỗi câu trả lời được chấm và giải thích ngay." : "Trả lời tất cả câu hỏi rồi nộp bài. Bạn sẽ thấy điểm số và lý do mỗi đáp án đúng."}
        </p>
      </div>
      <div className="quiz-facts">
        <span className="quiz-fact">{plural(n, "question")}</span>
        <span className="quiz-fact">Không giới hạn thời gian</span>
        {practice ? <span className="quiz-fact">Phản hồi tức thì</span> : null}
      </div>
      <div className="row gap-8 wrap">
        <Button variant="primary" onPress={start}>
          <Play className="i" aria-hidden />
          {last ? "Thử lại" : "Bắt đầu làm bài"}
        </Button>
        {last ? (
          <Button variant="tertiary" onPress={() => setMode("result")}>
            Xem kết quả gần nhất
          </Button>
        ) : null}
      </div>
    </div>
  );
}
