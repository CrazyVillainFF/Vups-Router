/**
 * The local intent router.
 *
 * Combined Local AI used to run every selected model on every request. That is
 * slow and noisy: a greeting does not need a reasoning model, and a coding
 * question does not need a vision model. This module reads the request with
 * deterministic rules — no model is asked to classify anything — and picks the
 * smallest set of roles that can answer it.
 *
 * The request is understood first: what the user wants to end up with, which
 * skills that ask needs, and whether an attached image is a reference for the
 * work or the subject of the question. An image never replaces the goal; it is
 * an input to it. The output is a plan: an ordered list of roles, each bound to
 * one installed model. A model appears at most once, and the last stage writes
 * the answer the user sees. Nothing here performs I/O, so routing cannot delay
 * a send.
 */

const MAX_TASK_PREVIEW = 120;
const MAX_HISTORY_MESSAGES = 12;
const MAX_HISTORY_CHARS = 2000;
const MAX_PRIOR_CHARS = 3000;

const GREETING_PATTERN =
  /^(?:hi+|hey+|hello+|hii+|yo|sup|hola|namaste|good (?:morning|afternoon|evening)|how are you|how's it going|thanks|thank you|thx|ok|okay|cool|nice|great)[\s!.,?…]*$/i;

const CALCULATION_PATTERN =
  /^(?:what(?:'s| is)\s+)?-?\d+(?:\.\d+)?(?:\s*[+\-*/x×÷]\s*-?\d+(?:\.\d+)?)+[\s=?]*$/i;

const PLAN_PATTERN =
  /\b(?:make a plan|create a plan|write a plan|draft a plan|outline a plan|plan (?:my|a|the|out)|roadmap|project plan|study plan|learning path|schedule|itinerary|strategy|milestones?|timeline|steps to|how (?:do|should) i (?:start|approach|organize|prepare)|prepare for)\b/i;

const EXPLICIT_PLAN_PATTERN =
  /\b(?:make|create|write|draft|outline|develop|build)\b[^\n.]{0,30}\bplan\b/i;

// A plan request ("make a study plan", "plan the architecture") stays planning
// even when it names a technical subject. A request that asks to build or
// produce the thing itself is handed to the coding model.
const STRONG_CODE_ACTION_PATTERN =
  /\b(?:write|create|build|generate|implement|develop|code|recreate|clone|fix|debug|refactor|optimi[sz]e|convert|rewrite|extend|complete|finish)\b/i;

const CODE_NOUN_PATTERN =
  /\b(?:code|function|component|class|api|endpoint|script|program|app|application|website|web ?app|web ?page|webpage|site|landing page|frontend|backend|full[- ]?stack|game|games|dashboard|calculator|portfolio|clone|ui|interface|form|widget|simulation|tool|html|css|javascript|typescript|python|java|c\+\+|c#|rust|golang|php|ruby|sql|query|regex|unit test|tests?|bug|stack trace|traceback|exception|syntax error|compile|npm|node\.?js|react|next\.?js|vue|svelte|tailwind|database schema|docker|git|json|terminal command)\b/i;

const CODE_ACTION_PATTERN =
  /\b(?:write|create|build|make|generate|implement|develop|code|design|recreate|clone|copy|convert|fix|debug|refactor|optimi[sz]e|add|update|rewrite|continue|deploy|install|change|review|explain|extend|complete|finish)\b/i;

const DEBUG_PATTERN =
  /\b(?:debug|stack ?trace|traceback|error:|exception|fails?|failing|crash(?:es|ed|ing)?|not working|broken|why does .* (?:fail|crash|break)|syntax error|typeerror|referenceerror)\b/i;

const CODE_FENCE_PATTERN = /```/;

const CODE_FILE_PATTERN =
  /\b[\w./-]+\.(?:jsx?|tsx?|mjs|cjs|py|java|kt|swift|cpp|cc|c|cs|go|rs|php|rb|html|css|scss|json|sql|sh|ps1)\b/i;

const CODE_COMPLEXITY_PATTERN =
  /\b(?:architecture|multi[- ]file|multi[- ]page|full[- ]stack|refactor|optimi[sz]e|performance|concurren\w*|race condition|complex|several requirements|multiple requirements|production[- ]ready|scalable|enterprise|authentication|state management)\b/i;

const COMPLEXITY_PATTERN =
  /\b(?:compare|comparison|analy[sz]e|analysis|trade-?offs?|in depth|in detail|step[- ]by[- ]step|advantages? and disadvantages?|pros and cons|evaluate|critique|design|architecture|prove|derive|multi[- ]step|end[- ]to[- ]end|detailed)\b/i;

const IMAGE_DIRECT_PATTERN =
  /^(?:what(?:'s| is| are) (?:this|these|that|in (?:this|the) (?:image|picture|photo|screenshot))|what (?:do|can) you see|what does (?:this|it) (?:say|show)|who is (?:this|in this)|read (?:this|the) (?:image|text)|translate (?:this|the) (?:image|text)|describe (?:this|the) (?:image|picture|photo|screenshot))/i;

const IMAGE_QUESTION_PATTERN =
  /\b(?:what(?:'s| is| are) (?:this|that|these|those)|what (?:do|can) you see|what does (?:this|it|the (?:image|picture|screenshot)) (?:say|show)|who is (?:this|that)|where is|how many|which one|is (?:this|that|these|those)|are (?:these|those)|read (?:this|the|it)|translate (?:this|the|it)|describe (?:this|the|it)|explain (?:this|the|it|the screenshot)|tell me about (?:this|the) (?:image|picture|photo|screenshot))/i;

const IMAGE_REFERENCE_PATTERN =
  /\b(?:this|the|that|attached|uploaded|provided|following)\s+(?:image|picture|photo|screenshot|screen shot|mockup|mock-up|design|wireframe|reference|attachment|ui|interface)\b|\b(?:image|picture|photo|screenshot|reference|mockup|design|wireframe)\s+(?:above|below|attached)\b|\b(?:using|from|based on|inspired by|look at)\s+(?:this|the|that|attached|uploaded|provided)\b/i;

const IMAGE_STYLE_REFERENCE_PATTERN =
  /\b(?:similar|same|reference|attached|this|that)\s+(?:visual\s+)?(?:design|style|look|theme|layout|colou?rs?|ui)\b|\b(?:visual|design|style|look|layout)\b[^\n.]{0,24}\b(?:reference|attached|shown|screenshot)\b/i;

const IMAGE_ANALYSIS_PATTERN =
  /\b(?:explain|analy[sz]e|interpret|summari[sz]e|review|critique|audit|assess|diagnose)\b/i;

const IMAGE_COMPLEX_PATTERN =
  /\b(?:compare|comparison|contrast|trade-?offs?|pros and cons|advantages? and disadvantages?|in depth|in detail|step[- ]by[- ]step|architecture|layout|structure|hierarchy|two|both|versus|vs\.?|why)\b/i;

const IMAGE_MENTION_PATTERN =
  /\b(?:image|picture|photo|screenshot|screen shot|mockup|mock-up|wireframe)\b/i;

// The image is the only source for these asks: the deliverable has to match
// what is visible, or the text the reader needs is inside the picture.
const IMAGE_ESSENTIAL_PATTERN =
  /\b(?:exact|exactly|pixel[- ]perfect|faithfully|as shown|shown (?:here|in)|from (?:this|the) (?:image|picture|photo|screenshot|mockup|wireframe|design|ui|reference)|based on (?:this|the) (?:image|picture|photo|screenshot|mockup|wireframe|design|ui|reference)|recreate|replicate|clone|copy|match|convert (?:this|the) (?:image|screenshot|design|ui)|debug\b[^\n.]{0,48}\b(?:screenshot|image|picture|photo)|fix\b[^\n.]{0,48}\b(?:screenshot|image|picture|photo)|read\b[^\n.]{0,32}\b(?:text|code)\b[^\n.]{0,32}\b(?:image|screenshot|picture|photo)|extract|translate|transcribe)\b/i;

const IMAGE_APP_DELIVERABLE_PATTERN =
  /\b(?:app|application|platform|system|dashboard|project|suite)\b/i;

const ROLE_ORDER = Object.freeze(["vision", "reasoning", "coding", "chat"]);

const ROLE_LABEL = Object.freeze({
  vision: "Vision",
  reasoning: "Reasoning",
  coding: "Code",
  chat: "Chat"
});

const ROLE_SYSTEM = Object.freeze({
  visionIntermediate:
    "You are the vision step of a local run on this device. Look at the attached image and report exactly what it shows: " +
    "visible text, objects, layout, colors, typography, and any details that matter for the request. If the request asks " +
    "you to build or implement something, describe the structure, components, spacing, and visual rules needed to " +
    "implement it. Do not answer the user's question yet; your notes are passed to the next local model.",
  visionFinal:
    "You are the vision model of a local run on this device. Look at the attached image and answer the user's request " +
    "directly in one clear answer. Describe only what is visible; never invent details.",
  reasoning:
    "You are the reasoning step of a local run on this device. Work through the request: break it down, identify what " +
    "matters, and outline the answer. If the request asks for code, return a concise implementation plan — project " +
    "structure, files, and the steps to build them — for the coding model. Do not write the final user-facing answer; " +
    "your findings are passed to the next local model.",
  coding:
    "You are the coding model of a local run on this device. Implement the user's request; do not merely describe it. " +
    "When the request asks for a game, website, app, or program, write the complete working source, not a sketch. " +
    "Put each file in its own fenced code block and put the relative file path in the block info string, for example " +
    "```html index.html. Create every file the project needs, including nested folders such as src/ and assets/. " +
    "Never say you would create a file — write its full contents. After the code, add only a short explanation. If " +
    "earlier local step results are included, use them and do not repeat them.",
  chatFinal:
    "You are the final answering model of a local run on this device. Using the request and any earlier local step " +
    "results, write the single clear answer for the user. Do not mention models, steps, drafts, or that other models ran. " +
    "Do not repeat the step notes.",
  chatOnly:
    "You are the local chat model on this device. Answer the user's request directly in one clear answer. " +
    "Do not mention models or routing."
});

function textOf(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanTask(task, images) {
  const text = textOf(task);
  if (text) return text;
  return images.length > 0 ? "Describe this image." : "";
}

function normalizeImages(images) {
  return (Array.isArray(images) ? images : [])
    .map(value => (typeof value === "string" ? value : textOf(value?.data)))
    .filter(Boolean);
}

function countSentences(text) {
  return (String(text).match(/[.!?](?:\s|$)/g) || []).length;
}

function questionCount(text) {
  return (String(text).match(/\?/g) || []).length;
}

function isCodingKind(kind) {
  return kind === "coding" || kind === "coding-complex";
}

function textIntent(kind, signals, reason, objective, deliverable, skills) {
  return { kind, signals, reason, objective, deliverable, skills };
}

function codingComplexity(text, { hasDebug = false, hasFence = false } = {}) {
  const hardDebug =
    hasDebug && /\b(?:why|fix|debug|crash|fails?|failing|broken|not working)\b/i.test(text);
  return (
    hardDebug ||
    text.length > 320 ||
    (hasFence && text.length > 600) ||
    CODE_COMPLEXITY_PATTERN.test(text)
  );
}

/**
 * Rules, in order. A definitional question about a technology ("What is
 * HTML?") stays a general question; only a request that asks to produce or
 * repair code is routed to the coding model.
 */
function classifyText(task) {
  const text = String(task || "").trim();
  if (!text) {
    return textIntent(
      "simple",
      ["empty"],
      "Empty request.",
      "Answer the request",
      "answer",
      ["chat"]
    );
  }
  if (GREETING_PATTERN.test(text)) {
    return textIntent(
      "greeting",
      ["greeting"],
      "Short greeting.",
      "Respond to the greeting",
      "reply",
      ["chat"]
    );
  }
  if (CALCULATION_PATTERN.test(text)) {
    return textIntent(
      "simple",
      ["calculation"],
      "Simple calculation.",
      "Answer a simple calculation",
      "answer",
      ["chat"]
    );
  }

  const hasFence = CODE_FENCE_PATTERN.test(text);
  const hasCodeNoun = CODE_NOUN_PATTERN.test(text);
  const hasCodeAction = CODE_ACTION_PATTERN.test(text);
  const hasStrongCodeAction = STRONG_CODE_ACTION_PATTERN.test(text);
  const hasDebug = DEBUG_PATTERN.test(text);
  const hasCodeFile = CODE_FILE_PATTERN.test(text);
  const planningRequest =
    !hasFence &&
    !hasDebug &&
    (EXPLICIT_PLAN_PATTERN.test(text) || (PLAN_PATTERN.test(text) && !hasStrongCodeAction));
  if (planningRequest) {
    return textIntent(
      "planning",
      ["planning"],
      "Planning request.",
      "Produce a plan",
      "plan",
      ["reasoning", "chat"]
    );
  }

  const looksCoding = hasFence || hasCodeFile || hasDebug || (hasCodeNoun && hasCodeAction);
  if (looksCoding) {
    const complexCoding = codingComplexity(text, { hasDebug, hasFence });
    return complexCoding
      ? textIntent(
          "coding-complex",
          ["coding", ...(hasDebug ? ["debug"] : []), "complex"],
          "Coding problem that needs analysis.",
          "Design and build the requested software",
          "code",
          ["reasoning", "coding"]
        )
      : textIntent(
          "coding",
          ["coding"],
          "Coding request.",
          "Build the requested software",
          "code",
          ["coding"]
        );
  }

  const complex =
    text.length > 240 ||
    questionCount(text) >= 2 ||
    (countSentences(text) >= 3 && text.length > 140) ||
    COMPLEXITY_PATTERN.test(text);
  if (complex) {
    const definitional =
      /^(?:what(?:'s| is)|explain|define|tell me about)\b/i.test(text) &&
      text.length < 180 &&
      questionCount(text) <= 1;
    if (!definitional) {
      return textIntent(
        "complex",
        ["complex"],
        "Multi-step question.",
        "Work through a multi-step question",
        "answer",
        ["reasoning", "chat"]
      );
    }
  }
  return textIntent(
    "simple",
    ["short"],
    "Short, straightforward request.",
    "Answer a short question",
    "answer",
    ["chat"]
  );
}

function imageDepthOf(text) {
  const caption = String(text || "").replace(/\s+/g, " ").trim();
  const complex =
    IMAGE_COMPLEX_PATTERN.test(caption) ||
    caption.length > 240 ||
    questionCount(caption) >= 2;
  if (complex) return "complex";
  return IMAGE_ANALYSIS_PATTERN.test(caption) ? "standard" : "simple";
}

/**
 * The intent of one request.
 *
 * The text decides the goal first. An image is then classified as an
 * attachment: relevant when the request refers to it or when it is a visual
 * reference for code, and essential when the answer depends on what is only
 * visible in the picture. No image ever replaces the goal.
 */
export function classifyLocalIntent({ task = "", history = [], images = [] } = {}) {
  const imageList = normalizeImages(images);
  const text = String(task || "").trim();
  const base = classifyText(text);
  const historyCount = Array.isArray(history) ? history.length : 0;
  const emptyCaption = imageList.length > 0 && !text;
  const mentionsImage = IMAGE_MENTION_PATTERN.test(text);
  const referencesImage = IMAGE_REFERENCE_PATTERN.test(text);
  const imageQuestion = IMAGE_QUESTION_PATTERN.test(text);
  const imageAnalysis = IMAGE_ANALYSIS_PATTERN.test(text);
  const styleReference = IMAGE_STYLE_REFERENCE_PATTERN.test(text);
  const codingIntent = isCodingKind(base.kind);

  // A coding request with an attached picture treats that picture as a visual
  // reference even when the caption only says "similar visual design"; asking
  // for code is the reason the picture was attached. Other intents need the
  // request to point at the image explicitly.
  const imageRelevant =
    imageList.length > 0 &&
    (emptyCaption ||
      referencesImage ||
      imageQuestion ||
      (mentionsImage && imageAnalysis) ||
      (codingIntent && styleReference) ||
      codingIntent);

  const attachments = {
    images: imageList.length,
    relevant: imageRelevant,
    essential: false,
    reason: ""
  };

  if (imageList.length > 0) {
    if (!imageRelevant) {
      attachments.reason = "The request does not refer to the attached image.";
    } else if (codingIntent) {
      attachments.essential = IMAGE_ESSENTIAL_PATTERN.test(text);
      attachments.reason = attachments.essential
        ? "The code has to match what the image shows."
        : "The image is a visual reference for the code.";
    } else {
      attachments.essential = true;
      attachments.reason = "The answer depends on what the image shows.";
    }
  }

  let intent;
  if (imageRelevant && codingIntent) {
    const complex = base.kind === "coding-complex";
    intent = {
      kind: complex ? "image-coding-complex" : "image-coding",
      signals: ["image", "coding", ...(complex ? ["complex"] : ["reference"])],
      reason: complex
        ? "The request needs code that justifies analysis, and the image is part of the brief."
        : "The request needs code, and the attached image is a reference for it.",
      objective: complex
        ? "Design and build the requested software from the image reference"
        : "Build the requested software using the image",
      deliverable: "code",
      skills: complex ? ["vision", "reasoning", "coding"] : ["vision", "coding"],
      imageDepth: "reference"
    };
  } else if (imageRelevant) {
    const depth = emptyCaption || IMAGE_DIRECT_PATTERN.test(text) ? "simple" : imageDepthOf(text);
    const simple = depth === "simple";
    intent = {
      kind: simple ? "image-simple" : "image",
      signals: ["image", simple ? "description" : "analysis", ...(depth === "complex" ? ["complex"] : [])],
      reason: simple
        ? "A short question about the image."
        : depth === "complex"
          ? "The image needs a reasoned reading."
          : "The image has to be read and explained.",
      objective: simple
        ? "Answer a question about the image"
        : "Understand and explain the image",
      deliverable: "answer",
      skills: depth === "complex" ? ["vision", "reasoning", "chat"] : simple ? ["vision"] : ["vision", "chat"],
      imageDepth: depth
    };
  } else {
    intent = { ...base, imageDepth: "" };
  }

  return {
    ...intent,
    attachments,
    imageUnused: imageList.length > 0 && !imageRelevant,
    history: historyCount
  };
}

function normalizeModels(models) {
  const rows = [];
  const seen = new Set();
  for (const value of Array.isArray(models) ? models : []) {
    const name = String(
      typeof value === "string" ? value : value?.name || value?.model || value?.localModel || ""
    ).trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const reported = Array.isArray(value?.capabilities)
      ? value.capabilities.map(capability => String(capability).toLowerCase())
      : Array.isArray(value?.caps)
        ? value.caps.map(capability => String(capability).toLowerCase())
        : ["chat"];
    const caps = new Set(reported);
    caps.add("chat");
    rows.push({ name, caps });
  }
  return rows;
}

function isPureChat(model) {
  return (
    model.caps.has("chat") &&
    !model.caps.has("coding") &&
    !model.caps.has("vision") &&
    !model.caps.has("thinking") &&
    !model.caps.has("reasoning")
  );
}

function pickChat(models, exclude = new Set()) {
  return (
    models.find(model => isPureChat(model) && !exclude.has(model.name.toLowerCase())) ||
    models.find(model => !model.caps.has("vision") && !exclude.has(model.name.toLowerCase())) ||
    models.find(model => !exclude.has(model.name.toLowerCase())) ||
    null
  );
}

function pickImageChat(models, exclude) {
  return models.find(model => isPureChat(model) && !exclude.has(model.name.toLowerCase())) || null;
}

function pickReasoning(models, exclude = new Set()) {
  return (
    models.find(
      model =>
        (model.caps.has("thinking") || model.caps.has("reasoning")) &&
        !model.caps.has("vision") &&
        !exclude.has(model.name.toLowerCase())
    ) ||
    models.find(
      model =>
        (model.caps.has("thinking") || model.caps.has("reasoning")) &&
        !exclude.has(model.name.toLowerCase())
    ) ||
    null
  );
}

function pickCoding(models, exclude = new Set()) {
  return models.find(model => model.caps.has("coding") && !exclude.has(model.name.toLowerCase())) || null;
}

function pickVision(models, exclude = new Set()) {
  return models.find(model => model.caps.has("vision") && !exclude.has(model.name.toLowerCase())) || null;
}

function previewOf(task) {
  const flat = String(task || "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length > MAX_TASK_PREVIEW ? `${flat.slice(0, MAX_TASK_PREVIEW - 1)}…` : flat;
}

function finalizeStages(stages, notes) {
  const seen = new Set();
  const unique = [];
  for (const stage of stages) {
    if (!stage?.model) continue;
    const key = stage.model.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({
      role: stage.role,
      model: stage.model,
      final: false,
      detail: stage.detail || ""
    });
  }
  if (unique.length > 0) unique[unique.length - 1].final = true;
  return { stages: unique, notes };
}

function buildLabel(stages) {
  if (stages.length === 0) return "";
  const roles = stages.map(stage => ROLE_LABEL[stage.role] || stage.role);
  return stages.length === 1 ? `${roles[0]} model` : roles.join(" → ");
}

const MISSING_VISION =
  "None of the selected installed local models can read images. Select a vision model on the Local AI page.";
const MISSING_VISION_ESSENTIAL =
  "This request needs the attached image read, and none of the selected installed local models can read images. " +
  "Select a vision model on the Local AI page.";
const MISSING_CODER =
  "No selected installed local model can write code. Select a coding-capable model on the Local AI page.";
const SAME_MODEL_CONFLICT =
  "The only selected model that can read images is also the only one that can write code, and a model runs at most " +
  "once per request. Select a separate vision or coding model on the Local AI page.";

function imageUnusedNote(intent, imageList) {
  if (imageList.length === 0 || intent.attachments?.relevant) return null;
  return "The attached image was not used because the request does not refer to it.";
}

/**
 * The plan for one request.
 *
 * `models` are the installed models the user selected, in selection order.
 * A model bound to an earlier role is never bound again: the brief forbids
 * running the same model twice in one plan.
 */
export function buildRoutingPlan({ task = "", history = [], images = [], models = [] } = {}) {
  const imageList = normalizeImages(images);
  const rows = normalizeModels(models);
  const intent = classifyLocalIntent({ task, history, images: imageList });
  const cleanText = cleanTask(task, imageList);
  const base = {
    ok: false,
    intent: intent.kind,
    objective: intent.objective,
    deliverable: intent.deliverable,
    skills: intent.skills,
    attachments: intent.attachments,
    imageDepth: intent.imageDepth || "",
    taskPreview: previewOf(cleanText),
    label: "",
    reason: intent.reason,
    stages: [],
    models: [],
    notes: [],
    execution: 0,
    error: ""
  };
  if (!cleanText) {
    return { ...base, error: "A local run needs a request to work on." };
  }
  if (rows.length === 0) {
    return { ...base, error: "Select at least one installed local model on the Local AI page." };
  }

  const notes = [];
  const unused = imageUnusedNote(intent, imageList);
  if (unused) notes.push(unused);

  let stages = [];
  let reason = intent.reason;

  switch (intent.kind) {
    case "greeting":
    case "simple": {
      const chat = pickChat(rows);
      stages = [
        {
          role: "chat",
          model: chat?.name,
          detail: intent.kind === "greeting" ? "Answered the greeting" : "Answered directly"
        }
      ];
      reason =
        intent.kind === "greeting"
          ? "A greeting needs one chat model, not a reasoning or vision pass."
          : "A short, straightforward request is answered by the chat model alone.";
      break;
    }
    case "complex":
    case "planning": {
      const chat = pickChat(rows);
      const reasoning = pickReasoning(rows);
      const reasoningUsable =
        reasoning && chat && reasoning.name.toLowerCase() !== chat.name.toLowerCase();
      if (reasoningUsable) {
        stages = [
          { role: "reasoning", model: reasoning.name, detail: "Worked through the request" },
          {
            role: "chat",
            model: chat.name,
            detail: intent.kind === "planning" ? "Wrote the plan" : "Wrote the final answer"
          }
        ];
        reason =
          intent.kind === "planning"
            ? "Planning benefits from a reasoning pass before the chat model writes the plan."
            : "The question needs reasoning; the chat model writes the final answer.";
      } else if (reasoning) {
        stages = [
          {
            role: "chat",
            model: reasoning.name,
            detail: intent.kind === "planning" ? "Wrote the plan" : "Wrote the final answer"
          }
        ];
        notes.push("One selected model covers reasoning and the answer, so it runs once.");
        reason = "One selected model covers reasoning and the answer, so it runs once.";
      } else {
        stages = [
          {
            role: "chat",
            model: chat?.name,
            detail: intent.kind === "planning" ? "Wrote the plan" : "Wrote the final answer"
          }
        ];
        notes.push("No reasoning model is selected, so the chat model answered directly.");
        reason = "No separate reasoning model is available, so one chat model answered.";
      }
      break;
    }
    case "coding": {
      const coding = pickCoding(rows);
      if (!coding) {
        return { ...base, error: MISSING_CODER };
      }
      stages = [{ role: "coding", model: coding.name, detail: "Wrote the implementation" }];
      reason = "A coding request is handed to the coding model, which writes the working files.";
      break;
    }
    case "coding-complex": {
      const coding = pickCoding(rows);
      if (!coding) {
        return { ...base, error: MISSING_CODER };
      }
      const reasoning = pickReasoning(rows, new Set([coding.name.toLowerCase()]));
      if (reasoning) {
        stages = [
          { role: "reasoning", model: reasoning.name, detail: "Planned the implementation" },
          { role: "coding", model: coding.name, detail: "Wrote the implementation" }
        ];
        reason =
          "The task needs analysis before code, so one reasoning pass plans it and the coding model writes it.";
      } else {
        stages = [{ role: "coding", model: coding.name, detail: "Planned and wrote the implementation" }];
        notes.push(
          "No separate reasoning model is selected, so the coding model planned and wrote the solution."
        );
        reason = "A coding problem that needs analysis is handled by the coding model directly.";
      }
      break;
    }
    case "image-simple": {
      const vision = pickVision(rows);
      if (!vision) {
        return { ...base, error: MISSING_VISION };
      }
      stages = [{ role: "vision", model: vision.name, detail: "Answered from the image" }];
      reason = "A short question about the image is answered by the vision model directly.";
      break;
    }
    case "image": {
      const vision = pickVision(rows);
      if (!vision) {
        return { ...base, error: MISSING_VISION };
      }
      stages = [{ role: "vision", model: vision.name, detail: "Read the image" }];
      const used = new Set([vision.name.toLowerCase()]);
      if (intent.imageDepth === "complex") {
        const reasoning = pickReasoning(rows, used);
        const chat = pickImageChat(rows, used);
        if (reasoning && chat) {
          stages.push({ role: "reasoning", model: reasoning.name, detail: "Worked through the visual findings" });
          stages.push({ role: "chat", model: chat.name, detail: "Wrote the final answer" });
        } else if (chat) {
          stages.push({ role: "chat", model: chat.name, detail: "Wrote the final answer" });
          notes.push(
            "No separate reasoning model is selected, so the vision reading goes straight to the final answer."
          );
        } else {
          stages[0] = { role: "vision", model: vision.name, detail: "Answered from the image" };
          notes.push(
            "No separate chat model is selected, so the vision model wrote the final answer."
          );
        }
      } else {
        const chat = pickImageChat(rows, used);
        if (chat) {
          stages.push({ role: "chat", model: chat.name, detail: "Wrote the final answer" });
        } else {
          stages[0] = { role: "vision", model: vision.name, detail: "Answered from the image" };
          notes.push(
            "No separate chat model is selected, so the vision model wrote the final answer."
          );
        }
      }
      reason =
        stages.length > 2
          ? "The image is read first, reasoning works through the details, and the chat model writes the answer."
          : stages.length === 2
            ? "The image is read first; the chat model writes the final answer."
            : "The image is read first, and the vision model writes the final answer.";
      break;
    }
    case "image-coding":
    case "image-coding-complex": {
      let coding = pickCoding(rows);
      if (!coding) {
        return { ...base, error: MISSING_CODER };
      }
      let vision = pickVision(rows);
      if (!vision) {
        if (intent.attachments.essential) {
          return { ...base, error: MISSING_VISION_ESSENTIAL };
        }
        const complex = intent.kind === "image-coding-complex";
        const reasoning = complex
          ? pickReasoning(rows, new Set([coding.name.toLowerCase()]))
          : null;
        stages = [
          ...(reasoning ? [{ role: "reasoning", model: reasoning.name, detail: "Planned the implementation" }] : []),
          {
            role: "coding",
            model: coding.name,
            detail: complex ? "Planned and wrote the implementation" : "Wrote the implementation"
          }
        ];
        notes.push(
          "None of the selected installed local models can read images, so the attached image was not used. " +
            "The code was written from the text request."
        );
        reason =
          "The request needs code. No selected model can read the image, so the coding model works from the text.";
        break;
      }
      if (vision.name.toLowerCase() === coding.name.toLowerCase()) {
        const alternativeVision = pickVision(rows, new Set([coding.name.toLowerCase()]));
        const alternativeCoding = pickCoding(rows, new Set([vision.name.toLowerCase()]));
        if (alternativeVision) {
          vision = alternativeVision;
        } else if (alternativeCoding) {
          coding = alternativeCoding;
        } else if (intent.attachments.essential) {
          return { ...base, error: SAME_MODEL_CONFLICT };
        } else {
          const complex = intent.kind === "image-coding-complex";
          const reasoning = complex
            ? pickReasoning(rows, new Set([coding.name.toLowerCase()]))
            : null;
          stages = [
            ...(reasoning ? [{ role: "reasoning", model: reasoning.name, detail: "Planned the implementation" }] : []),
            {
              role: "coding",
              model: coding.name,
              detail: complex ? "Planned and wrote the implementation" : "Wrote the implementation"
            }
          ];
          notes.push(
            "The only selected model that can read images is also the coding model, and one model runs once per " +
              "request. The image was not used; the code was written from the text request."
          );
          reason =
            "The request needs code. One selected model covers both roles, so it runs once as the coding model.";
          vision = null;
          break;
        }
      }
      const complex = intent.kind === "image-coding-complex";
      const imageReasoning =
        complex ||
        (intent.kind === "image-coding" && IMAGE_APP_DELIVERABLE_PATTERN.test(cleanText));
      const used = new Set([vision.name.toLowerCase(), coding.name.toLowerCase()]);
      const reasoning = imageReasoning ? pickReasoning(rows, used) : null;
      stages = [
        { role: "vision", model: vision.name, detail: "Read the reference image" },
        ...(reasoning ? [{ role: "reasoning", model: reasoning.name, detail: "Planned the implementation" }] : []),
        { role: "coding", model: coding.name, detail: "Wrote the implementation" }
      ];
      if (imageReasoning && !reasoning) {
        notes.push(
          "No separate reasoning model is selected, so the coding model planned and wrote the implementation."
        );
      }
      reason =
        stages.length > 2
          ? "The image is the reference: vision reads it, reasoning plans the build, and the coding model writes it."
          : "The image is the reference: vision reads it, and the coding model builds the deliverable.";
      break;
    }
    default: {
      const chat = pickChat(rows);
      stages = [{ role: "chat", model: chat?.name, detail: "Answered directly" }];
      break;
    }
  }

  const final = finalizeStages(stages, notes);
  if (final.stages.length === 0) {
    return { ...base, error: "No selected model can answer this request." };
  }
  return {
    ...base,
    ok: true,
    label: buildLabel(final.stages),
    stages: final.stages,
    models: final.stages.map(stage => stage.model),
    notes: final.notes,
    execution: final.stages.length,
    reason
  };
}

/** The plan stripped down to what is stored and shown. */
export function planSummary(plan) {
  if (!plan || !plan.ok) return null;
  return {
    intent: plan.intent,
    objective: plan.objective,
    deliverable: plan.deliverable,
    skills: [...(plan.skills || [])],
    attachments: { ...(plan.attachments || {}) },
    taskPreview: plan.taskPreview,
    label: plan.label,
    execution: plan.execution,
    reason: plan.reason || "",
    notes: [...(plan.notes || [])],
    stages: (plan.stages || []).map(stage => ({
      role: stage.role,
      model: stage.model,
      final: Boolean(stage.final),
      detail: stage.detail || ""
    }))
  };
}

export function stageRoleLabel(role) {
  return ROLE_LABEL[role] || "Chat";
}

function sanitizedHistory(history, task) {
  const rows = (Array.isArray(history) ? history : [])
    .filter(message => message && (message.role === "user" || message.role === "assistant"))
    .filter(message => typeof message.content === "string" && message.content.trim())
    .map(message => ({
      role: message.role,
      content: message.content.slice(0, MAX_HISTORY_CHARS)
    }));
  const last = rows[rows.length - 1];
  if (last?.role === "user" && last.content.trim() === task) rows.pop();
  return rows.slice(-MAX_HISTORY_MESSAGES);
}

/**
 * The messages one stage sends to its model.
 *
 * Only the vision stage receives the picture itself; every other stage reads
 * the vision step's notes. Earlier stage results are bounded, and the final
 * prompts ask for one answer rather than a discussion of the run. The original
 * request is always the last user message before those findings, so no stage
 * has to infer the goal from another model's notes.
 */
export function buildStageMessages({
  stage,
  task = "",
  history = [],
  images = [],
  priorStages = [],
  maxPriorChars = MAX_PRIOR_CHARS
} = {}) {
  const imageList = normalizeImages(images);
  const cleanText = cleanTask(task, imageList);
  const role = stage?.role || "chat";
  const isFinal = Boolean(stage?.final);
  let system = ROLE_SYSTEM.chatOnly;
  if (role === "vision") system = isFinal ? ROLE_SYSTEM.visionFinal : ROLE_SYSTEM.visionIntermediate;
  else if (role === "reasoning") system = ROLE_SYSTEM.reasoning;
  else if (role === "coding") system = ROLE_SYSTEM.coding;
  else if (isFinal) system = ROLE_SYSTEM.chatFinal;

  const messages = [{ role: "system", content: system }, ...sanitizedHistory(history, cleanText)];
  const userMessage = { role: "user", content: cleanText };
  if (role === "vision" && imageList.length > 0) userMessage.images = imageList;
  messages.push(userMessage);

  if (Array.isArray(priorStages) && priorStages.length > 0) {
    const blocks = priorStages
      .filter(step => step && step.answer)
      .map(
        step =>
          `--- ${stageRoleLabel(step.role)} (${step.model}) ---\n${String(step.answer).slice(0, maxPriorChars)}`
      )
      .join("\n\n");
    if (blocks) {
      messages.push({
        role: "user",
        content:
          "Results from earlier local steps for this request:\n\n" +
          `${blocks}\n\n` +
          "Use these findings as context. Give the one answer the user needs; do not repeat the notes."
      });
    }
  }
  return messages;
}

export const LOCAL_ROLE_ORDER = ROLE_ORDER;
export const LOCAL_ROUTER_LIMITS = Object.freeze({
  maxTaskPreview: MAX_TASK_PREVIEW,
  maxHistoryMessages: MAX_HISTORY_MESSAGES,
  maxHistoryChars: MAX_HISTORY_CHARS,
  maxPriorChars: MAX_PRIOR_CHARS
});
