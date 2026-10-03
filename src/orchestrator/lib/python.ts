import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { z } from "zod";
import { paths } from "./config.js";

export interface PythonJsonOptions<T> {
  /** Project-relative or absolute path to the .py script. */
  script: string;
  args?: readonly string[];
  /** Serialized to JSON and written to the child's stdin (stdin is closed either way). */
  stdin?: unknown;
  timeoutMs?: number;
  /** Validates the parsed stdout object. */
  schema: z.ZodType<T>;
  /** Receives each stderr line as it arrives (the script's logs). */
  onStderrLine?: (line: string) => void;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const STDERR_TAIL_CHARS = 4000;

export function resolvePythonExecutable(): string {
  const venvPython =
    process.platform === "win32"
      ? paths.fromRoot(".venv", "Scripts", "python.exe")
      : paths.fromRoot(".venv", "bin", "python");
  return existsSync(venvPython) ? venvPython : "python";
}

interface ProcessOutput {
  stdout: string;
  stderr: string;
}

/**
 * Runs a Python script that prints exactly one JSON object on stdout. Spawns the interpreter directly
 * (no shell) so paths with spaces need no quoting on Windows.
 */
export async function runPythonJson<T>(options: PythonJsonOptions<T>): Promise<T> {
  const scriptPath = paths.fromRoot(options.script);
  if (!existsSync(scriptPath)) throw new Error(`Python script not found: ${scriptPath}`);
  const output = await spawnPython(scriptPath, options);
  return parseJsonOutput(output, scriptPath, options.schema);
}

function spawnPython<T>(scriptPath: string, options: PythonJsonOptions<T>): Promise<ProcessOutput> {
  const exe = resolvePythonExecutable();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(exe, ["-X", "utf8", scriptPath, ...(options.args ?? [])], {
      cwd: paths.root,
      shell: false,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", PYTHONUNBUFFERED: "1" },
    });
    let stdout = "";
    let stderr = "";
    let stderrPartial = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
      stderrPartial += chunk;
      const lines = stderrPartial.split(/\r?\n/);
      stderrPartial = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) options.onStderrLine?.(line);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Failed to start Python (${exe}): ${error.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (stderrPartial.trim()) options.onStderrLine?.(stderrPartial);
      const label = `${scriptPath} (${exe})`;
      if (timedOut) return reject(new Error(`Python timed out after ${timeoutMs} ms: ${label}${stderrTail(stderr)}`));
      if (code !== 0) {
        return reject(new Error(`Python exited with ${code ?? signal}: ${label}${stderrTail(stderr)}`));
      }
      resolvePromise({ stdout, stderr });
    });

    child.stdin.on("error", () => {
      // EPIPE if the script exits without reading stdin; the exit code tells the real story.
    });
    child.stdin.end(options.stdin === undefined ? undefined : JSON.stringify(options.stdin), "utf8");
  });
}

function parseJsonOutput<T>(output: ProcessOutput, scriptPath: string, schema: z.ZodType<T>): T {
  const parsed = extractJsonObject(output.stdout);
  if (parsed === undefined) {
    throw new Error(
      `Python script did not print a JSON object on stdout: ${scriptPath}\nstdout: ${output.stdout.slice(0, 1000)}${stderrTail(output.stderr)}`,
    );
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Unexpected JSON shape from ${scriptPath}:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** Whole stdout first; falls back to the last line that parses (tolerates stray prints from libraries). */
export function extractJsonObject(stdout: string): unknown {
  const candidates = [stdout.trim(), ...stdout.trim().split(/\r?\n/).reverse()];
  for (const candidate of candidates) {
    const text = candidate.trim();
    if (!text.startsWith("{")) continue;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // Not valid JSON; try the next candidate.
    }
  }
  return undefined;
}

function stderrTail(stderr: string): string {
  const trimmed = stderr.trim();
  if (!trimmed) return "";
  const tail = trimmed.length > STDERR_TAIL_CHARS ? `...${trimmed.slice(-STDERR_TAIL_CHARS)}` : trimmed;
  return `\n--- stderr ---\n${tail}`;
}
