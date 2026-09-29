/**
 * Config normalization for the visual-memory hook plugin.
 *
 * All values come from `api.pluginConfig` (validated against the manifest
 * configSchema). This module applies the documented defaults and keeps a
 * single normalized shape the rest of the plugin can rely on.
 */

export interface VmCheckConfig {
  /** Master switch; false disables the hook entirely. */
  enabled: boolean;
  /** Workspace that contains scripts/visual-memory (vm.py tool repository). */
  workspaceDir: string;
  /** vm.py relative to workspaceDir. */
  vmScriptRelPath: string;
  /** Python interpreter relative to workspaceDir. */
  venvRelPath: string;
  /** Hard timeout for one vm.py check invocation. */
  checkTimeoutMs: number;
  /** Skip images larger than this (bytes). */
  maxImageSizeBytes: number;
  /** Skip images whose mtime is older than this (ms). */
  maxImageAgeMs: number;
  /** TTL for the next-turn injection. */
  injectionTtlMs: number;
  /** Delay before the single staging-pending retry probes originalMedia. */
  stagingRetryMs: number;
  /** Managed media store root (media://inbound aliases resolve here). */
  mediaDir: string;
  /** Decision-path diagnostic log file (metadata only, size-capped). */
  diagLogPath: string;
}

/** Derive the OpenClaw workspace from $HOME so no personal paths are hardcoded. */
function defaultWorkspaceDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
  return `${home.replace(/\/+$/, "")}/.openclaw/workspace`;
}

/** Default diagnostic log: OpenClaw state/logs dir under the host user home. */
function defaultDiagLogPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
  return `${home.replace(/\/+$/, "")}/.openclaw/logs/visual-memory-hook.log`;
}

/** Default media store: OpenClaw state dir under the host user home. */
function defaultMediaDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
  return `${home.replace(/\/+$/, "")}/.openclaw/media`;
}

export const DEFAULT_CONFIG: VmCheckConfig = {
  enabled: true,
  workspaceDir: defaultWorkspaceDir(),
  vmScriptRelPath: "scripts/visual-memory/vm.py",
  venvRelPath: "scripts/visual-memory/venv/bin/python",
  checkTimeoutMs: 30_000,
  maxImageSizeBytes: 20 * 1024 * 1024,
  maxImageAgeMs: 15 * 60 * 1000,
  injectionTtlMs: 120_000,
  stagingRetryMs: 5_000,
  mediaDir: defaultMediaDir(),
  diagLogPath: defaultDiagLogPath(),
};

/** Merge raw pluginConfig (possibly undefined/empty) over the defaults. */
export function normalizeConfig(raw: Record<string, unknown> | undefined): VmCheckConfig {
  const pick = <T>(key: keyof VmCheckConfig): T | undefined => {
    const value = raw?.[key as string];
    return value === undefined ? undefined : (value as T);
  };
  return {
    enabled: pick<boolean>("enabled") ?? DEFAULT_CONFIG.enabled,
    workspaceDir: pick<string>("workspaceDir") ?? DEFAULT_CONFIG.workspaceDir,
    vmScriptRelPath: pick<string>("vmScriptRelPath") ?? DEFAULT_CONFIG.vmScriptRelPath,
    venvRelPath: pick<string>("venvRelPath") ?? DEFAULT_CONFIG.venvRelPath,
    checkTimeoutMs: pick<number>("checkTimeoutMs") ?? DEFAULT_CONFIG.checkTimeoutMs,
    maxImageSizeBytes: pick<number>("maxImageSizeBytes") ?? DEFAULT_CONFIG.maxImageSizeBytes,
    maxImageAgeMs: pick<number>("maxImageAgeMs") ?? DEFAULT_CONFIG.maxImageAgeMs,
    injectionTtlMs: pick<number>("injectionTtlMs") ?? DEFAULT_CONFIG.injectionTtlMs,
    stagingRetryMs: pick<number>("stagingRetryMs") ?? DEFAULT_CONFIG.stagingRetryMs,
    mediaDir: pick<string>("mediaDir") ?? DEFAULT_CONFIG.mediaDir,
    diagLogPath: pick<string>("diagLogPath") ?? DEFAULT_CONFIG.diagLogPath,
  };
}
