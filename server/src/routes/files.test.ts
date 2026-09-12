import { describe, expect, it } from "vitest";
import { parseFiles } from "./files.js";

describe("parseFiles", () => {
  it("accepts a path -> string record", () => {
    expect(parseFiles({ "main.py": "print(1)", "lib/util.py": "" })).toEqual({
      "main.py": "print(1)",
      "lib/util.py": "",
    });
  });

  it("rejects the shapes `typeof x === 'object'` let through", () => {
    expect(parseFiles(null)).toBeNull();
    expect(parseFiles([])).toBeNull();
    expect(parseFiles(["main.py"])).toBeNull();
    expect(parseFiles({ "main.py": 42 })).toBeNull();
    expect(parseFiles({ "main.py": { nested: true } })).toBeNull();
    expect(parseFiles(undefined)).toBeNull();
    expect(parseFiles("main.py")).toBeNull();
  });
});
