import { mergeProcessEnv, spawnProcess } from './spawn';

export interface CaptureResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  /** True when stdout hit {@link CaptureOptions.maxBytes} and was cut short. */
  truncated: boolean;
}

export interface CaptureOptions {
  timeoutMs?: number;
  /** Cap on captured stdout. A `git diff` on a big branch can be megabytes. */
  maxBytes?: number;
  /** Extra environment for the command (cannot override the non-interactive settings below). */
  env?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Run a command in `cwd` and capture its output under the same caps and
 * non-interactive environment git gets. Shared with the `gh` calls behind
 * `/pr`, which have exactly the same "must never block on a prompt" need.
 */
export async function runCapture(
  command: string,
  cwd: string,
  args: readonly string[],
  opts: CaptureOptions = {},
): Promise<CaptureResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  let stderr = '';
  let timedOut = false;

  const code = await new Promise<number | null>((resolve) => {
    const child = spawnProcess(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: mergeProcessEnv(process.env, {
        ...(opts.env ?? {}),
        // Deterministic, non-interactive output: no pager to block on, no
        // credential prompt to hang on, and English messages we can parse.
        GIT_PAGER: 'cat',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        LC_ALL: 'C',
      }),
    });
    child.stdout?.on('data', (buf: Buffer) => {
      if (size >= maxBytes) {
        truncated = true;
        return;
      }
      const room = maxBytes - size;
      if (buf.length > room) {
        chunks.push(buf.subarray(0, room));
        size = maxBytes;
        truncated = true;
        return;
      }
      chunks.push(buf);
      size += buf.length;
    });
    child.stderr?.on('data', (buf: Buffer) => {
      if (stderr.length < 8192) stderr += buf.toString('utf8');
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.once('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once('close', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });

  return {
    ok: !timedOut && code === 0,
    stdout: Buffer.concat(chunks).toString('utf8'),
    stderr: stderr.trim(),
    code,
    timedOut,
    truncated,
  };
}
