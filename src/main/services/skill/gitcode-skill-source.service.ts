/**
 * GitCode Skill Source Service - Aggregation Layer
 *
 * Re-exports from split modules. See individual files for implementation:
 * - gitcode-api.ts: API infrastructure (concurrency, rate limiting, fetch)
 * - gitcode-skill-fetch.ts: Skill discovery, fetching, listing
 * - gitcode-skill-push.ts: Skill push via MR, repo validation
 */

// API infrastructure
export { getGitCodeToken } from './gitcode-api';
export { gitcodeFetch, gitcodeApiFetch, gitcodeAuthFetch } from './gitcode-api';
export { withConcurrency, GITCODE_API_BASE } from './gitcode-api';

// Skill fetching
export {
  fetchSkillFileContent,
  fetchSkillDirectoryContents,
  findSkillDirectoryPath,
  findSkillDirsViaContents,
  listRepoDirectories,
  listSkillsFromRepo,
  listSkillsFromRepoStreaming,
  getSkillDetailFromRepo,
} from './gitcode-skill-fetch';
export type { SkillFetchProgress, SkillFetchProgressCallback, SkillFoundCallback } from './gitcode-skill-fetch';

// Skill push & validation
export { validateRepo, pushSkillAsMR } from './gitcode-skill-push';

// Local skill reading (shared, re-exported from github module)
export { readLocalSkillContent, readLocalSkillFiles } from './github-skill-push';
