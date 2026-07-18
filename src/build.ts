import { spawn } from "node:child_process";
import { access, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

export interface BuildProfile {
  name: string;
  description?: string;
  executable: string;
  args: string[];
  cwd?: string;
  artifactPath?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface BuildConfig {
  projectRoot: string;
  profiles: BuildProfile[];
}

export interface BuildResult {
  profile: BuildProfile;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  artifactPath?: string;
}

export class BuildCommandError extends Error {
  constructor(message: string, readonly exitCode?: number) {
    super(message);
    this.name = "BuildCommandError";
  }
}

const PROFILE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

function assertProfile(profile: unknown): BuildProfile {
  if (!profile || typeof profile !== "object") {
    throw new BuildCommandError("Each build profile must be an object");
  }
  const candidate = profile as Record<string, unknown>;
  if (typeof candidate.name !== "string" || !PROFILE_NAME_PATTERN.test(candidate.name)) {
    throw new BuildCommandError("Build profile name must use letters, numbers, dots, underscores, or dashes");
  }
  if (typeof candidate.executable !== "string" || !candidate.executable.trim()) {
    throw new BuildCommandError(`Build profile ${candidate.name} must define an executable`);
  }
  if (!Array.isArray(candidate.args) || !candidate.args.every((arg) => typeof arg === "string")) {
    throw new BuildCommandError(`Build profile ${candidate.name} args must be an array of strings`);
  }
  if (candidate.cwd !== undefined && typeof candidate.cwd !== "string") {
    throw new BuildCommandError(`Build profile ${candidate.name} cwd must be a string`);
  }
  if (candidate.artifactPath !== undefined && typeof candidate.artifactPath !== "string") {
    throw new BuildCommandError(`Build profile ${candidate.name} artifactPath must be a string`);
  }
  if (
    candidate.timeoutMs !== undefined &&
    (!Number.isInteger(candidate.timeoutMs) || (candidate.timeoutMs as number) < 1_000)
  ) {
    throw new BuildCommandError(`Build profile ${candidate.name} timeoutMs must be at least 1000`);
  }
  if (
    candidate.maxOutputBytes !== undefined &&
    (!Number.isInteger(candidate.maxOutputBytes) || (candidate.maxOutputBytes as number) < 1024)
  ) {
    throw new BuildCommandError(`Build profile ${candidate.name} maxOutputBytes must be at least 1024`);
  }

  return {
    name: candidate.name,
    description: typeof candidate.description === "string" ? candidate.description : undefined,
    executable: candidate.executable,
    args: candidate.args,
    cwd: candidate.cwd,
    artifactPath: candidate.artifactPath,
    timeoutMs: candidate.timeoutMs as number | undefined,
    maxOutputBytes: candidate.maxOutputBytes as number | undefined,
  };
}

async function resolveInside(root: string, candidatePath: string): Promise<string> {
  const resolvedRoot = await realpath(path.resolve(root));
  const resolvedPath = await realpath(path.resolve(resolvedRoot, candidatePath));
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new BuildCommandError(`Path must be inside project root: ${resolvedRoot}`);
  }
  return resolvedPath;
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function loadBuildConfig(configPath: string, fallbackProjectRoot: string): Promise<BuildConfig> {
  const raw = await readFile(configPath, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const configDir = path.dirname(configPath);
  const configuredRoot =
    typeof parsed.projectRoot === "string" && parsed.projectRoot.trim()
      ? path.resolve(configDir, parsed.projectRoot)
      : fallbackProjectRoot;
  const projectRoot = await realpath(configuredRoot);

  if (!Array.isArray(parsed.profiles)) {
    throw new BuildCommandError("Build config must define a profiles array");
  }
  const profiles = parsed.profiles.map(assertProfile);
  const names = new Set<string>();
  for (const profile of profiles) {
    if (names.has(profile.name)) {
      throw new BuildCommandError(`Duplicate build profile: ${profile.name}`);
    }
    names.add(profile.name);
  }
  return { projectRoot, profiles };
}

export class BuildRunner {
  constructor(
    private readonly projectRoot: string,
    private readonly profiles: readonly BuildProfile[]
  ) {}

  listProfiles(): readonly BuildProfile[] {
    return this.profiles;
  }

  getProfile(name: string): BuildProfile {
    const profileName = name.trim();
    if (!PROFILE_NAME_PATTERN.test(profileName)) {
      throw new BuildCommandError("Invalid build profile name");
    }
    const profile = this.profiles.find((candidate) => candidate.name === profileName);
    if (!profile) {
      throw new BuildCommandError(`Unknown build profile: ${profileName}`);
    }
    return profile;
  }

  async run(profileName: string): Promise<BuildResult> {
    const profile = this.getProfile(profileName);
    const cwd = await resolveInside(this.projectRoot, profile.cwd ?? ".");
    await stat(cwd);

    const result = await new Promise<BuildResult>((resolve, reject) => {
      const child = spawn(profile.executable, profile.args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const timeoutMs = profile.timeoutMs ?? 10 * 60_000;
      const maxOutputBytes = profile.maxOutputBytes ?? 10 * 1024 * 1024;
      let outputBytes = 0;
      let settled = false;

      const finishWithError = (error: Error) => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(error);
      };

      const timer = setTimeout(() => {
        finishWithError(new BuildCommandError(`Build timed out after ${timeoutMs} ms`));
      }, timeoutMs);

      const collect = (target: Buffer[]) => (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > maxOutputBytes) {
          finishWithError(new BuildCommandError(`Build exceeded the ${maxOutputBytes} byte output limit`));
          return;
        }
        target.push(chunk);
      };

      child.stdout.on("data", collect(stdout));
      child.stderr.on("data", collect(stderr));
      child.on("error", finishWithError);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve({
          profile,
          cwd,
          stdout: Buffer.concat(stdout).toString("utf8").trim(),
          stderr: Buffer.concat(stderr).toString("utf8").trim(),
          exitCode: code ?? -1,
        });
      });
    });

    if (result.exitCode !== 0) {
      const detail = result.stderr || result.stdout;
      throw new BuildCommandError(
        `Build ${profile.name} failed with exit code ${result.exitCode}${detail ? `: ${detail}` : ""}`,
        result.exitCode
      );
    }

    if (profile.artifactPath) {
      const artifactPath = await resolveInside(this.projectRoot, path.resolve(cwd, profile.artifactPath));
      const artifactStat = await stat(artifactPath);
      if (!artifactStat.isFile()) {
        throw new BuildCommandError(`Build artifact is not a file: ${artifactPath}`);
      }
      result.artifactPath = artifactPath;
    }

    return result;
  }
}
