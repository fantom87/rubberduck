// Content lint: validates the whole curriculum, the docs-content indexes, and
// dom-check falsifiability, then proves every lesson's own solution passes its
// non-AI checks — through the same check pass that grades the learner.
//
//   npm run lint-content              what changed since the last green run
//   npm run lint-content -- --all     ignore the cache, run everything
//   npm run lint-content -- --strict  a missing runtime fails instead of skipping (CI)
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCurriculum } from "../server/src/curriculum/loader.js";
import { runCheckPass } from "../server/src/checks/run.js";
import { detectRuntimes } from "../server/src/preflight.js";
import { missingRuntimeHint } from "../server/src/runtimeHints.js";
import type { CheckResult, Lesson } from "../shared/src/index.js";

const args = new Set(process.argv.slice(2));
const FORCE_ALL = args.has("--all");
const STRICT = args.has("--strict");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CONTENT = path.join(ROOT, "content");
const DOCS = path.join(ROOT, "docs-content");
const DATA = path.join(ROOT, "data");
const CACHE_FILE = path.join(DATA, "lint-cache.json");

// jsdom does no layout — a dom check asserting one of these properties can
// "pass" while the page looks broken (or vice versa). Route those to ai-judge.
const LAYOUT_PROPS = new Set(["display", "position", "float", "top", "left", "right", "bottom"]);

/**
 * The gate is the grader. This used to be a second implementation of the
 * check pass, and the two had already drifted (a missing test file was an
 * explicit failure in one and an empty string in the other). Going through
 * runCheckPass also gets its run cache: a lesson with seven stdout checks on
 * one entry builds once, not seven times — which for C# was most of the run.
 * ai-judge is left out; it is graded live and would spend tutor tokens here.
 */
async function checkLesson(lesson: Lesson, files: Record<string, string>): Promise<CheckResult[]> {
  const deterministic = lesson.checks.filter((c) => c.type !== "ai-judge");
  if (deterministic.length === 0) return [];
  const pass = await runCheckPass(DATA, { ...lesson, checks: deterministic }, files, lesson.testFiles);
  return pass.checks;
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

// ---------- the cache ----------
// A lesson that passed is skipped next time unless something its verdict
// depends on changed: its own content, the engine that grades it, or the
// runtimes that run it. An author iterating on one lesson waits for one lesson.

interface LintCache {
  engine: string;
  passed: Record<string, string>; // lesson key -> content hash at last pass
}

const sha1 = (s: string): string => crypto.createHash("sha1").update(s).digest("hex");

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(full)));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** Everything between a solution and its verdict, hashed. */
async function engineFingerprint(runtimes: unknown): Promise<string> {
  const dirs = ["shared/src", "server/src/runner", "server/src/checks", "server/src/curriculum"].map((d) =>
    path.join(ROOT, d),
  );
  const files = (await Promise.all(dirs.map(filesUnder))).flat().concat(fileURLToPath(import.meta.url)).sort();
  const h = crypto.createHash("sha1");
  for (const f of files) h.update(path.relative(ROOT, f)).update("\0").update(await fs.readFile(f)).update("\0");
  h.update(JSON.stringify(runtimes));
  return h.digest("hex");
}

/** Everything the verdict for one lesson depends on, hashed. Stage starters
 *  are cumulative, so an edit to an earlier stage changes later hashes too. */
function lessonFingerprint(lesson: Lesson, solution: Record<string, string>): string {
  const { language, runner, entry, timeoutMs, checks, starterFiles, testFiles } = lesson;
  return sha1(JSON.stringify({ language, runner, entry, timeoutMs, checks, starterFiles, testFiles, solution }));
}

async function readCache(engine: string): Promise<Record<string, string>> {
  if (FORCE_ALL) return {};
  try {
    const parsed = JSON.parse(await fs.readFile(CACHE_FILE, "utf8")) as Partial<LintCache>;
    return parsed.engine === engine && parsed.passed ? parsed.passed : {};
  } catch {
    return {};
  }
}

async function writeCache(cache: LintCache): Promise<void> {
  await fs.mkdir(DATA, { recursive: true });
  await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
}

// ---------- a small pool ----------

async function mapPool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

