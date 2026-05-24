import path from "node:path";
import type { ApprovalRequest, PermissionProfile, RiskLevel, RiskSignal } from "../core";

export const defaultPermissionProfile: PermissionProfile = {
  id: "permission_default" as PermissionProfile["id"],
  name: "Workspace guarded",
  commandPolicy: "ask",
  fileWritePolicy: "workspace_only",
  networkPolicy: "ask",
  externalToolPolicy: "ask",
  maxRiskWithoutApproval: "low"
};

export class PolicyService {
  requiresApproval(input: { risk: RiskLevel; profile?: PermissionProfile }): boolean {
    const profile = input.profile ?? defaultPermissionProfile;
    if (input.risk === "unknown") return true;
    return riskRank(input.risk) > riskRank(profile.maxRiskWithoutApproval);
  }

  riskSignalsForFile(rootPath: string, targetPath: string): RiskSignal[] {
    const resolvedRoot = path.resolve(rootPath);
    const resolvedTarget = path.resolve(rootPath, targetPath);
    const signals: RiskSignal[] = [];
    if (!resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`) && resolvedTarget !== resolvedRoot) {
      signals.push("writes_outside_workspace");
    }
    if (targetPath.includes(".env") || targetPath.includes("secret")) {
      signals.push("reads_secret_like_file");
    }
    if (targetPath.includes(".github/workflows")) {
      signals.push("touches_ci_config");
    }
    if (targetPath.endsWith("package-lock.json") || targetPath.endsWith("pnpm-lock.yaml") || targetPath.endsWith("yarn.lock")) {
      signals.push("touches_dependency_lockfile");
    }
    return signals;
  }

  approvalIsSafeToAutoAccept(_approval: ApprovalRequest): false {
    return false;
  }
}

function riskRank(risk: RiskLevel): number {
  return {
    low: 1,
    medium: 2,
    high: 3,
    critical: 4,
    unknown: 5
  }[risk];
}
