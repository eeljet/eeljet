import type { GitProvider, CloneResult } from "./git.provider";
import { sshExec, type SSHConfig } from "../ssh-client";

export class GitHubProvider implements GitProvider {
  name = "GitHub";

  canHandle(repoUrl: string): boolean {
    try {
      const parsed = new URL(repoUrl);
      return parsed.hostname === "github.com";
    } catch {
      return false;
    }
  }

  validateRepoUrl(url: string): void {
    try {
      const parsed = new URL(url);
      if (parsed.hostname !== "github.com") {
        throw new Error("Only GitHub repositories are supported");
      }
      if (!/^\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(parsed.pathname)) {
        throw new Error("Invalid GitHub repository URL");
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("GitHub")) {
        throw e;
      }
      throw new Error("Invalid repository URL");
    }
  }

  /**
   * Build an authenticated HTTPS URL with the token embedded.
   * Token never touches disk — lives only in memory/env.
   */
  private buildAuthenticatedUrl(repoUrl: string, token: string): string {
    const parsed = new URL(repoUrl);
    const pathname = parsed.pathname.endsWith(".git")
      ? parsed.pathname
      : `${parsed.pathname}.git`;
    return `https://oauth2:${token}@${parsed.hostname}${pathname}`;
  }

  /**
   * Strip token from a remote URL, leaving clean HTTPS URL.
   */
  private stripToken(url: string): string {
    return url.replace(/https:\/\/oauth2:[^@]+@/, "https://");
  }

  async cloneSecure(
    ssh: SSHConfig,
    repoUrl: string,
    branch: string,
    token: string,
    destPath: string,
  ): Promise<CloneResult> {
    const authenticatedUrl = this.buildAuthenticatedUrl(repoUrl, token);

    const cloneResult = await sshExec(
      ssh,
      // Token is embedded in URL — no temp file needed.
      // sed masks the token in any output/logs.
      `GIT_TERMINAL_PROMPT=0 git clone --branch "${branch}" --single-branch --depth 1 "${authenticatedUrl}" "${destPath}" 2>&1 | sed 's/oauth2:[^@]*@/oauth2:***@/g'`,
    );

    if (cloneResult.code !== 0) {
      return {
        success: false,
        error: `Git clone failed: ${cloneResult.stderr || cloneResult.stdout}`,
      };
    }

    return { success: true };
  }

  /**
   * Embed token into the repo's remote URL for authenticated git fetch.
   * Returns the project path so cleanupCredentials knows where to reset.
   */
  async setupCredentials(
    ssh: SSHConfig,
    projectPath: string,
    token: string,
  ): Promise<string> {
    // Get current remote URL (may already have a token from last deploy — strip it first)
    const result = await sshExec(
      ssh,
      `cd "${projectPath}" && git remote get-url origin`,
    );
    const cleanUrl = this.stripToken(result.stdout.trim());
    const authenticatedUrl = this.buildAuthenticatedUrl(cleanUrl, token);

    await sshExec(
      ssh,
      `cd "${projectPath}" && git remote set-url origin "${authenticatedUrl}"`,
    );

    // Return projectPath — used by cleanupCredentials to reset the remote URL
    return projectPath;
  }

  /**
   * Strip token from remote URL after pull is complete.
   * credHelperPath here is actually the projectPath returned by setupCredentials.
   */
  async cleanupCredentials(
    ssh: SSHConfig,
    credHelperPath: string, // projectPath
  ): Promise<void> {
    const result = await sshExec(
      ssh,
      `cd "${credHelperPath}" && git remote get-url origin`,
    );
    const cleanUrl = this.stripToken(result.stdout.trim());
    await sshExec(
      ssh,
      `cd "${credHelperPath}" && git remote set-url origin "${cleanUrl}"`,
    );
  }
}
