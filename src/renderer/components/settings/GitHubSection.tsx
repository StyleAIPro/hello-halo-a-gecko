/**
 * GitHub Section Component
 *
 * Settings UI for GitHub authentication and git configuration.
 * Supports two modes:
 *   1. gh CLI mode (browser OAuth / PAT via gh auth login)
 *   2. Direct PAT mode (stores token in config.json, works without gh CLI)
 */

import { useState, useEffect, useCallback } from 'react';
import { Github, ExternalLink, LogOut, Loader2, Check, AlertCircle, Key } from 'lucide-react';
import { useTranslation } from '../../i18n';
import { api } from '../../api';

interface AuthStatus {
  authenticated: boolean;
  user: string | null;
  hostname: string | null;
  protocol: string | null;
  error?: string;
}

interface DirectAuthStatus {
  authenticated: boolean;
  user: string | null;
  avatarUrl: string | null;
  error?: string;
}

export function GitHubSection() {
  const { t } = useTranslation();

  // Auth state
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [isLoadingStatus, setIsLoadingStatus] = useState(true);
  const [ghAvailable, setGhAvailable] = useState<boolean | null>(null);

  // Direct PAT state
  const [directStatus, setDirectStatus] = useState<DirectAuthStatus | null>(null);

  // Login state (gh CLI)
  const [isLoggingInBrowser, setIsLoggingInBrowser] = useState(false);
  const [showTokenInput, setShowTokenInput] = useState(false);
  const [token, setToken] = useState('');
  const [isLoggingInToken, setIsLoggingInToken] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginProgress, setLoginProgress] = useState<{
    code?: string;
    url?: string;
    message: string;
  } | null>(null);

  // Direct PAT login state
  const [directToken, setDirectToken] = useState('');
  const [isDirectLoggingIn, setIsDirectLoggingIn] = useState(false);
  const [directLoginError, setDirectLoginError] = useState<string | null>(null);
  const [isConfiguringDirectCreds, setIsConfiguringDirectCreds] = useState(false);
  const [directCredMessage, setDirectCredMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  // Git config state
  const [gitUserName, setGitUserName] = useState('');
  const [gitUserEmail, setGitUserEmail] = useState('');
  const [isSavingGitConfig, setIsSavingGitConfig] = useState(false);
  const [isConfiguringCredentials, setIsConfiguringCredentials] = useState(false);
  const [gitConfigMessage, setGitConfigMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  const loadAuthStatus = useCallback(async () => {
    setIsLoadingStatus(true);
    try {
      const response = await api.githubGetAuthStatus();
      if (response.success && response.data) {
        setAuthStatus(response.data as AuthStatus);
        // If gh auth status returns an error about gh not being available, mark it unavailable
        if ((response.data as AuthStatus).error?.includes('not available')) {
          setGhAvailable(false);
        } else {
          setGhAvailable(true);
        }
      } else {
        setAuthStatus({ authenticated: false, user: null, hostname: null, protocol: null });
        // Check if the error is about gh not being available
        if (response.error?.includes('not available')) {
          setGhAvailable(false);
        }
      }
    } catch {
      setAuthStatus({ authenticated: false, user: null, hostname: null, protocol: null });
    } finally {
      setIsLoadingStatus(false);
    }
  }, []);

  const loadDirectAuthStatus = useCallback(async () => {
    try {
      const response = await api.githubDirectAuthStatus();
      if (response.success && response.data) {
        setDirectStatus(response.data as DirectAuthStatus);
      } else {
        setDirectStatus({ authenticated: false, user: null, avatarUrl: null });
      }
    } catch {
      setDirectStatus({ authenticated: false, user: null, avatarUrl: null });
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
    loadDirectAuthStatus();
    loadGitConfig();
  }, [loadAuthStatus, loadDirectAuthStatus, loadGitConfig]);

  const handleLoginBrowser = async () => {
    setIsLoggingInBrowser(true);
    setLoginError(null);
    setLoginProgress(null);

    const unsubscribe = api.onGithubLoginProgress((data) => {
      setLoginProgress(data);
    });

    try {
      const response = await api.githubLoginBrowser();
      if (response.success) {
        await loadAuthStatus();
      } else {
        setLoginError(response.error || t('Login failed'));
      }
    } catch (error: any) {
      setLoginError(error.message || t('Login failed'));
    } finally {
      setIsLoggingInBrowser(false);
      unsubscribe();
    }
  };

  const handleLoginToken = async () => {
    if (!token.trim()) return;
    setIsLoggingInToken(true);
    setLoginError(null);
    try {
      const response = await api.githubLoginToken(token.trim());
      if (response.success) {
        setToken('');
        setShowTokenInput(false);
        await loadAuthStatus();
      } else {
        setLoginError(response.error || t('Invalid token'));
      }
    } catch (error: any) {
      setLoginError(error.message || t('Login failed'));
    } finally {
      setIsLoggingInToken(false);
    }
  };

  const handleLogout = async () => {
    try {
      await api.githubLogout();
      setAuthStatus({ authenticated: false, user: null, hostname: null, protocol: null });
    } catch {
      // Ignore errors
    }
  };

  // ── Direct PAT handlers ──────────────────────────────────────────

  const handleDirectLogin = async () => {
    if (!directToken.trim()) return;
    setIsDirectLoggingIn(true);
    setDirectLoginError(null);
    try {
      const response = await api.githubDirectLoginToken(directToken.trim());
      if (response.success) {
        setDirectToken('');
        await loadDirectAuthStatus();
      } else {
        setDirectLoginError(response.error || t('Invalid token'));
      }
    } catch (error: any) {
      setDirectLoginError(error.message || t('Login failed'));
    } finally {
      setIsDirectLoggingIn(false);
    }
  };

  const handleDirectLogout = async () => {
    try {
      await api.githubDirectLogout();
      setDirectStatus({ authenticated: false, user: null, avatarUrl: null });
    } catch {
      // Ignore errors
    }
  };

  const handleDirectSetupCredentials = async () => {
    setIsConfiguringDirectCreds(true);
    setDirectCredMessage(null);
    try {
      const response = await api.githubDirectSetupCredentials();
      if (response.success) {
        setDirectCredMessage({
          type: 'success',
          text: t(
            'Git credentials configured successfully. You can now use git push/pull without entering a password.',
          ),
        });
      } else {
        setDirectCredMessage({ type: 'error', text: response.error || t('Failed to configure') });
      }
    } catch (error: any) {
      setDirectCredMessage({ type: 'error', text: error.message || t('Failed to configure') });
    } finally {
      setIsConfiguringDirectCreds(false);
    }
  };

  // ── Git config handlers ──────────────────────────────────────────

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

  const handleSetupCredentials = async () => {
    setIsConfiguringCredentials(true);
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
      setIsConfiguringCredentials(false);
    }
  };

  const isAuthenticated = authStatus?.authenticated || directStatus?.authenticated;
  const displayUser = authStatus?.authenticated
    ? authStatus.user
    : directStatus?.authenticated
      ? directStatus.user
      : null;

  return (
    <section id="github" className="bg-card rounded-xl border border-border p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-medium">{t('GitHub')}</h2>
        <button
          onClick={() => {
            loadAuthStatus();
            loadDirectAuthStatus();
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
                {directStatus?.authenticated && directStatus.avatarUrl ? (
                  <img
                    src={directStatus.avatarUrl}
                    alt={directStatus.user || ''}
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
                    {authStatus?.authenticated && (
                      <span className="text-xs text-muted-foreground bg-secondary px-1.5 py-0.5 rounded">
                        gh CLI
                      </span>
                    )}
                    {directStatus?.authenticated && (
                      <span className="text-xs text-muted-foreground bg-secondary px-1.5 py-0.5 rounded">
                        Token
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {t('Connected to {{host}}', { host: 'github.com' })}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {authStatus?.authenticated && (
                  <button
                    onClick={handleLogout}
                    className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-red-500/20 text-red-500 hover:bg-red-500/30 transition-colors"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    {t('Disconnect')}
                  </button>
                )}
                {directStatus?.authenticated && (
                  <button
                    onClick={handleDirectLogout}
                    className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-red-500/20 text-red-500 hover:bg-red-500/30 transition-colors"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    {t('Disconnect')}
                  </button>
                )}
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
            {/* ── Direct PAT Mode (always shown) ─────────────────── */}
            <div className="rounded-lg border border-border p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Key className="w-4 h-4 text-muted-foreground" />
                <h3 className="text-sm font-medium">{t('Personal Access Token')}</h3>
              </div>
              <input
                type="password"
                value={directToken}
                onChange={(e) => {
                  setDirectToken(e.target.value);
                  setDirectLoginError(null);
                }}
                placeholder="ghp_xxxxxxxxxxxx"
                className="w-full px-3 py-2 text-sm bg-input rounded-lg border border-border focus:border-primary focus:outline-none font-mono"
              />
              <button
                onClick={handleDirectLogin}
                disabled={isDirectLoggingIn || !directToken.trim()}
                className="w-full px-4 py-2 rounded-lg bg-foreground text-background hover:opacity-90 transition-opacity disabled:opacity-50 text-sm"
              >
                {isDirectLoggingIn ? (
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
              {directLoginError && (
                <div className="flex items-start gap-2 text-sm text-red-500 bg-red-500/10 rounded-lg p-3">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>{directLoginError}</span>
                </div>
              )}
            </div>

            {/* ── gh CLI Mode (collapsible, only if gh is available) ── */}
            {ghAvailable !== false && (
              <div>
                <button
                  onClick={() => {
                    setShowTokenInput(!showTokenInput);
                    setLoginError(null);
                  }}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showTokenInput ? t('Hide gh CLI options') : t('Or login via GitHub CLI')}
                </button>

                {showTokenInput && (
                  <div className="mt-3 space-y-3">
                    <button
                      onClick={handleLoginBrowser}
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

                    {loginError && (
                      <div className="flex items-start gap-2 text-sm text-red-500 bg-red-500/10 rounded-lg p-3">
                        <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                        <span>{loginError}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Direct PAT: configure git credentials */}
        {directStatus?.authenticated && (
          <div className="rounded-lg border border-border p-4 space-y-3">
            <h3 className="text-sm font-medium">{t('Git Push / Pull')}</h3>
            <p className="text-xs text-muted-foreground">
              {t(
                'Configure git to use your token for push/pull operations. This writes to ~/.git-credentials.',
              )}
            </p>
            <button
              onClick={handleDirectSetupCredentials}
              disabled={isConfiguringDirectCreds}
              className="px-4 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {isConfiguringDirectCreds ? t('Configuring...') : t('Setup Git Credentials')}
            </button>
            {directCredMessage && (
              <p
                className={`text-xs ${directCredMessage.type === 'success' ? 'text-green-500' : 'text-red-500'}`}
              >
                {directCredMessage.text}
              </p>
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

              {ghAvailable && authStatus?.authenticated && (
                <button
                  onClick={handleSetupCredentials}
                  disabled={isConfiguringCredentials}
                  className="px-4 py-2 text-sm rounded-lg bg-secondary hover:bg-secondary/80 transition-colors disabled:opacity-50"
                >
                  {isConfiguringCredentials
                    ? t('Configuring...')
                    : t('Setup Git Credential Helper (gh)')}
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
