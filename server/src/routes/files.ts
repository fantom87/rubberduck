import { filesSchema } from "@teacher/shared";

/**
 * The one place a request's `files` is validated. Four routes accept an
 * editor's worth of files and until now three of them checked only
 * `typeof files === "object"`, which lets `null`, arrays and non-string values
 * through — a `null` reached the snapshot store and was persisted as-is, and a
 * number reached fs.writeFile and 500'd after the run counter had already
 * ticked. Returns null on anything that isn't a plain path -> string record.
 */
export function parseFiles(value: unknown): Record<string, string> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const parsed = filesSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
