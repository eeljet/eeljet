import type { PackageManager } from "../packages";
import type { VPSConfig } from "../nginx-manager";

export interface EcosystemOptions {
  name: string;
  cwd: string;
  port: number;
  packageManager: string;
}

export interface AppTypeDetector {
  name: string;
  detect(workDir: string, vps: VPSConfig): Promise<boolean>;
  generateEcosystemConfig(options: EcosystemOptions): string;
  getBuildCommand(packageManager: PackageManager): string;
}