// ---------- main ----------

const startedAt = Date.now();
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

const runtimes = await detectRuntimes(true);
const engine = await engineFingerprint(runtimes);
const passed = await readCache(engine);

interface Job {
  key: string;
  lesson: Lesson;
  solution: Record<string, string>;
  hash: string;
}

// Lessons whose runtime this machine doesn't have get structural checks only,
// unless --strict. Which runtimes are missing differs by OS (no pwsh on a bare
// Ubuntu box, no dotnet on a fresh Windows one), so the skip is preflight's.
const runtimeless = new Map<string, string>();
const jobs: Job[] = [];
let cached = 0;
for (const [key, lesson] of cur.lessons) {
  const solution = cur.solutions.get(key);
  if (!solution) {
    console.error(`✗ ${key}: no solution/ folder`);
    failures++;
    continue;
  }
  const missing = missingRuntimeHint(lesson.language, runtimes);
  if (missing) {
    if (STRICT) {
      console.error(`✗ ${key}: runtime missing — ${missing}`);
      failures++;
    } else {
      runtimeless.set(key, missing);
    }
    continue;
  }
  const hash = lessonFingerprint(lesson, solution);
  if (passed[key] === hash) {
    cached++;
    continue;
  }
  delete passed[key];
  jobs.push({ key, lesson, solution, hash });
}

async function runJob({ key, lesson, solution, hash }: Job): Promise<void> {
  // Solutions may cover only some files (e.g. just styles.css) — starters fill the rest.
  const results = await checkLesson(lesson, { ...lesson.starterFiles, ...solution });
  const bad = results.filter((r) => !r.passed);
  if (bad.length > 0) {
    failures += bad.length;
    console.error(`✗ ${key}:`);
    for (const b of bad) console.error(`    [${b.checkId}] ${b.message}${b.actual ? ` — actual: ${JSON.stringify(b.actual).slice(0, 120)}` : ""}`);
    return;
  }
  if (lesson.stage) {
    // A stage has to ask for real work: run its checks on the workspace as it
    // stands BEFORE its solution is layered on. If they all pass there, the
    // previous stage already satisfied it and a learner would "complete" it by
    // pressing Check. At least one must fail, not all — a stage may re-assert
    // an earlier invariant as a regression guard.
    const before = await checkLesson(lesson, lesson.starterFiles);
    if (before.length > 0 && before.every((r) => r.passed)) {
      failures++;
      console.error(`✗ ${key}: every check already passes before this stage's solution — the stage asks for nothing`);
      return;
    }
  }
  console.log(`✓ ${key} (${results.length} checks)`);
  passed[key] = hash;
}

// sql and html-css are graded in-process and cost milliseconds; everything
// else spawns an interpreter or a compiler. Both groups run wide, the spawning
// one bounded by the machine. C# and Rust are safe to run in parallel across
// lessons: each lesson key owns its own persistent workspace.
const inProcess = jobs.filter((j) => j.lesson.language === "sql" || j.lesson.language === "html-css");
const spawning = jobs.filter((j) => !inProcess.includes(j));
await Promise.all([mapPool(inProcess, 8, runJob), mapPool(spawning, Math.min(4, os.availableParallelism()), runJob)]);

await writeCache({ engine, passed });

if (runtimeless.size > 0) {
  console.log(`… skipped runtime checks for ${runtimeless.size} lesson(s) — a runtime is missing on this machine:`);
  for (const hint of new Set(runtimeless.values())) console.log(`    ${hint}`);
}

const stageCount = [...cur.lessons.values()].filter((l) => l.stage).length;
const shape =
  cur.projects.size > 0
    ? `${cur.lessons.size - stageCount} lessons, ${cur.projects.size} project(s) across ${stageCount} stages`
    : `${cur.lessons.size} lessons`;
const seconds = ((Date.now() - startedAt) / 1000).toFixed(0);
console.log(
  failures === 0
    ? `\nAll content checks passed (${shape}; ${jobs.length} run, ${cached} unchanged since last pass; ${seconds}s).`
    : `\n${failures} failure(s) (${jobs.length} run, ${cached} cached; ${seconds}s).`,
);
process.exit(failures === 0 ? 0 : 1);
