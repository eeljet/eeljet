// nginx-manager.ts
import { sshExec, type SSHConfig } from "./ssh-client";

export interface VPSConfig {
  ssh: SSHConfig;
  projectsRoot: string;
  deployUser: string;
  portMappingFile: string;
}

export interface ParsedPortMapping {
  subdomain: string;
  domain: string;
  port: number;
  serverName: string;
}

/**
 * Test Nginx configuration syntax on remote server
 */
export async function testNginxConfig(
  vps: VPSConfig,
): Promise<{ valid: boolean; error?: string }> {
  try {
    // Use NOPASSWD sudo which doesn't require interactive password input
    // Try with sudo first, fallback to direct nginx -t if user has permissions
    const result = await sshExec(vps.ssh, "sudo -n nginx -t 2>&1 || nginx -t 2>&1");
    if (result.code !== 0) {
      return {
        valid: false,
        error: result.stdout || result.stderr || "nginx -t failed",
      };
    }
    return { valid: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { valid: false, error: message };
  }
}

/**
 * Reload Nginx on remote server
 */
export async function reloadNginx(vps: VPSConfig): Promise<void> {
  // Use -n flag to prevent password prompt on non-interactive SSH
  const result = await sshExec(vps.ssh, "sudo -n systemctl reload nginx");
  if (result.code !== 0) {
    throw new Error(`Failed to reload Nginx: ${result.stderr}`);
  }
}

/**
 * Read the port mapping file without sudo (nginx map files are world-readable).
 */
async function readMapFile(vps: VPSConfig): Promise<string> {
  const result = await sshExec(vps.ssh, `cat "${vps.portMappingFile}"`);
  if (result.code !== 0) {
    throw new Error(`Failed to read ${vps.portMappingFile}: ${result.stderr}`);
  }
  return result.stdout;
}

/**
 * Write content to the port mapping file via temp file + cp.
 * Uses cp (not mv) so only file write permission is needed — not directory
 * write permission. Requires the deploy user to own the port mapping file:
 *   sudo chown $VPS_USER:$VPS_USER /etc/nginx/subdomain-ports.map
 */
async function writeMapFile(vps: VPSConfig, content: string): Promise<void> {
  const tmpFile = "/tmp/eeljet-portmap.tmp";
  const writeResult = await sshExec(
    vps.ssh,
    `cat > "${tmpFile}" << 'EELJET_MAP_EOF'\n${content}\nEELJET_MAP_EOF`,
  );
  if (writeResult.code !== 0) {
    throw new Error(`Failed to write temp map file: ${writeResult.stderr}`);
  }

  const cpResult = await sshExec(
    vps.ssh,
    `cp "${tmpFile}" "${vps.portMappingFile}" && rm -f "${tmpFile}"`,
  );
  if (cpResult.code !== 0) {
    await sshExec(vps.ssh, `rm -f "${tmpFile}"`);
    throw new Error(
      `Failed to write map file: ${cpResult.stderr}\n` +
        `Fix on VPS: sudo chown ${vps.deployUser}:${vps.deployUser} ${vps.portMappingFile}`,
    );
  }
}

/**
 * Add a port mapping to the wildcard nginx map file.
 * Format: "subdomain.domain port;"
 * Idempotent: if the exact line already exists, it's a no-op.
 */
export async function addPortMapping(
  vps: VPSConfig,
  subdomain: string,
  domain: string,
  port: number,
): Promise<void> {
  const fullDomain = `${subdomain}.${domain}`;
  const mapLine = `${fullDomain} ${port};`;

  let content: string;
  try {
    content = await readMapFile(vps);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    // If file doesn't exist, treat as empty
    if (errorMessage.includes("No such file or directory")) {
      content = "";
    } else {
      throw err;
    }
  }
  const lines = content.split("\n");

  if (lines.some((l) => l.trim() === mapLine)) {
    return;
  }

  const filtered = lines.filter((l) => !l.trim().startsWith(`${fullDomain} `));
  filtered.push(mapLine);
  const newContent = filtered.join("\n");

  await writeMapFile(vps, newContent);

  const testResult = await testNginxConfig(vps);
  if (!testResult.valid) {
    await writeMapFile(vps, content);
    throw new Error(
      `Nginx config test failed after port mapping: ${testResult.error}`,
    );
  }

  await reloadNginx(vps);
}

/**
 * Remove a port mapping from the wildcard nginx map file.
 */
export async function removePortMapping(
  vps: VPSConfig,
  subdomain: string,
  domain: string,
): Promise<void> {
  const fullDomain = `${subdomain}.${domain}`;

  let content: string;
  try {
    content = await readMapFile(vps);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    // If file doesn't exist, nothing to remove
    if (errorMessage.includes("No such file or directory")) {
      return;
    } else {
      throw err;
    }
  }
  const lines = content.split("\n");
  const filtered = lines.filter((l) => !l.trim().startsWith(`${fullDomain} `));
  await writeMapFile(vps, filtered.join("\n"));

  const testResult = await testNginxConfig(vps);
  if (!testResult.valid) {
    await writeMapFile(vps, content);
    throw new Error(
      `Nginx config test failed after removing port mapping: ${testResult.error}`,
    );
  }

  await reloadNginx(vps);
}

/**
 * Update port for an existing subdomain in the map file.
 */
export async function updatePortMapping(
  vps: VPSConfig,
  subdomain: string,
  domain: string,
  newPort: number,
): Promise<void> {
  const fullDomain = `${subdomain}.${domain}`;
  const newLine = `${fullDomain} ${newPort};`;

  let content: string;
  try {
    content = await readMapFile(vps);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    // If file doesn't exist, can't update
    if (errorMessage.includes("No such file or directory")) {
      throw new Error(`Cannot update port mapping: ${fullDomain} not found (file doesn't exist)`);
    } else {
      throw err;
    }
  }
  const lines = content.split("\n");
  const updated = lines.map((l) =>
    l.trim().startsWith(`${fullDomain} `) ? newLine : l,
  );
  await writeMapFile(vps, updated.join("\n"));

  const testResult = await testNginxConfig(vps);
  if (!testResult.valid) {
    await writeMapFile(vps, content);
    throw new Error(`Nginx config test failed: ${testResult.error}`);
  }

  await reloadNginx(vps);
}

/**
 * Read and parse all entries from the port mapping file.
 * Each line format: "subdomain.domain port;"
 */
export async function readPortMappings(
  vps: VPSConfig,
): Promise<{ mappings: ParsedPortMapping[]; errors: string[] }> {
  const mapFile = vps.portMappingFile;
  const errors: string[] = [];
  const mappings: ParsedPortMapping[] = [];

  let content: string;
  try {
    content = await readMapFile(vps);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    // On a fresh VPS, the port mapping file doesn't exist yet, which is normal
    if (errorMessage.includes("No such file or directory")) {
      return { mappings, errors };
    }
    errors.push(`Unable to read server configuration file. Please contact support if this issue persists.`);
    return { mappings, errors };
  }

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(/^(\S+)\s+(\d+);$/);
    if (!match) {
      errors.push(`Unparseable map line: "${trimmed}"`);
      continue;
    }

    const serverName = match[1];
    const port = parseInt(match[2], 10);
    const parts = serverName.split(".");

    if (parts.length < 3) {
      errors.push(`Invalid server name in map: "${serverName}"`);
      continue;
    }

    const subdomain = parts[0];
    const domain = parts.slice(1).join(".");

    mappings.push({ subdomain, domain, port, serverName });
  }

  return { mappings, errors };
}

/**
 * Remove project directory on remote server
 */
export async function removeProjectDirectory(
  vps: VPSConfig,
  projectName: string,
): Promise<void> {
  const safeName = projectName.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const projectPath = `${vps.projectsRoot}/${safeName}`;
  if (projectPath.startsWith(vps.projectsRoot)) {
    await sshExec(vps.ssh, `sudo rm -rf ${projectPath}`);
  }
}
