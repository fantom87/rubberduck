import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import {
  lessonFrontmatterSchema,
  projectFrontmatterSchema,
  stageFrontmatterSchema,
  trackSchema,
  tracksIndexSchema,
  type Lesson,
  type Project,
  type ProjectStage,
  type Track,
} from "@teacher/shared";

export interface ContentError {
  file: string;
  message: string;
}

export interface Curriculum {
  tracks: Track[];
  /**
   * key = "trackId/unitId/lessonId", and "trackId/unitId/projectId/stageId"
   * for a project's stages. Stages live in this same map on purpose: every
   * consumer below the loader — the runners, the check pass, the tutor, the
   * content lint, the snapshot key guard — takes a Lesson by value and needs
   * no idea that projects exist.
   */
  lessons: Map<string, Lesson>;
  /** key = "trackId/unitId/projectId" */
  projects: Map<string, Project>;
  /** solution files per lesson OR stage key (tutor-only — never sent to the frontend) */
  solutions: Map<string, Record<string, string>>;
  errors: ContentError[];
  /** every manifest read during the load — what the cache stats to detect edits */
  manifestFiles: string[];
}

export function lessonKey(trackId: string, unitId: string, lessonId: string): string {
  return `${trackId}/${unitId}/${lessonId}`;
}

export function projectKey(trackId: string, unitId: string, projectId: string): string {
  return `${trackId}/${unitId}/${projectId}`;
}

export function stageKey(trackId: string, unitId: string, projectId: string, stageId: string): string {
  return `${trackId}/${unitId}/${projectId}/${stageId}`;
}

export async function readDirFiles(dir: string, prefix = ""): Promise<Record<string, string>> {
  // Recursive: a solution dir may nest files (e.g. an html project's css/).
  const out: Record<string, string> = {};
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const key = `${prefix}${entry.name}`;
    if (entry.isDirectory()) Object.assign(out, await readDirFiles(full, `${key}/`));
    else if (entry.isFile()) out[key] = await fs.readFile(full, "utf8");
  }
  return out;
}

function zodIssues(file: string, error: { issues: { path: PropertyKey[]; message: string }[] }): ContentError[] {
  return error.issues.map((i) => ({
    file,
    message: `${i.path.join(".") || "(root)"}: ${i.message}`,
  }));
}

