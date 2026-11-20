import { runCapture, type CaptureOptions, type CaptureResult } from '../platform/capture';

export { runCapture };
export type GitResult = CaptureResult;
export type GitRunOptions = CaptureOptions;

/**
 * Run one git command in `cwd` and capture its output.
 *
 * Callers build the argument list themselves — nothing here interpolates user
 * text into a shell, and `cross-spawn` never involves one. Refs that came from
 * a chat message must still pass {@link isSafeRef} first, so a leading `-`
 * cannot turn into a flag.
 */
export async function git(
  cwd: string,
  args: readonly string[],
  opts: GitRunOptions = {},
): Promise<GitResult> {
  return runCapture('git', cwd, args, opts);
}

/**
 * Whether a string is safe to pass to git as a revision / branch name.
 *
 * The bridge accepts refs typed in chat (`/diff main`, `/worktree add fix-123`).
 * Rejecting anything that could be read as an option — or that git itself would
 * refuse — keeps a message from turning into a different git command.
 */
export function isSafeRef(ref: string): boolean {
  if (!ref || ref.length > 200) return false;
  if (ref.startsWith('-')) return false;
  if (ref.includes('..') && !/^[^.]+\.\.\.?[^.]+$/.test(ref)) return false;
  return /^[\w./@^~{}[\]*+-]+$/.test(ref);
}

/** Narrow a `T | { error }` result returned by the helpers in this directory. */
export function isGitError<T>(value: T | { error: string }): value is { error: string } {
  return typeof value === 'object' && value !== null && 'error' in value;
}
