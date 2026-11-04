import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

type PackageRecord = {
  name: string;
  version: string;
  packageDir: string;
  relativePackageDir: string;
  outDirName: string;
  copiedFiles: string[];
  license?: string | string[];
  description?: string;
  homepage?: string;
  repository?: string;
};

const ROOT = process.cwd();
const LOCKFILE_PATH = path.join(ROOT, "pnpm-lock.yaml");
const OUTPUT_DIR = path.join(ROOT, "licenses");

const COMPLIANCE_FILE_PATTERNS = [
  /^license.*$/i,
  /^licence.*$/i,
  /^notice.*$/i,
];

async function main(): Promise<void> {
  await ensureExists(
    LOCKFILE_PATH,
    "Could not find pnpm-lock.yaml in the project root.",
  );

  const projects = JSON.parse(
    execFileSync(
      "pnpm",
      [
        "--recursive",
        "--include-workspace-root",
        "list",
        "--depth",
        "-1",
        "--json",
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      },
    ),
  ) as { path: string }[];
  const nodeModulesRoots = [];
  for (const project of projects) {
    const root = path.join(project.path, "node_modules");
    if (await isDirectory(root)) nodeModulesRoots.push(root);
  }

  if (nodeModulesRoots.length === 0) {
    throw new Error(
      "Could not find any node_modules directories in the repo root or workspace folders. Run `pnpm install` first.",
    );
  }

  const installed = JSON.parse(
    execFileSync(
      "pnpm",
      [
        "--recursive",
        "--include-workspace-root",
        "licenses",
        "list",
        "--json",
        "--long",
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      },
    ),
  ) as Record<string, { name: string; paths: string[] }[]>;
  const packageDirs = new Set(
    Object.values(installed).flatMap((group) =>
      group.flatMap((item) => item.paths),
    ),
  );
  if (packageDirs.size === 0)
    throw new Error("pnpm reported no installed license inventory");
  const installedNames = new Set(
    Object.values(installed).flatMap((group) => group.map((item) => item.name)),
  );
  const records: PackageRecord[] = [];

  // External linked packages have no lockfile package entry, but still ship in
  // the application. Exclude only this workspace's own package names.
  const workspaces = await Promise.all(
    projects.map(
      async (project) =>
        JSON.parse(
          await fs.readFile(path.join(project.path, "package.json"), "utf8"),
        ) as {
          name?: string;
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
          optionalDependencies?: Record<string, string>;
          peerDependencies?: Record<string, string>;
        },
    ),
  );
  const workspaceNames = new Set(workspaces.map((workspace) => workspace.name));
  const dependencyNames = new Set(
    workspaces.flatMap((workspace) =>
      Object.keys({
        ...workspace.dependencies,
        ...workspace.devDependencies,
        ...workspace.optionalDependencies,
        ...workspace.peerDependencies,
      }),
    ),
  );
  for (const name of dependencyNames) {
    if (workspaceNames.has(name) || installedNames.has(name)) continue;
    const directory = await findInstalledPackageDir(name, nodeModulesRoots);
    if (directory) packageDirs.add(directory);
  }

  await fs.rm(OUTPUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  for (const directory of packageDirs)
    records.push(await processInstalledPackage(directory));

  const uniqueRecords = dedupePackageRecords(records);

  uniqueRecords.sort((a, b) => {
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    return a.version.localeCompare(b.version);
  });

  await writeThirdPartyNotices(uniqueRecords);
  await writeCreditsJson(uniqueRecords);
  await writeCycloneDxSbom(uniqueRecords);

  console.log(
    `Generated ${uniqueRecords.length} third-party package records in ${OUTPUT_DIR}`,
  );
}

async function processInstalledPackage(
  packageDir: string,
): Promise<PackageRecord> {
  const packageJsonPath = path.join(packageDir, "package.json");

  const pkgJsonRaw = await fs.readFile(packageJsonPath, "utf8");
  const pkgJson = JSON.parse(pkgJsonRaw) as Record<string, unknown>;

  if (typeof pkgJson.name !== "string" || typeof pkgJson.version !== "string")
    throw new Error(`Installed package has no name or version: ${packageDir}`);
  const actualName = pkgJson.name;
  const actualVersion = pkgJson.version;

  const outDirName = sanitizeDirName(`${actualName}@${actualVersion}`);
  const outDir = path.join(OUTPUT_DIR, outDirName);
  await fs.mkdir(outDir, { recursive: true });

  const copiedFiles: string[] = [];
  const fileNames = await fs.readdir(packageDir);

  for (const fileName of fileNames) {
    if (!matchesComplianceFile(fileName)) continue;

    const source = path.join(packageDir, fileName);
    if (!(await fs.stat(source)).isFile()) continue;
    await fs.copyFile(source, path.join(outDir, fileName));
    copiedFiles.push(fileName);
  }

  return {
    name: actualName,
    version: actualVersion,
    packageDir,
    relativePackageDir: path.relative(ROOT, packageDir),
    outDirName,
    copiedFiles,
    license: normalizeLicense(pkgJson.license, pkgJson.licenses),
    description:
      typeof pkgJson.description === "string" ? pkgJson.description : undefined,
    homepage:
      typeof pkgJson.homepage === "string" ? pkgJson.homepage : undefined,
    repository: normalizeRepository(pkgJson.repository),
  };
}

async function findInstalledPackageDir(
  packageName: string,
  nodeModulesRoots: string[],
): Promise<string | null> {
  const relativePackagePath = path.join(...packageName.split("/"));

  for (const nodeModulesRoot of nodeModulesRoots) {
    const candidate = path.join(nodeModulesRoot, relativePackagePath);
    const packageJsonPath = path.join(candidate, "package.json");

    if (await isFile(packageJsonPath)) {
      return candidate;
    }
  }

  return null;
}

function normalizeLicense(
  license: unknown,
  licenses: unknown,
): string | string[] | undefined {
  if (typeof license === "string") return license;

  if (Array.isArray(licenses)) {
    return licenses
      .map((item) => {
        if (typeof item === "string") return item;
        if (
          item &&
          typeof item === "object" &&
          "type" in item &&
          typeof (item as { type?: unknown }).type === "string"
        ) {
          return (item as { type: string }).type;
        }
        return null;
      })
      .filter((value): value is string => Boolean(value));
  }

  return undefined;
}

function normalizeRepository(value: unknown): string | undefined {
  if (typeof value === "string") return value;

  if (
    value &&
    typeof value === "object" &&
    "url" in value &&
    typeof (value as { url?: unknown }).url === "string"
  ) {
    return (value as { url: string }).url;
  }

  return undefined;
}

function sanitizeDirName(name: string): string {
  return Array.from(name, (ch) => {
    const code = ch.charCodeAt(0);
    const isControl = code >= 0 && code <= 31;
    const isForbidden = '<>:"/\\|?*'.includes(ch);
    return isControl || isForbidden ? "_" : ch;
  }).join("");
}

function matchesComplianceFile(fileName: string): boolean {
  return COMPLIANCE_FILE_PATTERNS.some((pattern) => pattern.test(fileName));
}

async function ensureExists(
  targetPath: string,
  message: string,
): Promise<void> {
  try {
    await fs.access(targetPath);
  } catch {
    throw new Error(message);
  }
}

async function isDirectory(targetPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(targetPath);
    return stat.isDirectory();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}

async function isFile(targetPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(targetPath);
    return stat.isFile();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}

async function writeThirdPartyNotices(records: PackageRecord[]): Promise<void> {
  const lines: string[] = [];

  lines.push("# Third-party notices");
  lines.push("");
  lines.push(
    "Generated from pnpm's installed dependency inventory for every workspace, including linked external packages.",
  );
  lines.push("");

  for (const record of records) {
    lines.push(`## ${record.name}@${record.version}`);
    lines.push("");
    lines.push(`- License: ${formatLicense(record.license)}`);
    if (record.homepage) lines.push(`- Homepage: ${record.homepage}`);
    if (record.repository) lines.push(`- Repository: ${record.repository}`);
    if (record.description)
      lines.push(`- Description: ${record.description.trimEnd()}`);
    lines.push(
      `- Included files: ${
        record.copiedFiles.length > 0
          ? record.copiedFiles.join(", ")
          : "none found"
      }`,
    );
    lines.push(`- Folder: \`licenses/${record.outDirName}\``);
    lines.push(`- Source package dir: \`${record.relativePackageDir}\``);
    lines.push("");
  }

  await fs.writeFile(
    path.join(OUTPUT_DIR, "THIRD_PARTY_NOTICES.md"),
    lines.join("\n"),
    "utf8",
  );
}

async function writeCreditsJson(records: PackageRecord[]): Promise<void> {
  const payload = {
    generatedAt: new Date().toISOString(),
    packageCount: records.length,
    packages: records.map((record) => ({
      name: record.name,
      version: record.version,
      license: formatLicense(record.license),
      homepage: record.homepage ?? null,
      repository: record.repository ?? null,
      description: record.description ?? null,
      files: record.copiedFiles,
      licenseFolder: `licenses/${record.outDirName}`,
      sourcePackageDir: record.relativePackageDir,
    })),
  };

  await fs.writeFile(
    path.join(OUTPUT_DIR, "third-party-credits.json"),
    JSON.stringify(payload, null, 2),
    "utf8",
  );
}

async function writeCycloneDxSbom(records: PackageRecord[]): Promise<void> {
  const components = records.map((record) => ({
    type: "library",
    bomRef: `pkg:npm/${encodePurlName(record.name)}@${record.version}`,
    name: record.name,
    version: record.version,
    purl: `pkg:npm/${encodePurlName(record.name)}@${record.version}`,
    description: record.description,
    licenses: toCycloneDxLicenses(record.license),
    externalReferences: [
      ...(record.homepage ? [{ type: "website", url: record.homepage }] : []),
      ...(record.repository ? [{ type: "vcs", url: record.repository }] : []),
    ],
    properties: [
      {
        name: "local:licenseFolder",
        value: `licenses/${record.outDirName}`,
      },
      {
        name: "local:sourcePackageDir",
        value: record.relativePackageDir,
      },
    ],
  }));

  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: [
        {
          vendor: "OpenAI",
          name: "custom pnpm license generator",
        },
      ],
      component: {
        type: "application",
        name: path.basename(ROOT),
      },
    },
    components,
  };

  await fs.writeFile(
    path.join(OUTPUT_DIR, "sbom.cyclonedx.json"),
    JSON.stringify(sbom, null, 2),
    "utf8",
  );
}

