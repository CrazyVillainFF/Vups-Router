/* ── stylelint rule: every shadow is a hard offset ─────────────────────────────
   The design system allows `0 2px 0 colour` and forbids a blur length, but
   stylelint has no built-in value rule that can tell the two apart, because
   box-shadow's third length is optional. The parser for that distinction already
   exists in qa/color-rules.mjs and is what produced the before/after census, so
   this rule calls it rather than restating it — a linter that disagrees with the
   audit is a linter that gets switched off. */
import stylelint from "stylelint";
import { blurLengthsOf, splitTopLevel } from "./color-rules.mjs";

const {
  createPlugin,
  utils: { report, ruleMessages, validateOptions }
} = stylelint;

const ruleName = "vupsrouter/hard-offset-shadow";

const messages = ruleMessages(ruleName, {
  rejected: (property, layer) =>
    `"${property}" layer "${layer}" has a blur length. Shadows are hard offsets: 0 blur.`
});

const SHADOW_PROPERTY = /^(?:-webkit-)?(?:box|text)-shadow$/i;

/* eslint-disable-next-line no-shadow-restricted-names */
const ruleFunction = primary => (root, result) => {
  const valid = validateOptions(result, ruleName, {
    actual: primary,
    possible: [true]
  });
  if (!valid || primary !== true) return;

  root.walkDecls(decl => {
    if (!SHADOW_PROPERTY.test(decl.prop)) return;
    for (const layer of splitTopLevel(decl.value)) {
      if (blurLengthsOf(layer) > 0) {
        report({
          result,
          ruleName,
          node: decl,
          message: messages.rejected(decl.prop, layer),
          word: decl.value
        });
        return;
      }
    }
  });
};

ruleFunction.ruleName = ruleName;
ruleFunction.messages = messages;

export default createPlugin(ruleName, ruleFunction);
