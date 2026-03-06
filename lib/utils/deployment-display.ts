export interface DeploymentStepLike {
  id: string;
  name: string;
  status: string;
  output?: string;
  error?: string;
  durationMs?: number;
}

export interface DisplayGroup {
  label: string;
  status: "pending" | "running" | "success" | "failed" | "skipped";
  totalDurationMs?: number;
  summary: string;
  errorOutput?: string;
}

const STEP_GROUP_CONFIG: { label: string; stepNames: string[] }[] = [
  {
    label: "Preparing Environment",
    stepNames: ["Clone repository", "Stop process", "Pull latest changes", "Detect package manager", "Detect app type"],
  },
  { label: "Configuring Environment", stepNames: ["Create .env file", "Update .env file"] },
  { label: "Resolving Dependencies", stepNames: ["Install dependencies"] },
  { label: "Optimizing Production Build", stepNames: ["Build application"] },
  {
    label: "Going Live",
    stepNames: ["Start with PM2", "Add port mapping", "Reload Nginx", "Restart with PM2", "Save to database"],
  },
  { label: "Setting Up Automation", stepNames: ["Setup CI/CD"] },
];

function getGroupStatus(steps: DeploymentStepLike[]): DisplayGroup["status"] {
  if (steps.length === 0) return "pending";
  if (steps.some((s) => s.status === "failed")) return "failed";
  if (steps.some((s) => s.status === "running")) return "running";
  if (steps.every((s) => s.status === "skipped")) return "skipped";
  if (steps.every((s) => s.status === "success" || s.status === "skipped")) return "success";
  return "pending";
}

function getGroupSummary(label: string, steps: DeploymentStepLike[]): string {
  if (label === "Preparing Environment") {
    const clone = steps.find((s) => s.name === "Clone repository");
    const pull = steps.find((s) => s.name === "Pull latest changes");
    const detectPm = steps.find((s) => s.name === "Detect package manager" && s.status === "success");
    const detectApp = steps.find((s) => s.name === "Detect app type" && s.status === "success");
    const parts: string[] = [];
    if (clone?.status === "success" && clone.output) {
      const m = clone.output.match(/Commit:\s*([a-f0-9]{7,})/i);
      if (m) parts.push(`Checked out commit ${m[1].substring(0, 7)}.`);
    }
    if (pull?.status === "success" && pull.output) {
      const m = pull.output.match(/([a-f0-9]{7,40})/);
      if (m) parts.push(`Updated to commit ${m[1].substring(0, 7)}.`);
    }
    if (detectApp && detectPm) {
      const app = (detectApp.output ?? "").replace(/^Detected:\s*/i, "");
      const pm = (detectPm.output ?? "").replace(/^Using\s*/i, "");
      if (app) parts.push(`Detected ${app}${pm ? ` using ${pm}` : ""}.`);
    }
    return parts.join(" ");
  }
  if (label === "Configuring Environment") {
    const step = steps.find((s) => s.status === "success");
    if (step?.output) {
      const m = step.output.match(/(\d+)\s*variables?/i);
      if (m) return `${m[1]} environment variable${Number(m[1]) === 1 ? "" : "s"} applied.`;
    }
    return steps.some((s) => s.status === "success") ? "Environment variables applied." : "";
  }
  if (label === "Resolving Dependencies")
    return steps.some((s) => s.status === "success") ? "All packages resolved successfully." : "";
  if (label === "Optimizing Production Build")
    return steps.some((s) => s.status === "success") ? "Production bundle generated successfully." : "";
  if (label === "Going Live") {
    const portStep = steps.find((s) => s.name === "Add port mapping" && s.status === "success");
    if (portStep?.output) {
      const m = portStep.output.match(/port\s*(\d+)/i);
      if (m) return `Application started and is now live on port ${m[1]}.`;
    }
    return steps.some((s) => (s.name === "Start with PM2" || s.name === "Restart with PM2") && s.status === "success")
      ? "Application is now live."
      : "";
  }
  if (label === "Setting Up Automation") {
    const step = steps[0];
    if (step?.status === "skipped") return "Skipped.";
    if (step?.output?.includes("GitHub Actions")) return "GitHub Actions workflow configured.";
    return step?.status === "success" ? "CI/CD pipeline configured." : "";
  }
  return "";
}

export function groupStepsForDisplay(steps: DeploymentStepLike[]): DisplayGroup[] {
  const usedIds = new Set<string>();
  const groups: DisplayGroup[] = [];
  for (const config of STEP_GROUP_CONFIG) {
    const groupSteps = steps.filter((s) => config.stepNames.includes(s.name) && !usedIds.has(s.id));
    if (groupSteps.length === 0) continue;
    groupSteps.forEach((s) => usedIds.add(s.id));
    const status = getGroupStatus(groupSteps);
    const failedStep = groupSteps.find((s) => s.status === "failed");
    const totalMs = groupSteps.reduce((acc, s) => acc + (s.durationMs ?? 0), 0);
    groups.push({
      label: config.label,
      status,
      totalDurationMs: totalMs > 0 ? totalMs : undefined,
      summary: getGroupSummary(config.label, groupSteps),
      errorOutput: failedStep ? (failedStep.error ?? failedStep.output ?? undefined) : undefined,
    });
  }
  // Fallback: any ungrouped steps
  steps.filter((s) => !usedIds.has(s.id)).forEach((s) => {
    groups.push({
      label: s.name,
      status: s.status as DisplayGroup["status"],
      totalDurationMs: s.durationMs,
      summary: s.output ?? "",
      errorOutput: s.error,
    });
  });
  return groups;
}

export function isRedeployment(steps: DeploymentStepLike[]): boolean {
  return steps.some((s) => s.name === "Pull latest changes" || s.name === "Stop process");
}