function dedupePackageRecords(records: PackageRecord[]): PackageRecord[] {
  const unique = new Map<string, PackageRecord>();

  for (const record of records) {
    const key = `${record.name}@${record.version}`;
    const existing = unique.get(key);

    if (!existing) {
      unique.set(key, record);
      continue;
    }

    unique.set(key, {
      ...existing,
      copiedFiles: [
        ...new Set([...existing.copiedFiles, ...record.copiedFiles]),
      ],
      license: existing.license ?? record.license,
      description: existing.description ?? record.description,
      homepage: existing.homepage ?? record.homepage,
      repository: existing.repository ?? record.repository,
    });
  }

  return [...unique.values()];
}

function toCycloneDxLicenses(
  value: string | string[] | undefined,
): Array<{ license: { id?: string; name?: string } }> | undefined {
  if (!value) return undefined;

  const values = Array.isArray(value) ? value : [value];
  const filtered = values.map((item) => item.trim()).filter(Boolean);

  if (filtered.length === 0) return undefined;

  return filtered.map((item) => ({
    license: looksLikeSpdxId(item) ? { id: item } : { name: item },
  }));
}

function looksLikeSpdxId(value: string): boolean {
  return /^[A-Za-z0-9-.+]+$/.test(value);
}

function encodePurlName(name: string): string {
  if (name.startsWith("@")) {
    const [scope, pkg] = name.split("/");
    return `${encodeURIComponent(scope)}/${encodeURIComponent(pkg)}`;
  }
  return encodeURIComponent(name);
}

function formatLicense(value: string | string[] | undefined): string {
  if (Array.isArray(value) && value.length > 0) return value.join(", ");
  if (typeof value === "string" && value.trim()) return value;
  return "UNKNOWN";
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
