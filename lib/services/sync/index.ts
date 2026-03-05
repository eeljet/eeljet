import { getVPSConfig, getAppDomain } from "@/lib/config";
import prisma from "@/lib/prisma";
import { discoverVPSProjects } from "./sync.discovery";
import { reconcileProjects } from "./sync.reconciler";
import { importProjects, reconcileStatuses } from "./sync.importer";
import type { SyncResult, SyncProgressCallback } from "./sync.types";

export type {
  SyncResult,
  SyncProgressEvent,
  SyncProgressCallback,
} from "./sync.types";

/**
 * Sync projects from VPS into the database.
 *
 * Ownership is determined by matching the git remote URL owner
 * (e.g. github.com/eeljet/repo → "eeljet")
 * against the authenticated user's githubUsername stored at login.
 *
 * This means:
 * - Works for both EelJet-deployed AND manually configured projects
 * - Survives DB wipes — just log in and sync
 * - No marker files needed on the VPS
 *
 * Fallback: if repoOwner can't be determined (no git remote set),
 * the project is included anyway so the user can claim it.
 */
export async function syncProjects(
  userId: string,
  onProgress?: SyncProgressCallback,
): Promise<SyncResult> {
  const vps = getVPSConfig();
  const domain = getAppDomain();
  const errors: string[] = [];

  // Get the user's GitHub username for git remote owner matching
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { githubUsername: true },
  });
  const githubUsername = user?.githubUsername?.toLowerCase() || null;

  // Step 1: Discover what's deployed on the VPS
  onProgress?.({ type: "discovering" });
  const { projects: allDiscovered, errors: discoveryErrors } =
    await discoverVPSProjects(vps, domain);
  errors.push(...discoveryErrors);

  // Step 2: Filter to projects owned by this user
  // Primary:  git remote owner matches githubUsername
  // Fallback: no repoOwner available — include so user can claim it
  const discovered = allDiscovered.filter((p) => {
    // only include projects whose git remote owner matches the user
    if (githubUsername && p.repoOwner) {
      return p.repoOwner.toLowerCase() === githubUsername;
    }
    // without a repoOwner we have no way to verify ownership; ignore it
    return false;
  });

  onProgress?.({
    type: "discovered",
    total: discovered.length,
    subdomains: discovered.map((p) => p.subdomain),
  });

  // Step 3: Get this user's projects only. avoid leaking others during sync
  const dbProjects = await prisma.project.findMany({
    where: { userId },
    select: { id: true, subdomain: true, name: true, status: true },
  });

  // Step 4: Compare VPS state vs DB state
  const comparison = reconcileProjects(discovered, dbProjects);

  // Step 5: Import new projects and set up CI/CD
  const imported = await importProjects(
    comparison.toImport,
    userId,
    vps,
    onProgress,
  );

  // Step 6: Reconcile status mismatches
  onProgress?.({ type: "reconciling" });
  const reconciled = await reconcileStatuses(comparison.toReconcile);

  const result: SyncResult = {
    success: errors.length === 0 && imported.every((r) => r.success),
    discovered: discovered.length,
    imported,
    reconciled,
    orphaned: comparison.orphaned.map((o) => ({
      id: o.id,
      subdomain: o.subdomain,
      name: o.name,
    })),
    alreadyInSync: comparison.inSync.length,
    errors,
  };

  onProgress?.({ type: "complete", result });

  return result;
}