export async function loadCurriculum(contentDir: string): Promise<Curriculum> {
  const errors: ContentError[] = [];
  const tracks: Track[] = [];
  const lessons = new Map<string, Lesson>();
  const projects = new Map<string, Project>();
  const solutions = new Map<string, Record<string, string>>();
  const manifestFiles: string[] = [];

  const indexFile = path.join(contentDir, "tracks.json");
  manifestFiles.push(indexFile);
  let order: string[] = [];
  try {
    const parsed = tracksIndexSchema.safeParse(JSON.parse(await fs.readFile(indexFile, "utf8")));
    if (parsed.success) order = parsed.data.order;
    else errors.push(...zodIssues(indexFile, parsed.error));
  } catch (err) {
    errors.push({ file: indexFile, message: String(err) });
    return { tracks, lessons, projects, solutions, errors, manifestFiles };
  }

  for (const trackId of order) {
    const trackFile = path.join(contentDir, "tracks", trackId, "track.json");
    manifestFiles.push(trackFile);
    let track: Track;
    try {
      const parsed = trackSchema.safeParse(JSON.parse(await fs.readFile(trackFile, "utf8")));
      if (!parsed.success) {
        errors.push(...zodIssues(trackFile, parsed.error));
        continue;
      }
      track = parsed.data;
    } catch (err) {
      errors.push({ file: trackFile, message: String(err) });
      continue;
    }
    if (track.id !== trackId) {
      // Lessons are keyed by FOLDER id; a mismatched track would render with
      // every lesson 404ing. Drop it — the error says exactly what to fix.
      errors.push({
        file: trackFile,
        message: `track id "${track.id}" doesn't match folder "${trackId}" — track skipped`,
      });
      continue;
    }
    tracks.push(track);

    for (const unit of track.units) {
      for (const lessonId of unit.lessons) {
        const lessonDir = path.join(contentDir, "tracks", trackId, "units", unit.id, lessonId);
        const lessonFile = path.join(lessonDir, "lesson.md");
        manifestFiles.push(lessonFile);
        let raw: string;
        try {
          raw = await fs.readFile(lessonFile, "utf8");
        } catch {
          errors.push({
            file: trackFile,
            message: `lesson "${lessonId}" listed in unit "${unit.id}" but ${lessonFile} is missing`,
          });
          continue;
        }
        const { data, content: body } = matter(raw);
        const parsed = lessonFrontmatterSchema.safeParse(data);
        if (!parsed.success) {
          errors.push(...zodIssues(lessonFile, parsed.error));
          continue;
        }
        const meta = parsed.data;
        if (meta.id !== lessonId) {
          errors.push({ file: lessonFile, message: `lesson id "${meta.id}" doesn't match folder "${lessonId}"` });
        }

        const starterFiles: Record<string, string> = {};
        for (const f of meta.files) {
          const starterPath = path.join(lessonDir, f.starter);
          try {
            starterFiles[f.path] = await fs.readFile(starterPath, "utf8");
          } catch {
            errors.push({ file: lessonFile, message: `starter file "${f.starter}" not found` });
          }
        }

        // Check assets must exist (and are loaded for both runners).
        const testFiles: Record<string, string> = {};
        for (const check of meta.checks) {
          if (check.type === "tests") {
            try {
              testFiles[check.testFile] = await fs.readFile(path.join(lessonDir, check.testFile), "utf8");
            } catch {
              errors.push({ file: lessonFile, message: `check "${check.id}": test file "${check.testFile}" not found` });
            }
          }
        }

        const key = lessonKey(trackId, unit.id, lessonId);
        lessons.set(key, {
          ...meta,
          trackId,
          unitId: unit.id,
          body: body.trim(),
          starterFiles,
          testFiles,
          entry: meta.files[0].path,
        });
        const sol = await readDirFiles(path.join(lessonDir, "solution"));
        if (Object.keys(sol).length > 0) solutions.set(key, sol);
      }

      for (const projectId of unit.projects) {
        const projectDir = path.join(contentDir, "tracks", trackId, "units", unit.id, "projects", projectId);
        const projectFile = path.join(projectDir, "project.md");
        manifestFiles.push(projectFile);
        let projectRaw: string;
        try {
          projectRaw = await fs.readFile(projectFile, "utf8");
        } catch {
          errors.push({
            file: trackFile,
            message: `project "${projectId}" listed in unit "${unit.id}" but ${projectFile} is missing`,
          });
          continue;
        }
        const { data: projectData, content: projectBody } = matter(projectRaw);
        const projectParsed = projectFrontmatterSchema.safeParse(projectData);
        if (!projectParsed.success) {
          errors.push(...zodIssues(projectFile, projectParsed.error));
          continue;
        }
        const pMeta = projectParsed.data;
        if (pMeta.id !== projectId) {
          errors.push({ file: projectFile, message: `project id "${pMeta.id}" doesn't match folder "${projectId}"` });
        }

        const workspaceFiles = await readDirFiles(path.join(projectDir, pMeta.workspace));
        if (Object.keys(workspaceFiles).length === 0) {
          errors.push({ file: projectFile, message: `workspace folder "${pMeta.workspace}/" is empty or missing` });
          continue;
        }
        if (!(pMeta.entry in workspaceFiles)) {
          errors.push({
            file: projectFile,
            message: `entry "${pMeta.entry}" is not one of the workspace files (${Object.keys(workspaceFiles).join(", ")})`,
          });
        }

        // Each stage is projected into a Lesson whose starterFiles are the
        // workspace as it stands when that stage BEGINS: the seed plus every
        // earlier stage's solution delta, layered in order. That one decision
        // is what lets the existing check pass and the content lint grade a
        // stage without either of them knowing what a project is.
        const stageList: ProjectStage[] = [];
        let cumulative: Record<string, string> = { ...workspaceFiles };
        const pKey = projectKey(trackId, unit.id, projectId);

        for (const [index, stageId] of pMeta.stages.entries()) {
          const stageDir = path.join(projectDir, "stages", stageId);
          const stageFile = path.join(stageDir, "stage.md");
          manifestFiles.push(stageFile);
          let stageRaw: string;
          try {
            stageRaw = await fs.readFile(stageFile, "utf8");
          } catch {
            errors.push({
              file: projectFile,
              message: `stage "${stageId}" listed in project "${projectId}" but ${stageFile} is missing`,
            });
            continue;
          }
          const { data: stageData, content: stageBody } = matter(stageRaw);
          const stageParsed = stageFrontmatterSchema.safeParse(stageData);
          if (!stageParsed.success) {
            errors.push(...zodIssues(stageFile, stageParsed.error));
            continue;
          }
          const stage = stageParsed.data;
          if (stage.id !== stageId) {
            errors.push({ file: stageFile, message: `stage id "${stage.id}" doesn't match folder "${stageId}"` });
          }

          const stageTests: Record<string, string> = {};
          for (const check of stage.checks) {
            if (check.type === "tests") {
              try {
                stageTests[check.testFile] = await fs.readFile(path.join(stageDir, check.testFile), "utf8");
              } catch {
                errors.push({ file: stageFile, message: `check "${check.id}": test file "${check.testFile}" not found` });
              }
            }
          }

          const sKey = stageKey(trackId, unit.id, projectId, stageId);
          lessons.set(sKey, {
            ...stage,
            language: pMeta.language,
            runner: pMeta.runner,
            // The editor's tab list. `starter` is unused for a stage because
            // starterFiles is computed cumulatively rather than read per file.
            files: Object.keys(cumulative).map((p) => ({ path: p, starter: p })),
            trackId,
            unitId: unit.id,
            body: stageBody.trim(),
            starterFiles: cumulative,
            testFiles: stageTests,
            entry: pMeta.entry,
            stage: {
              projectKey: pKey,
              projectTitle: pMeta.title,
              stageIndex: index,
              stageCount: pMeta.stages.length,
            },
          });

          // Stage solutions are deltas — only the files that stage touches.
          const delta = await readDirFiles(path.join(stageDir, "solution"));
          if (Object.keys(delta).length > 0) solutions.set(sKey, delta);
          stageList.push(stage);
          cumulative = { ...cumulative, ...delta };
        }

        projects.set(pKey, {
          ...pMeta,
          trackId,
          unitId: unit.id,
          body: projectBody.trim(),
          workspaceFiles,
          stageList,
        });
      }
    }
  }

  return { tracks, lessons, projects, solutions, errors, manifestFiles };
}

