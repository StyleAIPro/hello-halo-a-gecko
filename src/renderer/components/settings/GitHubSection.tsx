/**
 * GitHub Section Component
 *
 * Settings UI for GitHub authentication and git configuration.
 * PAT (Personal Access Token) is the primary and only required auth method.
 * gh CLI is optional — only shown when available, used for git credential helper.
 */

import { useState, useEffect, useCallback } from 'react';
import { Github, ExternalLink, LogOut, Loader2, Check, AlertCircle, Key } from 'lucide-react';
import { useTranslation } from '../../i18n';
import { api } from '../../api';

// ── Types ──────────────────────────────────────────────────────────────

interface PatAuthStatus {
  authenticated: boolean;
  user: string | null;
  avatarUrl: string | null;
  error?: string;
}

interface GhCliAuthStatus {
  available: boolean;
  authenticated: boolean;
  user: string | null;
  hostname: string | null;
  protocol: string | null;
}

interface CombinedAuthStatus {
  pat: PatAuthStatus;
  ghCli: GhCliAuthStatus;
}

// ── Component ──────────────────────────────────────────────────────────

export function GitHubSection() {
  const { t } = useTranslation();

  // Auth state (combined)
  const [authStatus, setAuthStatus] = useState<CombinedAuthStatus | null>(null);
  const [isLoadingStatus, setIsLoadingStatus] = useState(true);

  // PAT login state
  const [token, setToken] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  // gh CLI login state
  const [showGhCliOptions, setShowGhCliOptions] = useState(false);
  const [isLoggingInBrowser, setIsLoggingInBrowser] = useState(false);
  const [loginProgress, setLoginProgress] = useState<{
    code?: string;
    url?: string;
    message: string;
  } | null>(null);
  const [ghCliLoginError, setGhCliLoginError] = useState<string | null>(null);

  // Git config state
  const [gitUserName, setGitUserName] = useState('');
  const [gitUserEmail, setGitUserEmail] = useState('');
  const [isSavingGitConfig, setIsSavingGitConfig] = useState(false);
  const [gitConfigMessage, setGitConfigMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  // ── Loaders ────────────────────────────────────────────────────────

  const loadAuthStatus = useCallback(async () => {
    setIsLoadingStatus(true);
    try {
      const response = await api.githubGetAuthStatusCombined();
      if (response.success && response.data) {
        setAuthStatus(response.data as CombinedAuthStatus);
      } else {
        setAuthStatus({
          pat: { authenticated: false, user: null, avatarUrl: null },
          ghCli: {
            available: false,
            authenticated: false,
            user: null,
            hostname: null,
            protocol: null,
          },
        });
      }
    } catch {
      setAuthStatus({
        pat: { authenticated: false, user: null, avatarUrl: null },
        ghCli: {
          available: false,
          authenticated: false,
          user: null,
          hostname: null,
          protocol: null,
        },
      });
    } finally {
      setIsLoadingStatus(false);
    }
  }, []);

  const loadGitConfig = useCallback(async () => {
    try {
      const [nameRes, emailRes] = await Promise.all([
        api.githubGetGitConfig('user.name'),
        api.githubGetGitConfig('user.email'),
      ]);
      if (nameRes.success && nameRes.data) {
        setGitUserName(nameRes.data as string);
      }
      if (emailRes.success && emailRes.data) {
        setGitUserEmail(emailRes.data as string);
      }
    } catch {
      // Git may not be installed, that's fine
    }
  }, []);

  useEffect(() => {
    loadAuthStatus();
    loadGitConfig();
  }, [loadAuthStatus, loadGitConfig]);

  // ── PAT handlers ───────────────────────────────────────────────────

  const handlePatLogin = async () => {
    if (!token.trim()) return;
    setIsLoggingIn(true);
    setLoginError(null);
    try {
      const response = await api.githubDirectLoginToken(token.trim());
      if (response.success) {
        setToken('');
        await loadAuthStatus();
      } else {
        setLoginError(response.error || t('Invalid token'));
      }
    } catch (error: any) {
      setLoginError(error.message || t('Login failed'));
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handlePatLogout = async () => {
    try {
      await api.githubDirectLogout();
      await loadAuthStatus();
    } catch {
      // Ignore errors
    }
  };

  // ── gh CLI handlers ────────────────────────────────────────────────

  const handleGhCliLogin = async () => {
    setIsLoggingInBrowser(true);
    setGhCliLoginError(null);
    setLoginProgress(null);

    const unsubscribe = api.onGithubLoginProgress((data) => {
      setLoginProgress(data);
    });

    try {
      const response = await api.githubLoginBrowser();
      if (!response.success) {
        setGhCliLoginError(response.error || t('Login failed'));
      }
      await loadAuthStatus();
    } catch (error: any) {
      setGhCliLoginError(error.message || t('Login failed'));
    } finally {
      setIsLoggingInBrowser(false);
      unsubscribe();
    }
  };

  // ── Git config handlers ───────────────────────────────────────────

  const handleSaveGitConfig = async () => {
    setIsSavingGitConfig(true);
    setGitConfigMessage(null);
    try {
      if (gitUserName.trim()) {
        await api.githubGitConfig('user.name', gitUserName.trim());
      }
      if (gitUserEmail.trim()) {
        await api.githubGitConfig('user.email', gitUserEmail.trim());
      }
      setGitConfigMessage({ type: 'success', text: t('Saved') });
      setTimeout(() => setGitConfigMessage(null), 3000);
    } catch (error: any) {
      setGitConfigMessage({ type: 'error', text: error.message || t('Failed to save') });
    } finally {
      setIsSavingGitConfig(false);
    }
  };

  const handleSetupGhCliCredentials = async () => {
    setIsSavingGitConfig(true);
    setGitConfigMessage(null);
    try {
      const response = await api.githubSetupGitCredentials();
      if (response.success) {
        setGitConfigMessage({ type: 'success', text: t('Credential helper configured') });
        setTimeout(() => setGitConfigMessage(null), 3000);
      } else {
        setGitConfigMessage({ type: 'error', text: response.error || t('Failed to configure') });
      }
    } catch (error: any) {
      setGitConfigMessage({ type: 'error', text: error.message || t('Failed to configure') });
    } finally {
      setIsSavingGitConfig(false);
    }
  };

  // ── Derived state ─────────────────────────────────────────────────

  const isAuthenticated = authStatus?.pat?.authenticated ?? false;
  const displayUser = authStatus?.pat?.user ?? null;
  const ghCliAvailable = authStatus?.ghCli?.available ?? false;

  return (
    <section id="github" className="bg-card rounded-xl border border-border p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-medium">{t('GitHub')}</h2>
        <button
          onClick={() => {
            loadAuthStatus();
            loadGitConfig();
          }}
          disabled={isLoadingStatus}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {isLoadingStatus ? t('Loading...') : t('Refresh')}
        </button>
      </div>

      <div className="space-y-4">
        {/* Connection Status */}
        <div
          className={`rounded-lg p-4 ${isAuthenticated ? 'bg-green-500/10 border border-green-500/30' : 'bg-secondary/50'}`}
        >
          {isLoadingStatus ? (
            <div className="flex items-center gap-3">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              <span className="text-sm text-muted-foreground">{t('Checking status...')}</span>
            </div>
          ) : isAuthenticated ? (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {authStatus?.pat?.avatarUrl ? (
                  <img
                    src={authStatus.pat.avatarUrl}
                    alt={displayUser || ''}
                    className="w-8 h-8 rounded-full"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                ) : (
                  <div className="w-8 h-8 rounded-full bg-green-500/20 flex items-center justify-center">
                    <Check className="w-4 h-4 text-green-500" />
                  </div>
                )}
                <div>
                  <div className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-green-500" />
                    <span className="font-medium text-sm">{displayUser}</span>
                    {authStatus?.ghCli?.authenticated && (
                      <span className="text-xs text-muted-foreground bg-secondary px-1.5 py-0.5 rounded">
                        gh CLI
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {t('Connected to {{host}}', { host: 'github.com' })}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handlePatLogout}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-red-500/20 text-red-500 hover:bg-red-500/30 transition-colors"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  {t('Disconnect')}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <Github className="w-5 h-5 text-muted-foreground" />
              <div>
                <span className="text-sm font-medium">{t('Not Connected')}</span>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {t('Connect to GitHub to enable search, clone, and push operations')}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Login Actions (when not authenticated) */}
        {!isAuthenticated && !isLoadingStatus && (
          <div className="space-y-3">
            {/* PAT Login (primary) */}
            <div className="rounded-lg border border-border p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Key className="w-4 h-4 text-muted-foreground" />
                <h3 className="text-sm font-medium">{t('Personal Access Token')}</h3>
              </div>
              <input
                type="password"
                value={token}
                onChange={(e) => {
                  setToken(e.target.value);
                  setLoginError(null);
                }}
                placeholder="ghp_xxxxxxxxxxxx"
                className="w-full px-3 py-2 text-sm bg-input rounded-lg border border-border focus:border-primary focus:outline-none font-mono"
              />
              <button
                onClick={handlePatLogin}
                disabled={isLoggingIn || !token.trim()}
                className="w-full px-4 py-2 rounded-lg bg-foreground text-background hover:opacity-90 transition-opacity disabled:opacity-50 text-sm"
              >
                {isLoggingIn ? (
                  <span className="flex items-center justify-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {t('Connecting...')}
                  </span>
                ) : (
                  t('Connect')
                )}
              </button>
              <p className="text-xs text-muted-foreground">
                {t('Generate a token at github.com/settings/tokens (needs repo scope)')}
              </p>
              {loginError && (
                <div className="flex items-start gap-2 text-sm text-red-500 bg-red-500/10 rounded-lg p-3">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>{loginError}</span>
                </div>
              )}
            </div>

            {/* gh CLI Login (optional, only if available) */}
            {ghCliAvailable && (
              <div>
                <button
                  onClick={() => {
                    setShowGhCliOptions(!showGhCliOptions);
                    setGhCliLoginError(null);
                  }}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showGhCliOptions ? t('Hide GitHub CLI options') : t('Or login via GitHub CLI')}
                </button>

                {showGhCliOptions && (
                  <div className="mt-3 space-y-3">
                    <button
                      onClick={handleGhCliLogin}
                      disabled={isLoggingInBrowser}
                      className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-secondary text-sm hover:bg-secondary/80 transition-colors disabled:opacity-50"
                    >
                      {isLoggingInBrowser ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          {t('Waiting for browser login...')}
                        </>
                      ) : (
                        <>
                          <ExternalLink className="w-4 h-4" />
                          {t('Login with Browser (gh CLI)')}
                        </>
                      )}
                    </button>

                    {isLoggingInBrowser && loginProgress?.code && (
                      <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-4">
                        <p className="text-sm text-blue-500 font-medium">
                          {t('Enter this code in your browser:')}
                        </p>
                        <p className="text-2xl font-mono font-bold text-foreground mt-2 tracking-widest">
                          {loginProgress.code}
                        </p>
                      </div>
                    )}

                    {ghCliLoginError && (
                      <div className="flex items-start gap-2 text-sm text-red-500 bg-red-500/10 rounded-lg p-3">
                        <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                        <span>{ghCliLoginError}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Git Configuration */}
        <div className="pt-4 border-t border-border space-y-4">
          <h3 className="text-sm font-medium">{t('Git Configuration')}</h3>

          <div className="space-y-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">{t('User Name')}</label>
              <input
                type="text"
                value={gitUserName}
                onChange={(e) => setGitUserName(e.target.value)}
                placeholder={t('Your name')}
                className="w-full px-3 py-2 text-sm bg-input rounded-lg border border-border focus:border-primary focus:outline-none"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">{t('Email')}</label>
              <input
                type="email"
                value={gitUserEmail}
                onChange={(e) => setGitUserEmail(e.target.value)}
                placeholder={t('your@email.com')}
                className="w-full px-3 py-2 text-sm bg-input rounded-lg border border-border focus:border-primary focus:outline-none"
              />
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={handleSaveGitConfig}
                disabled={isSavingGitConfig}
                className="px-4 py-2 text-sm rounded-lg bg-secondary hover:bg-secondary/80 transition-colors disabled:opacity-50"
              >
                {isSavingGitConfig ? t('Saving...') : t('Save')}
              </button>

              {ghCliAvailable && authStatus?.ghCli?.authenticated && (
                <button
                  onClick={handleSetupGhCliCredentials}
                  disabled={isSavingGitConfig}
                  className="px-4 py-2 text-sm rounded-lg bg-secondary hover:bg-secondary/80 transition-colors disabled:opacity-50"
                >
                  {isSavingGitConfig ? t('Configuring...') : t('Setup Git Credential Helper (gh)')}
                </button>
              )}
            </div>

            {gitConfigMessage && (
              <p
                className={`text-xs ${gitConfigMessage.type === 'success' ? 'text-green-500' : 'text-red-500'}`}
              >
                {gitConfigMessage.text}
              </p>
            )}

            <p className="text-xs text-muted-foreground">
              {t('These settings are used for git commit author info.')}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
