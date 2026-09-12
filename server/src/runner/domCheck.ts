import type { JSDOM } from "jsdom";
import type { DomAssertion } from "@teacher/shared";
import { describeAssertion, inlineStylesheets, type DomAssertionOutcome } from "@teacher/shared";

// Canonical dom-check evaluation. jsdom parses HTML + stylesheets but does no
// layout — content authoring rules route visual/layout outcomes to ai-judge.

// jsdom is most of the server's boot time (1.1 s of 1.4 s measured) and only
// HTML/CSS lessons use it. Load it on first use; the bundler turns this into
// a runtime require of the staged package.
let jsdomModule: Promise<typeof import("jsdom")> | null = null;
function loadJsdom(): Promise<typeof import("jsdom")> {
  jsdomModule ??= import("jsdom");
  return jsdomModule;
}

export async function buildDocument(files: Record<string, string>): Promise<{ html: string; dom: JSDOM }> {
  const { JSDOM } = await loadJsdom();
  const entry = Object.keys(files).find((f) => f.endsWith(".html")) ?? "index.html";
  // Inline linked local stylesheets so cssRule assertions can see them (the
  // shared helper keeps this in lock-step with the browser preview).
  const html = inlineStylesheets(files[entry] ?? "", files);
  return { html, dom: new JSDOM(html) };
}

function cssRuleMatches(dom: JSDOM, selector: string, property: string, equals: string): { ok: boolean; found?: string } {
  const doc = dom.window.document;
  // Cascade-correct scan: walk EVERY rule in every style block (recursing into
  // grouping rules like @media) and let the LAST declaration win — exactly
  // what the live preview renders when a learner appends a corrected rule.
  let found: string | undefined;
  const visit = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      const style = (rule as CSSStyleRule).style;
      const selText = (rule as CSSStyleRule).selectorText;
      if (style && selText && selText.split(",").map((s) => s.trim()).includes(selector)) {
        const value = style.getPropertyValue(property).trim();
        if (value) found = value;
      }
      const inner = (rule as { cssRules?: CSSRuleList }).cssRules;
      if (inner) visit(inner);
    }
  };
  for (const styleEl of Array.from(doc.querySelectorAll("style"))) {
    const sheet = (styleEl as { sheet?: CSSStyleSheet }).sheet;
    if (sheet) visit(sheet.cssRules);
  }
  if (found === undefined) return { ok: false };
  // Case-insensitive, trimmed comparison — "DarkBlue" is the same color as
  // "darkblue" (no full color parsing; a hex value is still not a keyword).
  return { ok: found.toLowerCase() === equals.trim().toLowerCase(), found };
}

export async function evaluateDomAssertions(
  files: Record<string, string>,
  assertions: DomAssertion[],
): Promise<{ outcomes: DomAssertionOutcome[]; domSnapshot: string }> {
  const { dom } = await buildDocument(files);
  const doc = dom.window.document;

  const outcomes: DomAssertionOutcome[] = assertions.map((a) => {
    try {
      if ("exists" in a) {
        const ok = doc.querySelector(a.selector) !== null;
        return { assertion: a, passed: ok, detail: ok ? undefined : `nothing matches "${a.selector}"` };
      }
      if ("textContains" in a) {
        const els = Array.from(doc.querySelectorAll(a.selector));
        const ok = els.some((el) => (el.textContent ?? "").includes(a.textContains));
        return {
          assertion: a,
          passed: ok,
          detail: ok ? undefined : `no "${a.selector}" contains the text "${a.textContains}"`,
        };
      }
      if ("count" in a) {
        const n = doc.querySelectorAll(a.selector).length;
        return {
          assertion: a,
          passed: n === a.count,
          detail: n === a.count ? undefined : `expected ${a.count} × "${a.selector}", found ${n}`,
        };
      }
      if ("attr" in a) {
        const els = Array.from(doc.querySelectorAll(a.selector));
        const ok = els.some((el) => el.getAttribute(a.attr) === a.equals);
        return {
          assertion: a,
          passed: ok,
          detail: ok ? undefined : `no "${a.selector}" has ${a.attr}="${a.equals}"`,
        };
      }
      const res = cssRuleMatches(dom, a.selector, a.cssRule.property, a.cssRule.equals);
      return {
        assertion: a,
        passed: res.ok,
        detail: res.ok
          ? undefined
          : res.found
            ? `"${a.selector}" has ${a.cssRule.property}: ${res.found}, expected ${a.cssRule.equals}`
            : `no CSS rule sets ${a.cssRule.property} on "${a.selector}"`,
      };
    } catch (err) {
      return { assertion: a, passed: false, detail: `invalid assertion (${describeAssertion(a)}): ${String(err)}` };
    }
  });

  return { outcomes, domSnapshot: doc.documentElement.outerHTML };
}
