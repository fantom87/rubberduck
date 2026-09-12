// Content lint: validates the whole curriculum, the docs-content indexes, and
// dom-check falsifiability, then proves every lesson's own solution passes its
// non-AI checks. Run with: npm run lint-content
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCurriculum } from "../server/src/curriculum/loader.js";
import { runLocal } from "../server/src/runner/localRunner.js";
import { evaluateDomAssertions } from "../server/src/runner/domCheck.js";
import { detectRuntimes } from "../server/src/preflight.js";
import { missingRuntimeHint } from "../server/src/runtimeHints.js";
import {
  buildJsTestProgram,
  buildPyTestProgram,
  evaluateDomCheck,
  evaluateStdoutCheck,
  evaluateTestsCheck,
  type CheckResult,
  type Lesson,
} from "../shared/src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CONTENT = path.join(ROOT, "content");
const DOCS = path.join(ROOT, "docs-content");
const DATA = path.join(ROOT, "data");

// jsdom does no layout — a dom check asserting one of these properties can
// "pass" while the page looks broken (or vice versa). Route those to ai-judge.
const LAYOUT_PROPS = new Set(["display", "position", "float", "top", "left", "right", "bottom"]);

async function checkLesson(key: string, lesson: Lesson, solution: Record<string, string>): Promise<CheckResult[]> {
  // Solutions may cover only some files (e.g. just styles.css) — starters fill the rest.
  const files = { ...lesson.starterFiles, ...solution };
  const results: CheckResult[] = [];

  for (const spec of lesson.checks) {
    if (spec.type === "ai-judge") continue; // costs tutor tokens; judged live instead
    if (spec.type === "dom") {
      const { outcomes } = await evaluateDomAssertions(files, spec.assertions);
      results.push(evaluateDomCheck(spec, outcomes));
    } else if (spec.type === "stdout") {
      const run = await runLocal(DATA, {
        language: lesson.language,
        entry: spec.entry,
        files,
        stdin: spec.stdin,
        timeoutMs: lesson.timeoutMs,
        lessonKey: key,
      });
      results.push(evaluateStdoutCheck(spec, run));
    } else if (spec.type === "tests") {
      const source = lesson.testFiles[spec.testFile] ?? "";
      const userCode = files[spec.entry] ?? "";
      const nonce = crypto.randomBytes(8).toString("hex");
      const combined =
        lesson.language === "python"
          ? buildPyTestProgram(userCode, source, nonce)
          : buildJsTestProgram(userCode, source, nonce);
      const entry = lesson.language === "python" ? "__tests__.py" : "__tests__.js";
      const run = await runLocal(DATA, {
        language: lesson.language,
        entry,
        files: { ...files, [entry]: combined },
        timeoutMs: lesson.timeoutMs,
        lessonKey: key,
        nonce,
      });
      results.push(evaluateTestsCheck(spec, run));
    }
  }
  return results;
}

