import type { AppTypeDetector, EcosystemOptions } from "./build.pack";
import { sshExec } from "../ssh-client";
import type { PackageManager } from "../packages";
import type { VPSConfig } from "../nginx-manager";

export class ViteApp implements AppTypeDetector {
  name = "Vite";

  async detect(workDir: string, vps: VPSConfig): Promise<boolean> {
    const result = await sshExec(
      vps.ssh,
      `cat "${workDir}/package.json" 2>/dev/null || echo "{}"`,
    );
    try {
      const pkg = JSON.parse(result.stdout);
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (!("vite" in deps)) return false;
    } catch {
      return false;
    }

    // Require a vite config file — the canonical marker of a Vite app.
    // This avoids false positives from projects that only use Vite as a
    // library bundler or Storybook dependency without being a Vite app.
    const configCheck = await sshExec(
      vps.ssh,
      `ls "${workDir}/vite.config.ts" "${workDir}/vite.config.js" "${workDir}/vite.config.mts" "${workDir}/vite.config.mjs" 2>/dev/null | head -1`,
    );
    return configCheck.stdout.trim().length > 0;
  }

  generateEcosystemConfig(options: EcosystemOptions): string {
    return `module.exports = {
  apps: [{
    name: '${options.name}',
    script: './node_modules/vite/dist/node/cli.js',
    args: 'preview --port ${options.port} --host',
    cwd: '${options.cwd}',
    exec_mode: 'fork',
    watch: false,
    env: {
      NODE_ENV: 'production',
      __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: '${options.hostname}'
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
