/**
 * The Local Combo AI runner.
 *
 * A run is the plan from localRouter: one installed model per role, one pass
 * per model, and only the models the request actually needs. The last stage's
 * answer is the answer. There is no aggregation step, no synthesis request and
 * no per-model commentary in the conversation.
 *
 * Stages run one at a time, because the device is the bottleneck. An earlier
 * stage's findings are bounded context for the next stage; a picture is only
 * ever sent to the vision stage.
 */

import {
  buildRoutingPlan,
  buildStageMessages,
  planSummary,
  stageRoleLabel
} from "./localRouter.js";

export function abortError() {
  const error = new Error("The local run was stopped.");
  error.name = "AbortError";
  return error;
}

function errorMessage(error) {
  return String(error?.message || error || "The model did not answer.").trim();
}

function normalizeImages(images) {
  return (Array.isArray(images) ? images : [])
    .map(value => (typeof value === "string" ? value : String(value?.data || "").trim()))
    .filter(Boolean);
}

function stageTrace(stage, status, answer, startedAt) {
  return {
    role: stage.role,
    model: stage.model,
    final: Boolean(stage.final),
    status,
    chars: String(answer || "").trim().length,
    elapsedMs: Date.now() - startedAt
  };
}

/**
 * Run one routing plan.
 *
 * `callModel(name, { messages, signal, onChunk })` must resolve to the full
 * answer text. `onEvent` describes every real step so the chat can show the
 * stage that is running without exposing it as the answer.
 */
export async function runLocalCombo({
  models = [],
  task = "",
  history = [],
  images = [],
  plan: providedPlan = null,
  callModel,
  callAgent = null,
  onEvent = () => {},
  signal
} = {}) {
  if (typeof callModel !== "function") throw new Error("A local model caller is required.");
  const trimmedTask = String(task || "").trim();
  const imageList = normalizeImages(images);
  if (!trimmedTask && imageList.length === 0) {
    throw new Error("A local run needs a request to work on.");
  }
  const plan = providedPlan?.ok
    ? providedPlan
    : buildRoutingPlan({ task: trimmedTask, history, images: imageList, models });
  if (!plan?.ok || !Array.isArray(plan.stages) || plan.stages.length === 0) {
    const error = new Error(plan?.error || "No local model can answer this request.");
    error.plan = plan || null;
    throw error;
  }

  const startedAt = Date.now();
  onEvent({ type: "plan", plan: planSummary(plan) });

  const completed = [];
  const failures = [];
  const traces = [];
  for (let index = 0; index < plan.stages.length; index += 1) {
    const stage = plan.stages[index];
    const total = plan.stages.length;
    if (signal?.aborted) throw abortError();
    const label = stageRoleLabel(stage.role);
    onEvent({
      type: "stage-start",
      index,
      total,
      role: stage.role,
      label,
      model: stage.model,
      final: Boolean(stage.final)
    });
    const stageStartedAt = Date.now();
    let streamed = "";
    const onChunk = chunk => {
      const piece = String(chunk || "");
      if (!piece) return;
      streamed += piece;
      onEvent({
        type: "stage-chunk",
        index,
        total,
        role: stage.role,
        label,
        model: stage.model,
        final: Boolean(stage.final),
        chunk: piece
      });
    };
    try {
      const stageMessages = buildStageMessages({
        stage,
        task: trimmedTask,
        history,
        images: imageList,
        priorStages: completed
      });
      const result =
        stage.final && typeof callAgent === "function"
          ? await callAgent(stage.model, {
              messages: stageMessages,
              task: trimmedTask,
              signal,
              onChunk,
              onDiscard: () => {
                streamed = "";
                onEvent({
                  type: "stage-reset",
                  index,
                  total,
                  role: stage.role,
                  label,
                  model: stage.model,
                  final: Boolean(stage.final)
                });
              }
            })
          : await callModel(stage.model, {
              messages: stageMessages,
              signal,
              onChunk
            });
      const text = String((typeof result === "string" ? result : result?.content) || streamed || "").trim();
      if (!text) throw new Error("returned no text");
      completed.push({ role: stage.role, model: stage.model, answer: text });
      traces.push(stageTrace(stage, "done", text, stageStartedAt));
      onEvent({
        type: "stage-done",
        index,
        total,
        role: stage.role,
        label,
        model: stage.model,
        final: Boolean(stage.final),
        chars: text.length
      });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      const message = errorMessage(error);
      failures.push({ role: stage.role, model: stage.model, error: message });
      traces.push(stageTrace(stage, "failed", streamed, stageStartedAt));
      onEvent({
        type: "stage-failed",
        index,
        total,
        role: stage.role,
        label,
        model: stage.model,
        final: Boolean(stage.final),
        error: message
      });
      const isFinalStage = index === total - 1;
      // A picture that is the only source for the answer cannot be skipped.
      // A reference image that only guides the look can be skipped safely, so
      // the later coding stage still runs and the failure stays in the record.
      const imageEssential = plan.attachments?.essential !== false;
      const cannotContinue = stage.role === "vision" && imageEssential;
      if (isFinalStage || cannotContinue) {
        const failure =
          stage.role === "vision"
            ? new Error(`${stage.model} could not read the image: ${message}`)
            : new Error(
                completed.length > 0
                  ? `${stage.model} could not finish the run: ${message}`
                  : `No local model could answer. ${failures
                      .map(failure => `${failure.model}: ${failure.error}`)
                      .join("; ")}`
              );
        failure.plan = plan;
        failure.failures = failures;
        failure.stages = traces;
        failure.stageOutputs = completed;
        failure.partial = streamed;
        throw failure;
      }
      // A reasoning pass that fails is not the answer: the next stage still
      // runs, using whatever earlier stages did complete.
    }
  }

  const finalOutput = completed[completed.length - 1];
  if (!finalOutput) {
    const error = new Error(
      `No local model could answer. ${failures
        .map(failure => `${failure.model}: ${failure.error}`)
        .join("; ")}`
    );
    error.plan = plan;
    error.failures = failures;
    error.stages = traces;
    error.stageOutputs = completed;
    throw error;
  }

  return {
    plan,
    planSummary: planSummary(plan),
    stages: traces,
    failures,
    finalAnswer: finalOutput.answer,
    usedModels: completed.map(entry => entry.model),
    elapsedMs: Date.now() - startedAt
  };
}
