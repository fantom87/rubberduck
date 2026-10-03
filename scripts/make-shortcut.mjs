// Drops a "Rubberduck.lnk" in the project root pointing at the built
// desktop app, so launching never means digging through app/dist/win-unpacked.
// Runs as part of `npm run app:dist`; harmless to run on its own.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// .lnk files (and the desktop shell they point at) are a Windows-only thing;
// on Linux/macOS this is a no-op so `npm run app:dist` doesn't hard-fail.
if (process.platform !== "win32") {
  console.log("[shortcut] skipped — .lnk shortcuts only exist on Windows.");
  process.exit(0);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(ROOT, "app", "dist", "win-unpacked", "Rubberduck.exe");
const icon = path.join(ROOT, "app", "build", "icon.ico");
const link = path.join(ROOT, "Rubberduck.lnk");

if (!fs.existsSync(target)) {
  console.warn(`[shortcut] skipped — no built app at ${target} (run npm run app:dist first)`);
  process.exit(0);
}

// PowerShell's COM shell is the only reliable way to author a .lnk on Windows.
// Single-quoted PS literals: backslashes stay literal (JSON escaping would
// double them and leave "B:\\Claude\\..." in the shortcut's fields).
const q = (s) => `'${s.replaceAll("'", "''")}'`;
const ps = [
  "$ws = New-Object -ComObject WScript.Shell",
  `$s = $ws.CreateShortcut(${q(link)})`,
  `$s.TargetPath = ${q(target)}`,
  // The repo's data/, not a folder beside the exe: app/dist is rebuilt from
  // scratch, and the dev server reads data/ too. See DATA_DIR_ARG in main.cjs.
  `$s.Arguments = ${q(`--data-dir="${path.join(ROOT, "data")}"`)}`,
  `$s.WorkingDirectory = ${q(path.dirname(target))}`,
  `$s.IconLocation = ${q(icon)}`,
  "$s.Description = 'Learn programming with an AI tutor'",
  "$s.Save()",
].join("; ");

execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], {
  stdio: "inherit",
  windowsHide: true,
});
console.log(`[shortcut] wrote ${link}`);
