import path from "node:path";
import { Router } from "express";
import { DEFAULT_SETTINGS, settingsSchema, type Settings } from "@teacher/shared";
import { readJson, writeJson } from "../store/jsonStore.js";

// A hand-edited settings.json must never crash the frontend: keep every key
// that still validates, fill the rest from defaults (deep for editor.*).
function repairSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const shape = settingsSchema.shape;
  const editorRaw = (r.editor && typeof r.editor === "object" ? r.editor : {}) as Record<string, unknown>;
  const pick = <T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } }, value: unknown, fallback: T): T => {
    const parsed = schema.safeParse(value);
    return parsed.success ? (parsed.data as T) : fallback;
  };
  const settings: Settings = {
    theme: pick(shape.theme, r.theme, DEFAULT_SETTINGS.theme),
    assistanceDefault: pick(shape.assistanceDefault, r.assistanceDefault, DEFAULT_SETTINGS.assistanceDefault) as Settings["assistanceDefault"],
    tutorModel: pick(shape.tutorModel, r.tutorModel, DEFAULT_SETTINGS.tutorModel),
    editor: {
      fontSize: pick(shape.editor.shape.fontSize, editorRaw.fontSize, DEFAULT_SETTINGS.editor.fontSize),
      autocomplete: pick(shape.editor.shape.autocomplete, editorRaw.autocomplete, DEFAULT_SETTINGS.editor.autocomplete),
    },
    onboarded: pick(shape.onboarded, r.onboarded, DEFAULT_SETTINGS.onboarded),
    weeklyGoal: pick(shape.weeklyGoal, r.weeklyGoal, DEFAULT_SETTINGS.weeklyGoal),
  };
  const layout = shape.layout.safeParse(r.layout);
  if (layout.success && layout.data) settings.layout = layout.data;
  const claudePath = shape.claudePath.safeParse(r.claudePath);
  if (claudePath.success && claudePath.data) settings.claudePath = claudePath.data;
  return settings;
}

export function settingsRoutes(dataDir: string): Router {
  const r = Router();
  const file = path.join(dataDir, "settings.json");

  r.get("/api/settings", async (_req, res) => {
    const raw = await readJson<unknown>(file, DEFAULT_SETTINGS);
    const parsed = settingsSchema.safeParse(raw);
    if (parsed.success) {
      res.json(parsed.data);
      return;
    }
    // Salvage what validates, heal the file on disk, and serve a full shape.
    const repaired = repairSettings(raw);
    await writeJson(file, repaired);
    res.json(repaired);
  });

  r.put("/api/settings", async (req, res) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
      return;
    }
    await writeJson(file, parsed.data);
    res.status(204).end();
  });

  return r;
}