// ---------- cached singleton ----------
// The cache invalidates itself when any manifest or lesson body on disk is
// newer than the last load, so content authors see edits without restarting.
// The mtime walk is memoized for 2s so request bursts don't re-stat the tree.

let cache: Curriculum | null = null;
let cacheLoadedAt = 0;
let cachedContentDir: string | null = null;
let lastWalk = { at: 0, newest: 0 };
let inflightLoad: Promise<Curriculum> | null = null;
let inflightWalk: Promise<number> | null = null;

const CONTENT_FILES = new Set(["tracks.json", "track.json", "lesson.md", "project.md", "stage.md"]);

/** Full recursive walk — the fallback when the known-manifest set can't be trusted. */
async function walkNewest(dir: string): Promise<number> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0; // missing dir — nothing to count
  }
  const results = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walkNewest(full);
      if (!CONTENT_FILES.has(entry.name)) return 0;
      return fs.stat(full).then((s) => s.mtimeMs, () => 0); // vanished mid-walk — ignore
    }),
  );
  return Math.max(0, ...results);
}

/**
 * Newest mtime among the files that define the curriculum.
 *
 * After a load the manifest paths are known, so this is one concurrent stat
 * per file — about 10 ms for 367 files — where it used to readdir all 1,258
 * directories under content/ (~250 ms), a cost every request after two idle
 * seconds paid. The set has the same coverage as the walk: a new lesson only
 * becomes visible through track.json, which is in it. A manifest that has
 * vanished means the shape changed, and that falls back to the full walk.
 */
async function newestContentMtime(contentDir: string): Promise<number> {
  const now = Date.now();
  if (now - lastWalk.at < 2000) return lastWalk.newest;
  if (inflightWalk) return inflightWalk;
  inflightWalk = (async () => {
    const known = cache?.manifestFiles ?? [];
    let newest: number;
    if (known.length > 0) {
      const stats = await Promise.all(known.map((f) => fs.stat(f).then((s) => s.mtimeMs, () => null)));
      newest = stats.includes(null) ? await walkNewest(contentDir) : Math.max(0, ...(stats as number[]));
    } else {
      newest = await walkNewest(contentDir);
    }
    lastWalk = { at: Date.now(), newest };
    return newest;
  })();
  try {
    return await inflightWalk;
  } finally {
    inflightWalk = null;
  }
}

export async function getCurriculum(contentDir: string): Promise<Curriculum> {
  if (cache && (await newestContentMtime(contentDir)) <= cacheLoadedAt) return cache;
  return reloadCurriculum(contentDir);
}

/**
 * Concurrent callers share one load. Before this, two boot-time requests for
 * /api/curriculum each ran a full load (357 lesson reads apiece), because the
 * cache stayed null until the first one finished.
 */
export function reloadCurriculum(contentDir: string): Promise<Curriculum> {
  if (inflightLoad) return inflightLoad;
  cachedContentDir = contentDir;
  // Stamped at the START of the load: an edit made while loading must trigger
  // a reload next time, not be mistaken for something this load already saw.
  const startedAt = Date.now();
  inflightLoad = loadCurriculum(contentDir)
    .then((loaded) => {
      cache = loaded;
      cacheLoadedAt = startedAt;
      return loaded;
    })
    .finally(() => {
      inflightLoad = null;
    });
  return inflightLoad;
}

/** Whether a key names a real authored lesson. Used by stores that receive
 *  lesson keys off the wire (e.g. snapshots) without knowing the content dir.
 *  Before the first curriculum load it answers false — validate-only callers
 *  fail closed. */
export async function isKnownLessonKey(key: string): Promise<boolean> {
  if (!cachedContentDir) return false;
  const cur = await getCurriculum(cachedContentDir);
  return cur.lessons.has(key);
}
