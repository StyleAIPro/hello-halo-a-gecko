/**
 * GitHub Skill Source Service - Aggregation Layer
 *
 * Re-exports from split modules. See individual files for implementation:
 * - github-api.ts: API infrastructure (fetch, rate limit handling)
 * - github-skill-fetch.ts: Skill discovery, fetching, listing
 * - github-skill-push.ts: Skill push via PR, repo validation, local reading
 */

// API infrastructure
export { getGitHubToken, githubFetch, githubApiFetch, GITHUB_API_BASE } from './github-api';

// Skill fetching
export {
  listRepoDirectories,
  fetchSkillFileContent,
  fetchSkillDirectoryContents,
  findSkillDirectoryPath,
  listSkillsFromRepo,
  listSkillsFromRepoStreaming,
  getSkillDetailFromRepo,
} from './github-skill-fetch';
export type {
  GitHubSkillFetchProgress,
  GitHubSkillFetchProgressCallback,
  GitHubSkillFoundCallback,
} from './github-skill-fetch';

// Skill push, validation & local reading
export { validateRepo, pushSkillAsPR, readLocalSkillContent, readLocalSkillFiles } from './github-skill-push';