/** Docs indexes: every slug must resolve to a file, every file to a slug. */
async function lintDocs(): Promise<number> {
  let bad = 0;
  let sections: string[];
  try {
    sections = (await fs.readdir(DOCS, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    console.error(`✗ docs-content/ missing at ${DOCS}`);
    return 1;
  }
  for (const section of sections) {
    const dir = path.join(DOCS, section);
    const indexFile = path.join(dir, "index.json");
    let pages: { slug?: unknown }[];
    try {
      const parsed = JSON.parse(await fs.readFile(indexFile, "utf8")) as { pages?: { slug?: unknown }[] };
      if (!Array.isArray(parsed.pages)) throw new Error("no pages array");
      pages = parsed.pages;
    } catch (err) {
      console.error(`✗ docs-content/${section}/index.json: ${String(err)}`);
      bad++;
      continue;
    }
    const mdFiles = (await fs.readdir(dir)).filter((f) => f.endsWith(".md"));
    const slugs = new Set<string>();
    for (const page of pages) {
      if (typeof page.slug !== "string" || !/^[a-z0-9-]+$/.test(page.slug)) {
        console.error(`✗ docs-content/${section}: bad slug ${JSON.stringify(page.slug)}`);
        bad++;
        continue;
      }
      slugs.add(page.slug);
      if (!mdFiles.includes(`${page.slug}.md`)) {
        console.error(`✗ docs-content/${section}: index lists "${page.slug}" but ${page.slug}.md is missing`);
        bad++;
      }
    }
    for (const md of mdFiles) {
      if (!slugs.has(md.replace(/\.md$/, ""))) {
        console.error(`✗ docs-content/${section}/${md} exists but is not in index.json (invisible in the app)`);
        bad++;
      }
    }
  }
  return bad;
}

const cur = await loadCurriculum(CONTENT);
let failures = 0;

if (cur.errors.length > 0) {
  console.error(`✗ ${cur.errors.length} validation error(s):`);
  for (const e of cur.errors) console.error(`  ${e.file}: ${e.message}`);
  failures += cur.errors.length;
}

failures += await lintDocs();

// Warn (don't fail) on layout-affecting cssRule assertions.
for (const [key, lesson] of cur.lessons) {
  for (const spec of lesson.checks) {
    if (spec.type !== "dom") continue;
    for (const a of spec.assertions) {
      if ("cssRule" in a && LAYOUT_PROPS.has(a.cssRule.property)) {
        console.warn(`⚠ ${key}: dom check asserts layout property "${a.cssRule.property}" — jsdom can't verify layout; prefer ai-judge`);
      }
    }
  }
}

/**
 * A stage has to ask for real work. Its checks are run against the workspace as
 * it stands BEFORE the stage's own solution is layered on — if they all pass
 * there, the stage is a no-op that the previous stage already satisfied, and a
 * learner would "complete" it by pressing Check.
 *
 * At least one deterministic check must fail, not all of them: a stage may
 * legitimately re-assert an earlier invariant as a regression guard, and those
 * checks are supposed to keep passing.
 */
async function stageDemandsWork(key: string, stage: Lesson): Promise<boolean> {
  const before = await checkLesson(key, stage, {});
  return before.length === 0 || before.some((r) => !r.passed);
}

const runtimes = await detectRuntimes();
// Lessons whose runtime this machine doesn't have get structural checks only.
// Which runtimes are missing differs by OS (no pwsh on a bare Ubuntu box, no
// dotnet on a fresh Windows one), so the skip is driven by preflight.
const runtimeless = new Map<string, string>();
for (const [key, lesson] of cur.lessons) {
  const solution = cur.solutions.get(key);
  if (!solution) {
    console.error(`✗ ${key}: no solution/ folder`);
    failures++;
    continue;
  }
  const missing = missingRuntimeHint(lesson.language, runtimes);
  if (missing) {
    runtimeless.set(key, missing);
    continue;
  }
  const results = await checkLesson(key, lesson, solution);
  const bad = results.filter((r) => !r.passed);
  if (bad.length > 0) {
    failures += bad.length;
    console.error(`✗ ${key}:`);
    for (const b of bad) console.error(`    [${b.checkId}] ${b.message}${b.actual ? ` — actual: ${JSON.stringify(b.actual).slice(0, 120)}` : ""}`);
    continue;
  }
  // Stages get the extra gate: proven solvable AND proven to be worth doing.
  if (lesson.stage && !(await stageDemandsWork(key, lesson))) {
    failures++;
    console.error(`✗ ${key}: every check already passes before this stage's solution — the stage asks for nothing`);
    continue;
  }
  console.log(`✓ ${key} (${results.length} checks)`);
}

if (runtimeless.size > 0) {
  console.log(`… skipped runtime checks for ${runtimeless.size} lesson(s) — a runtime is missing on this machine:`);
  for (const hint of new Set(runtimeless.values())) console.log(`    ${hint}`);
}

const stageCount = [...cur.lessons.values()].filter((l) => l.stage).length;
const summary =
  cur.projects.size > 0
    ? `${cur.lessons.size - stageCount} lessons, ${cur.projects.size} project(s) across ${stageCount} stages`
    : `${cur.lessons.size} lessons`;
console.log(failures === 0 ? `\nAll content checks passed (${summary}).` : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
