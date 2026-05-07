/**
 * Auth Module - External platform authentication and secure storage
 */

export {
  resolveGhBinary,
  isGhAvailable,
  getGitHubAuthStatus,
  loginWithBrowser,
  loginWithToken,
  logoutGitHub,
  setupGitCredentialHelper,
  setGitConfig,
  getGitConfig,
  getDirectGitHubAuthStatus,
  getCombinedGitHubAuthStatus,
  loginWithDirectToken,
  logoutDirectGitHub,
  setupGitCredentialsWithToken,
  type GitHubAuthStatus,
  type DirectGitHubAuthStatus,
  type CombinedGitHubAuthStatus,
} from './github-auth.service';

export {
  getGitCodeAuthStatus,
  loginWithGitCodeToken,
  logoutGitCode,
} from './gitcode-auth.service';

export {
  isEncryptionAvailable,
  encryptString,
  decryptString,
  encryptTokens,
  decryptTokens,
  encryptSshPassword,
  decryptSshPassword,
} from './secure-storage.service';
