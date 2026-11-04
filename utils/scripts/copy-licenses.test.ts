import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
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
    const dependency = join(temporary, "dependency");
    const owned = join(root, "packages/owned");
    mkdirSync(join(root, "node_modules/@tensamin"), { recursive: true });
    mkdirSync(sdk);
    mkdirSync(dependency);
    mkdirSync(owned, { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "client",
        dependencies: {
          mtp: "link:../sdk",
          "@tensamin/owned": "workspace:*",
        },
      }),
    );
    writeFileSync(
      join(sdk, "package.json"),
      JSON.stringify({ name: "mtp", version: "0.4.0" }),
    );
    writeFileSync(
      join(owned, "package.json"),
      JSON.stringify({
        name: "@tensamin/owned",
        version: "0.0.0",
        dependencies: { "license-fixture": `file:${dependency}` },
      }),
    );
    writeFileSync(
      join(dependency, "package.json"),
      JSON.stringify({
        name: "license-fixture",
        version: "1.0.0",
        license: "MIT",
      }),
    );
    writeFileSync(join(dependency, "LICENSE"), "Fixture license text");
    writeFileSync(
      join(root, "pnpm-workspace.yaml"),
      'packages:\n  - "packages/*"\n',
    );
    execFileSync("pnpm", ["install", "--offline", "--ignore-scripts"], {
      cwd: root,
      stdio: "pipe",
    });
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
    expect(credits.packageCount).toBe(2);
    expect(
      credits.packages.find((pkg: { name: string }) => pkg.name === "mtp"),
    ).toMatchObject({
      name: "mtp",
      version: "0.4.0",
      license: "UNKNOWN",
    });
    const sbom = JSON.parse(
      readFileSync(join(root, "licenses/sbom.cyclonedx.json"), "utf8"),
    );
    expect(sbom.components).toHaveLength(2);
    expect(
      sbom.components.find((pkg: { name: string }) => pkg.name === "mtp"),
    ).not.toHaveProperty("licenses");
    expect(
      credits.packages.find(
        (pkg: { name: string }) => pkg.name === "license-fixture",
      ),
    ).toMatchObject({
      version: "1.0.0",
      license: "MIT",
      files: ["LICENSE"],
    });
    expect(
      readFileSync(
        join(root, "licenses/license-fixture@1.0.0/LICENSE"),
        "utf8",
      ),
    ).toBe("Fixture license text");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
