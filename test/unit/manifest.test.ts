// Contribution points that only VS Code renders: checked against package.json directly.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const nls = JSON.parse(readFileSync(join(root, "package.nls.json"), "utf8"));
const nlsZh = JSON.parse(readFileSync(join(root, "package.nls.zh-cn.json"), "utf8"));
const ignore = readFileSync(join(root, ".vscodeignore"), "utf8");

describe("package.json", () => {
  it("puts DocsView preview buttons in the title bar of Markdown and CSV text editors", () => {
    const titleBar: { command: string; when: string; group: string }[] = pkg.contributes.menus["editor/title"];
    for (const command of ["docsview.showPreview", "docsview.showPreviewToSide"]) {
      const item = titleBar.find((m) => m.command === command);
      expect(item, command).toBeDefined();
      expect(item!.group).toMatch(/^navigation/);
      expect(item!.when).toContain("!activeCustomEditorId");
      for (const ext of [".md", ".markdown", ".csv", ".tsv"]) {
        expect(new RegExp(/=~ \/(.*)\/i/.exec(item!.when)![1], "i").test(ext)).toBe(true);
      }
    }
    const source = titleBar.find((m) => m.command === "docsview.showSource");
    expect(source?.when).toContain("activeCustomEditorId == \x27docsview.markdown\x27");
  });

  it("ships light and dark icons for those buttons", () => {
    for (const command of ["docsview.showPreview", "docsview.showPreviewToSide"]) {
      const icon = pkg.contributes.commands.find((c: { command: string }) => c.command === command).icon;
      for (const variant of ["light", "dark"]) {
        expect(existsSync(join(root, icon[variant])), icon[variant]).toBe(true);
      }
    }
    expect(ignore).toContain("!media/icons/**");
  });

  it("localises every %key% it uses, in English and Chinese", () => {
    const keys = [...JSON.stringify(pkg.contributes).matchAll(/%([\w.]+)%/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(10);
    for (const key of keys) {
      expect(nls[key], key).toBeTruthy();
      expect(nlsZh[key], key).toBeTruthy();
    }
  });

  it("declares the row/column highlight setting, on by default", () => {
    expect(pkg.contributes.configuration.properties["docsview.highlightRowColumn"]).toMatchObject({
      type: "boolean",
      default: true,
    });
  });

  it("depends on no other extension and activates non-blockingly after startup", () => {
    expect(pkg.extensionDependencies ?? []).toEqual([]);
    expect(pkg.extensionPack ?? []).toEqual([]);
    expect(pkg.activationEvents).toContain("onStartupFinished");
  });
});
