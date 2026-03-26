import type { AppTypeDetector } from "./build.pack";
import { NextJsApp } from "./build.nextjs";
import { ViteApp } from "./build.vite";
import { NodeExpressApp } from "./build.express";
import type { VPSConfig } from "../nginx-manager";
import { sshExec } from "../ssh-client";
import type { PackageManager } from "../packages";

export type { AppTypeDetector } from "./build.pack";

const APP_TYPES: AppTypeDetector[] = [
  new NextJsApp(),
  new ViteApp(),
  new NodeExpressApp(),
  // Future: new AstroApp(),
  // Future: new RemixApp(),
];

export async function detectAppType(
  workDir: string,
  vps: VPSConfig,
): Promise<AppTypeDetector> {
  for (const appType of APP_TYPES) {
    if (await appType.detect(workDir, vps)) {
      return appType;
    }
  }
  throw new Error("Unsupported app type. Currently only Next.js, Vite, and Node.js/Express are supported.");
}

// Patterns that indicate a script value is a build step (not dev/watch/test)
const BUILD_VALUE_PATTERNS = [
  /\bnext\s+build\b/,
  /\bvite\s+build\b/,
  /\btsc\b(?!\s*--watch)/,
  /\bwebpack\b(?!.*--watch)/,
  /\bparcel\s+build\b/,
  /\besbuild\b(?!.*--watch)/,
  /\brollup\b(?!.*--watch)/,
  /\bturbo\s+build\b/,
  /\bnuxt\s+build\b/,
  /\bng\s+build\b/,
  /\bsvelte-kit\s+build\b/,
  /\bremix\s+build\b/,
  /\bastro\s+build\b/,
];

// Script names that are clearly not build steps
const NON_BUILD_NAMES = /^(dev|start|test|lint|format|type-?check|clean|prepare|preinstall|postinstall|db:|seed|migrate|generate|studio|push|pull)/;

/**
 * Reads scripts from package.json and returns the appropriate build command
 * for the given package manager. Returns null if no build script is found,
 * which means the build step should be skipped.
 *
 * Detection order:
 * 1. Well-known build script names ("build", "build:prod", etc.)
 * 2. Any script whose value matches a known build tool pattern
 */
export async function getPackageJsonBuildScript(
  workDir: string,
  vps: VPSConfig,
  pm: PackageManager,
): Promise<string | null> {
  const result = await sshExec(
    vps.ssh,
    `cat "${workDir}/package.json" 2>/dev/null || echo "{}"`,
  );

  let scripts: Record<string, string>;
  try {
    const pkg = JSON.parse(result.stdout);
    scripts = pkg.scripts ?? {};
  } catch {
    return null;
  }

  const runCmd = (name: string) => {
    switch (pm) {
      case "pnpm": return `pnpm run ${name}`;
      case "yarn": return `yarn ${name}`;
      default:     return `npm run ${name}`;
    }
  };

  // 1. Prefer scripts explicitly named after common build conventions
  const namedCandidates = ["build", "build:prod", "build:production", "compile"];
  for (const name of namedCandidates) {
    if (name in scripts) return runCmd(name);
  }

  // 2. Scan script values for any known build tool pattern
  for (const [name, value] of Object.entries(scripts)) {
    if (NON_BUILD_NAMES.test(name)) continue;
    if (BUILD_VALUE_PATTERNS.some((re) => re.test(value))) return runCmd(name);
  }

  return null;
}
