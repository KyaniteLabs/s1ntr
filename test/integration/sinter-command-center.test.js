import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const page = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../sinter-command-center.html"), "utf8");
const scripts = [...page.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]).filter(Boolean);

describe("command center frontend contracts", () => {
  it("keeps every inline script syntactically valid", () => {
    scripts.forEach((source, index) => expect(() => new vm.Script(source, { filename: `command-center-${index}.js` })).not.toThrow());
  });

});
