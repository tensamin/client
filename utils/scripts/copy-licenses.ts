import { promises as fs } from "node:fs";
import path from "node:path";

type PnpmLock = {
  lockfileVersion?: number;
  importers?: Record<string, WorkspaceEntry>;
  packages?: Record<string, unknown>;
};

type WorkspaceEntry = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

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

type ResolvedPackage = {
  name: string;
  version: string;
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

  const lock = await readPnpmLock();
  const nodeModulesRoots = await getNodeModulesRoots(lock);

  if (nodeModulesRoots.length === 0) {
    throw new Error(
      "Could not find any node_modules directories in the repo root or workspace folders. Run `pnpm install` first.",
    );
  }

  await fs.rm(OUTPUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const resolvedPackages = extractResolvedThirdPartyPackages(lock);
  const records: PackageRecord[] = [];

  for (const resolved of resolvedPackages) {
    const record = await processInstalledPackage(
      resolved.name,
      resolved.version,
      nodeModulesRoots,
    );

    if (record) {
      records.push(record);
    }
  }

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

async function readPnpmLock(): Promise<PnpmLock> {
  const raw = await fs.readFile(LOCKFILE_PATH, "utf8");

  return {
    importers: extractTopLevelMappingKeys(raw, "importers"),
    packages: extractTopLevelMappingKeys(raw, "packages"),
  };
}

function extractTopLevelMappingKeys(
  yaml: string,
  sectionName: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split(/\r?\n/);

  let inSection = false;

  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;

    const indent = line.length - line.trimStart().length;

    if (indent === 0) {
      inSection = line === `${sectionName}:`;
      continue;
    }

    if (!inSection || indent !== 2) continue;

    const trimmed = line.trim();
    const colonIndex = findYamlKeyColon(trimmed);
    if (colonIndex < 0) continue;

    const rawKey = trimmed.slice(0, colonIndex).trim();
    if (!rawKey) continue;

    result[decodeYamlKey(rawKey)] = {};
  }

  return result;
}

function findYamlKeyColon(value: string): number {
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < value.length; i++) {
    const ch = value[i];

    if (quote === '"') {
      if (ch === "\\") {
        i++;
      } else if (ch === '"') {
        quote = null;
      }
      continue;
    }

    if (quote === "'") {
      if (ch === "'" && value[i + 1] === "'") {
        i++;
      } else if (ch === "'") {
        quote = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (ch === ":") return i;
  }

  return -1;
}

function decodeYamlKey(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return JSON.parse(value) as string;
  }

  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }

  return value;
}

async function getNodeModulesRoots(lock: PnpmLock): Promise<string[]> {
  const candidates = new Set<string>();

  candidates.add(path.join(ROOT, "node_modules"));

  for (const workspacePath of Object.keys(lock.importers ?? {})) {
    const workspaceDir =
      workspacePath === "." ? ROOT : path.join(ROOT, workspacePath);
    candidates.add(path.join(workspaceDir, "node_modules"));
  }

  const existing: string[] = [];
  for (const candidate of candidates) {
    if (await isDirectory(candidate)) {
      existing.push(candidate);
    }
  }

  // Prefer deeper workspace-local installs over root-hoisted installs.
  existing.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);

  return existing;
}

function extractResolvedThirdPartyPackages(lock: PnpmLock): ResolvedPackage[] {
  const results = new Map<string, ResolvedPackage>();
  const packages = lock.packages ?? {};

  for (const rawKey of Object.keys(packages)) {
    const resolved = parsePnpmPackageKey(rawKey);
    if (!resolved) continue;

    const { name, version } = resolved;

    if (!name || !version) continue;
    if (version.startsWith("workspace:")) continue;

    const key = `${name}@${version}`;
    if (!results.has(key)) {
      results.set(key, { name, version });
    }
  }

  return [...results.values()];
}

function parsePnpmPackageKey(rawKey: string): ResolvedPackage | null {
  const withoutPeerSuffix = rawKey.replace(/\(.+\)$/, "");
  const normalized = withoutPeerSuffix.startsWith("/")
    ? withoutPeerSuffix.slice(1)
    : withoutPeerSuffix;
  const atIndex = normalized.lastIndexOf("@");

  if (atIndex <= 0) return null;

  return {
    name: normalized.slice(0, atIndex),
    version: normalized.slice(atIndex + 1),
  };
}

async function processInstalledPackage(
  packageName: string,
  versionFromLock: string,
  nodeModulesRoots: string[],
): Promise<PackageRecord | null> {
  const packageDir = await findInstalledPackageDir(
    packageName,
    nodeModulesRoots,
  );
  if (!packageDir) return null;

  const packageJsonPath = path.join(packageDir, "package.json");

  try {
    const pkgJsonRaw = await fs.readFile(packageJsonPath, "utf8");
    const pkgJson = JSON.parse(pkgJsonRaw) as Record<string, unknown>;

    const actualName =
      typeof pkgJson.name === "string" ? pkgJson.name : packageName;
    const actualVersion =
      typeof pkgJson.version === "string" ? pkgJson.version : versionFromLock;

    const outDirName = sanitizeDirName(`${actualName}@${actualVersion}`);
    const outDir = path.join(OUTPUT_DIR, outDirName);
    await fs.mkdir(outDir, { recursive: true });

    const copiedFiles: string[] = [];
    const fileNames = await safeReadDir(packageDir);

    for (const fileName of fileNames) {
      if (!matchesComplianceFile(fileName)) continue;

      await copyFileIfExists(
        path.join(packageDir, fileName),
        path.join(outDir, fileName),
        copiedFiles,
        fileName,
      );
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
        typeof pkgJson.description === "string"
          ? pkgJson.description
          : undefined,
      homepage:
        typeof pkgJson.homepage === "string" ? pkgJson.homepage : undefined,
      repository: normalizeRepository(pkgJson.repository),
    };
  } catch {
    return null;
  }
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

async function copyFileIfExists(
  src: string,
  dest: string,
  copiedFiles: string[],
  label: string,
): Promise<void> {
  try {
    const stat = await fs.stat(src);
    if (!stat.isFile()) return;
    await fs.copyFile(src, dest);
    copiedFiles.push(label);
  } catch {
    // ignore missing/unreadable files
  }
}

async function safeReadDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
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
  } catch {
    return false;
  }
}

async function isFile(targetPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(targetPath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function writeThirdPartyNotices(records: PackageRecord[]): Promise<void> {
  const lines: string[] = [];

  lines.push("# Third-Party Notices");
  lines.push("");
  lines.push(
    "Generated from pnpm-lock.yaml and installed packages in workspace node_modules folders.",
  );
  lines.push("");

  for (const record of records) {
    lines.push(`## ${record.name}@${record.version}`);
    lines.push("");
    lines.push(`- License: ${formatLicense(record.license)}`);
    if (record.homepage) lines.push(`- Homepage: ${record.homepage}`);
    if (record.repository) lines.push(`- Repository: ${record.repository}`);
    if (record.description) lines.push(`- Description: ${record.description}`);
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
