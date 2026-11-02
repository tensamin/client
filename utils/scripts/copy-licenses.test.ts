import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("includes an external linked SDK without inventing a license or listing workspace packages", () => {
  const temporary = mkdtempSync(join(tmpdir(), "tensamin-license-links-"));
  try {
    const root = join(temporary, "client");
    const sdk = join(temporary, "sdk");
    const owned = join(root, "packages/owned");
    mkdirSync(join(root, "node_modules/@tensamin"), { recursive: true });
    mkdirSync(sdk);
    mkdirSync(owned, { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "client",
        dependencies: { mtp: "link:../sdk", "@tensamin/owned": "workspace:*" },
      }),
    );
    writeFileSync(
      join(sdk, "package.json"),
      JSON.stringify({ name: "mtp", version: "0.4.0" }),
    );
    writeFileSync(
      join(owned, "package.json"),
      JSON.stringify({ name: "@tensamin/owned", version: "0.0.0" }),
    );
    symlinkSync(sdk, join(root, "node_modules/mtp"), "junction");
    symlinkSync(owned, join(root, "node_modules/@tensamin/owned"), "junction");
    writeFileSync(
      join(root, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\nimporters:\n  .: {}\n  packages/owned: {}\npackages: {}\n",
    );
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL("./copy-licenses.ts", import.meta.url))],
      {
        cwd: root,
        stdio: "pipe",
      },
    );
    const credits = JSON.parse(
      readFileSync(join(root, "licenses/third-party-credits.json"), "utf8"),
    );
    expect(credits.packageCount).toBe(1);
    expect(credits.packages[0]).toMatchObject({
      name: "mtp",
      version: "0.4.0",
      license: "UNKNOWN",
    });
    const sbom = JSON.parse(
      readFileSync(join(root, "licenses/sbom.cyclonedx.json"), "utf8"),
    );
    expect(sbom.components).toHaveLength(1);
    expect(sbom.components[0].name).toBe("mtp");
    expect(sbom.components[0]).not.toHaveProperty("licenses");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
