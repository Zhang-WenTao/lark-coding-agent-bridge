import { describeRepoStatus, readRepoStatus } from '../../git/status';

/**
 * Git summary for the `/status` card. Silent when the cwd is not a repository
 * (or git is missing) — `/status` must stay useful for non-code workspaces.
 */
export async function gitStatusLine(cwd: string | undefined): Promise<{ git?: string }> {
  if (!cwd) return {};
  const status = await readRepoStatus(cwd).catch(() => undefined);
  return status ? { git: describeRepoStatus(status) } : {};
}
