import { readPortMappings } from "../nginx-manager";
import type { VPSConfig } from "../nginx-manager";
import { sshExec } from "../ssh-client";
import { parseGitHubRepo } from "../cicd";
import type { DiscoveredProject } from "./sync.types";

const SOURCE_NVM = `source ~/.nvm/nvm.sh 2>/dev/null || source ~/.bashrc 2>/dev/null || true; export PATH="$HOME/.local/share/pnpm:$PATH"`;

interface PM2Process {
  name: string;
  pm2_env?: { status?: string };
}

/**
 * Discover all EelJet-deployed projects on the VPS.
 * Uses the nginx port map as the primary source of truth, then enriches
 * each entry with data from PM2, git, ecosystem.config.js, package.json,
 * and .env. Ownership is determined solely by git remote URL.
 */
export async function discoverVPSProjects(
  vps: VPSConfig,
  domain: string,
): Promise<{ projects: DiscoveredProject[]; errors: string[] }> {
  const errors: string[] = [];
  const projects: DiscoveredProject[] = [];

  // Step 1: Read port mappings from nginx map file
  const mapResult = await readPortMappings(vps);
  for (const e of mapResult.errors) {
    errors.push(`Unable to read server configuration. Please try again or contact support if the issue persists.`);
  }

  // Filter to our domain only
  const configs = mapResult.mappings.filter((m) => m.domain === domain);

  if (configs.length === 0) {
    return { projects, errors };
  }

  // Step 2: Get all PM2 processes in one SSH call
  const pm2Map = await getPM2StatusMap(vps);

  // Step 3: Enrich each mapping with project data
  for (const mapping of configs) {
    try {
      const project = await gatherProjectData(
        vps,
        mapping.subdomain,
        mapping.domain,
        mapping.port,
        pm2Map,
      );
      projects.push(project);
    } catch (err) {
      errors.push(
        `Unable to gather project data for ${mapping.subdomain}. Please try again or contact support if the issue persists.`,
      );
    }
  }

  return { projects, errors };
}

/**
 * Get PM2 process status for all running processes in one SSH call.
 * Returns a Map<processName, status>.
 */
async function getPM2StatusMap(vps: VPSConfig): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const result = await sshExec(
      vps.ssh,
      `bash -c '${SOURCE_NVM} && pm2 jlist 2>/dev/null || echo "[]"'`,
    );
    const processes: PM2Process[] = JSON.parse(result.stdout || "[]");
    for (const proc of processes) {
      if (proc.name) {
        map.set(proc.name, proc.pm2_env?.status || "unknown");
      }
    }
  } catch {
    // PM2 not available or no processes — that's fine
  }
  return map;
}

// Delimiter used to separate sections in the batched SSH output
const SEP = "===EELJET_SEP===";

/**
 * Gather all data for a single project in one batched SSH call.
 */
