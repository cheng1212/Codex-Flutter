import path from "node:path";
import type { WorkspaceRoot } from "../../config.js";

/**
 * Project / workspace-root validation.
 *
 * Every command that touches a working directory must pass through here:
 * the path is resolved (so `..` segments collapse) and must stay inside
 * one of the operator-configured workspace roots. This is the companion's
 * own allow-list check (matrix #14); it does not rely on Codex's `-C`.
 */

export class ProjectsService {
  constructor(private readonly roots: WorkspaceRoot[]) {}

  list(): WorkspaceRoot[] {
    return this.roots.map((r) => ({ ...r }));
  }

  findById(projectId: string): WorkspaceRoot | undefined {
    return this.roots.find((r) => r.id === projectId);
  }

  /**
   * Resolve `cwd` against `projectId` and reject anything outside the
   * root. Returns the normalized absolute path, or null with a reason.
   */
  validateCwd(projectId: string, cwd: string): { ok: true; path: string } | { ok: false; reason: string } {
    const root = this.findById(projectId);
    if (!root) return { ok: false, reason: `unknown project: ${projectId}` };
    const resolvedRoot = path.resolve(root.path);
    const resolved = path.resolve(resolvedRoot, cwd);
    if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
      return { ok: false, reason: "cwd is outside the workspace root" };
    }
    return { ok: true, path: resolved };
  }

  /** Is an already-normalized absolute path inside any configured root? */
  isInsideRoots(absPath: string): boolean {
    const resolved = path.resolve(absPath);
    return this.roots.some((r) => {
      const root = path.resolve(r.path);
      return resolved === root || resolved.startsWith(root + path.sep);
    });
  }
}
