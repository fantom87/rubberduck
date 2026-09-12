import { describe, expect, it } from "vitest";
import type { DomAssertion } from "@teacher/shared";
import { buildDocument, evaluateDomAssertions } from "./domCheck.js";

const colorRule = (equals: string): DomAssertion => ({ selector: "h1", cssRule: { property: "color", equals } });

function page(css: string): Record<string, string> {
  return {
    "index.html": '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><h1>Hi</h1></body></html>',
    "styles.css": css,
  };
}

describe("cssRuleMatches (cascade-correct)", () => {
  it("the LAST matching declaration wins — appending a corrected rule passes", async () => {
    const { outcomes } = await evaluateDomAssertions(page("h1 { color: red; }\nh1 { color: darkblue; }"), [colorRule("darkblue")]);
    expect(outcomes[0].passed).toBe(true);
  });

  it("still fails (with the winning value) when the last rule is wrong", async () => {
    const { outcomes } = await evaluateDomAssertions(page("h1 { color: darkblue; }\nh1 { color: red; }"), [colorRule("darkblue")]);
    expect(outcomes[0].passed).toBe(false);
    expect(outcomes[0].detail).toContain("red");
  });

  it("a later <style> block overrides an earlier one", async () => {
    const files = {
      "index.html": "<style>h1 { color: red; }</style><style>h1 { color: darkblue; }</style><h1>Hi</h1>",
    };
    const { outcomes } = await evaluateDomAssertions(files, [colorRule("darkblue")]);
    expect(outcomes[0].passed).toBe(true);
  });

  it("finds rules nested inside @media blocks", async () => {
    const { outcomes } = await evaluateDomAssertions(page("@media (min-width: 100px) { h1 { color: darkblue; } }"), [
      colorRule("darkblue"),
    ]);
    expect(outcomes[0].passed).toBe(true);
  });

  it("compares values case-insensitively and trimmed", async () => {
    const { outcomes } = await evaluateDomAssertions(page("h1 { color: DarkBlue; }"), [colorRule(" darkblue ")]);
    expect(outcomes[0].passed).toBe(true);
  });

  it("reports no-rule when nothing sets the property", async () => {
    const { outcomes } = await evaluateDomAssertions(page("h1 { font-size: 2rem; }"), [colorRule("darkblue")]);
    expect(outcomes[0].passed).toBe(false);
    expect(outcomes[0].detail).toContain("no CSS rule");
  });
});

describe("buildDocument stylesheet inlining", () => {
  it.each(['href="./styles.css"', "href='styles.css'", "href=styles.css"])("inlines <link %s>", async (attr) => {
    const files = {
      "index.html": `<head><link rel="stylesheet" ${attr}></head><body><h1>Hi</h1></body>`,
      "styles.css": "h1 { color: darkblue; }",
    };
    const { html } = await buildDocument(files);
    expect(html).toContain("<style>");
    const { outcomes } = await evaluateDomAssertions(files, [colorRule("darkblue")]);
    expect(outcomes[0].passed).toBe(true);
  });
});
