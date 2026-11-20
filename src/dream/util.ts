/**
 * The repository a target writes to: a batch may have several targets in one
 * repository (`knowledge:deep`, `skills:<lib>:update`), each under its own key.
 */
export function baseRepo(repo: string): string {
  return repo === 'knowledge' || repo.startsWith('knowledge:') ? 'knowledge' : repo.replace(/:update$/, '');
}
