import type { AppTypeDetector, EcosystemOptions } from "./build.pack";
import { sshExec } from "../ssh-client";
import type { PackageManager } from "../packages";
import type { VPSConfig } from "../nginx-manager";

export class NodeExpressApp implements AppTypeDetector {
  name = "Node.js / Express";

  async detect(workDir: string, vps: VPSConfig): Promise<boolean> {
    const result = await sshExec(
      vps.ssh,
      `cat "${workDir}/package.json" 2>/dev/null || echo "{}"`,
    );
    try {
      const pkg = JSON.parse(result.stdout);
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (!("express" in deps)) return false;
    } catch {
      return false;
    }

    // Require a tsconfig.json — canonical marker of a TypeScript Express app
    // that compiles to dist/ via tsc.
    const tsconfigCheck = await sshExec(
      vps.ssh,
      `test -f "${workDir}/tsconfig.json" && echo "found"`,
    );
    return tsconfigCheck.stdout.trim() === "found";
  }

  generateEcosystemConfig(options: EcosystemOptions): string {
    return `module.exports = {
  apps: [{
    name: '${options.name}',
    script: 'dist/index.js',
    node_args: '--env-file=.env',
    cwd: '${options.cwd}',
    exec_mode: 'fork',
    watch: false,
    env: {
      NODE_ENV: 'production',
      PORT: '${options.port}'
    }
  }]
};`;
  }

  getBuildCommand(pm: PackageManager): string {
    switch (pm) {
      case "pnpm":
        return "pnpm build";
      case "yarn":
        return "yarn build";
      default:
        return "npm run build";
    }
  }
}