async function gatherProjectData(
  vps: VPSConfig,
  subdomain: string,
  domain: string,
  port: number,
  pm2Map: Map<string, string>,
): Promise<DiscoveredProject> {
  const projectPath = `${vps.projectsRoot}/${subdomain}`;

  // Batched SSH command: check dir, git info, ecosystem, package.json, .env
  const cmd = [
    // Section 0: dir exists
    `test -d "${projectPath}" && echo "exists" || echo "missing"`,
    `echo "${SEP}"`,
    // Section 1: git remote
    `cd "${projectPath}" 2>/dev/null && git remote get-url origin 2>/dev/null || echo "__NONE__"`,
    `echo "${SEP}"`,
    // Section 2: git commit hash
    `cd "${projectPath}" 2>/dev/null && git rev-parse --short HEAD 2>/dev/null || echo "__NONE__"`,
    `echo "${SEP}"`,
    // Section 3: git branch
    `cd "${projectPath}" 2>/dev/null && git branch --show-current 2>/dev/null || echo "__NONE__"`,
    `echo "${SEP}"`,
    // Section 4: ecosystem.config.js
    `cat "${projectPath}/ecosystem.config.js" 2>/dev/null || echo "__NONE__"`,
    `echo "${SEP}"`,
    // Section 5: package.json
    `cat "${projectPath}/package.json" 2>/dev/null || echo "__NONE__"`,
    `echo "${SEP}"`,
    // Section 6: .env
    `cat "${projectPath}/.env" 2>/dev/null || echo "__NONE__"`,
  ].join(" && ");

  const result = await sshExec(vps.ssh, cmd, { timeout: 15000 });
  const sections = result.stdout.split(SEP).map((s) => s.trim());

  const hasProjectDir = sections[0] === "exists";
  const repoUrl = parseGitUrl(sections[1]);

  // Extract GitHub owner from repo URL
  let repoOwner: string | null = null;
  if (repoUrl) {
    try {
      repoOwner = parseGitHubRepo(repoUrl).owner;
    } catch {
      // Non-GitHub or malformed URL — leave null
    }
  }

  const commitHash = parseNullable(sections[2]);
  const branch = parseNullable(sections[3]);
  const ecosystemRaw = parseNullable(sections[4]);
  const packageJsonRaw = parseNullable(sections[5]);
  const envRaw = parseNullable(sections[6]);

  const eco = parseEcosystem(ecosystemRaw);
  const pkg = parsePackageJson(packageJsonRaw);
  const envVars = parseEnvFile(envRaw);

  // Determine rootDirectory from ecosystem cwd
  let rootDirectory: string | null = null;
  if (eco.cwd && eco.cwd !== projectPath && eco.cwd.startsWith(projectPath)) {
    rootDirectory = eco.cwd.slice(projectPath.length + 1);
  }

  // PM2 status lookup
  const pm2Id = eco.name || subdomain;
  const pm2RawStatus = pm2Map.get(pm2Id);
  const pm2Status = mapPm2RawStatus(pm2RawStatus);

  return {
    subdomain,
    domain,
    port,
    nginxConfigPath: vps.portMappingFile,
    repoUrl,
    repoOwner,
    branch,
    commitHash,
    pm2Id,
    pm2Status,
    ecosystemPort: eco.port,
    ecosystemCwd: eco.cwd,
    projectName: pkg.name || subdomain,
    appType: pkg.appType,
    envVars,
    projectPath,
    hasProjectDir,
    hasSslCert: true, // Wildcard SSL covers all subdomains
    rootDirectory,
  };
}

function parseNullable(value: string | undefined): string | null {
  if (!value || value === "__NONE__") return null;
  return value;
}

/**
 * Parse git remote URL. Handles SSH format conversion to HTTPS.
 */
function parseGitUrl(raw: string | undefined): string | null {
  if (!raw || raw === "__NONE__") return null;
  const url = raw.trim();
  // Convert git@github.com:user/repo.git → https://github.com/user/repo
  const sshMatch = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return `https://${sshMatch[1]}/${sshMatch[2]}`;
  }
  // Strip trailing .git from HTTPS URLs
  return url.replace(/\.git$/, "");
}

/**
 * Parse ecosystem.config.js to extract name, port, cwd.
 */
function parseEcosystem(raw: string | null): {
  name: string | null;
  port: number | null;
  cwd: string | null;
} {
  if (!raw) return { name: null, port: null, cwd: null };

  const nameMatch = raw.match(/name:\s*['"]([^'"]+)['"]/);
  const portMatch = raw.match(/PORT:\s*(\d+)/);
  const cwdMatch = raw.match(/cwd:\s*['"]([^'"]+)['"]/);

  return {
    name: nameMatch?.[1] || null,
    port: portMatch ? parseInt(portMatch[1], 10) : null,
    cwd: cwdMatch?.[1] || null,
  };
}

/**
 * Parse package.json to extract name and detect app type.
 */
function parsePackageJson(raw: string | null): {
  name: string | null;
  appType: string | null;
} {
  if (!raw) return { name: null, appType: null };

  try {
    const pkg = JSON.parse(raw);
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    let appType: string | null = null;

    if ("next" in deps) appType = "Next.js";

    return { name: pkg.name || null, appType };
  } catch {
    return { name: null, appType: null };
  }
}

/**
 * Parse .env file content into key-value pairs.
 * Skips NODE_ENV and PORT (system-managed by EelJet).
 */
function parseEnvFile(raw: string | null): Record<string, string> {
  if (!raw) return {};

  const vars: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    // Remove surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Skip system-managed vars
    if (key === "NODE_ENV" || key === "PORT") continue;

    vars[key] = value;
  }

  return vars;
}

function mapPm2RawStatus(
  raw: string | undefined,
): "online" | "stopped" | "errored" | "not_found" {
  if (!raw) return "not_found";
  if (raw === "online") return "online";
  if (raw === "stopped" || raw === "stopping") return "stopped";
  if (raw === "errored" || raw === "launch failed") return "errored";
  return "not_found";
}
