import path from "node:path";
import { Router } from "express";
import { readJson, writeJson } from "../store/jsonStore.js";
import { parseFiles } from "./files.js";

// Auto-saved editor contents per lesson (and playground scratchpads).
// Draft ids are lesson keys ("python/01-first-steps/01-hello-world") or
// "playground-<language>"; slashes become "__" on disk.

// Ids come in off the wire — checked BEFORE the "/" → "__" substitution so
// dots, colons, and backslashes can never become a path escape.
const ID_RE = /^[a-z0-9][a-z0-9/_-]*$/i;

function draftFile(dataDir: string, id: string): string {
  return path.join(dataDir, "drafts", `${id.replaceAll("/", "__")}.json`);
}

export function draftRoutes(dataDir: string): Router {
  const r = Router();

  r.get("/api/drafts", async (req, res) => {
    const id = String(req.query.id ?? "");
    if (!ID_RE.test(id)) {
      res.status(400).json({ error: "valid id required" });
      return;
    }
    const draft = await readJson<{ files: Record<string, string> } | null>(draftFile(dataDir, id), null);
    res.json(draft ?? { files: null });
  });

  r.put("/api/drafts", async (req, res) => {
    const id = String(req.query.id ?? "");
    const files = parseFiles(req.body?.files);
    if (!ID_RE.test(id) || !files) {
      res.status(400).json({ error: "valid id and files (path -> string) required" });
      return;
    }
    await writeJson(draftFile(dataDir, id), { files, savedAt: new Date().toISOString() });
    res.status(204).end();
  });

  return r;
}
