/**
 * GitCode Section Component
 *
 * Settings UI for GitCode (gitcode.com) authentication.
 * Simple token-based auth - stores PAT, validates via /user API.
 */

import { useState, useEffect, useCallback } from 'react';
import { Globe, LogOut, Loader2, Check, AlertCircle } from 'lucide-react';
import { useTranslation } from '../../i18n';
import { api } from '../../api';

interface GitCodeAuthStatus {
  authenticated: boolean;
  user: string | null;
  name: string | null;
  avatarUrl: string | null;
  error?: string;
}

export function GitCodeSection() {
  const { t } = useTranslation();

  const [authStatus, setAuthStatus] = useState<GitCodeAuthStatus | null>(null);
  const [isLoadingStatus, setIsLoadingStatus] = useState(true);

  const [token, setToken] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  const loadAuthStatus = useCallback(async () => {
    setIsLoadingStatus(true);
    try {
      const response = await api.gitcodeGetAuthStatus();
      if (response.success && response.data) {
        setAuthStatus(response.data as GitCodeAuthStatus);
      } else {
        setAuthStatus({ authenticated: false, user: null, name: null, avatarUrl: null });
      }
    } catch {
      setAuthStatus({ authenticated: false, user: null, name: null, avatarUrl: null });
    } finally {
      setIsLoadingStatus(false);
    }
  }, []);

  useEffect(() => {
    loadAuthStatus();
  }, [loadAuthStatus]);

  const handleLogin = async () => {
    if (!token.trim()) return;
    setIsLoggingIn(true);
    setLoginError(null);
    try {
      const response = await api.gitcodeLoginToken(token.trim());
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

  const handleLogout = async () => {
    try {
      await api.gitcodeLogout();
      setAuthStatus({ authenticated: false, user: null, name: null, avatarUrl: null });
    } catch {
      // Ignore
    }
  };

  return (
    <section id="gitcode" className="bg-card rounded-xl border border-border p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-medium flex items-center gap-2">
          <Globe className="w-5 h-5 text-orange-500" />
          {t('GitCode')}
        </h2>
        <button
          onClick={loadAuthStatus}
          disabled={isLoadingStatus}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {isLoadingStatus ? t('Loading...') : t('Refresh')}
        </button>
      </div>

      <div className="space-y-4">
        {/* Connection Status */}
        <div
          className={`rounded-lg p-4 ${authStatus?.authenticated ? 'bg-green-500/10 border border-green-500/30' : 'bg-secondary/50'}`}
        >
          {isLoadingStatus ? (
            <div className="flex items-center gap-3">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              <span className="text-sm text-muted-foreground">{t('Checking status...')}</span>
            </div>
          ) : authStatus?.authenticated ? (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {authStatus.avatarUrl ? (
                  <img
                    src={authStatus.avatarUrl}
                    alt={authStatus.user || ''}
                    className="w-8 h-8 rounded-full"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                ) : (
                  <div className="w-8 h-8 rounded-full bg-orange-500/20 flex items-center justify-center">
                    <Globe className="w-4 h-4 text-orange-500" />
                  </div>
                )}
                <div>
                  <div className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-green-500" />
                    <span className="font-medium text-sm">
                      {authStatus.name || authStatus.user}
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {t('Connected to {{host}}', { host: 'gitcode.com' })}
                  </span>
                </div>
              </div>
              <button
                onClick={handleLogout}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-red-500/20 text-red-500 hover:bg-red-500/30 transition-colors"
              >
                <LogOut className="w-3.5 h-3.5" />
                {t('Disconnect')}
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <Globe className="w-5 h-5 text-muted-foreground" />
              <div>
                <span className="text-sm font-medium">{t('Not Connected')}</span>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {t(
                    'Connect to GitCode to enable skill browsing and push from GitCode repositories',
                  )}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Login (when not authenticated) */}
        {!authStatus?.authenticated && !isLoadingStatus && (
          <div className="space-y-3">
            <div className="space-y-2">
              <input
                type="password"
                value={token}
                onChange={(e) => {
                  setToken(e.target.value);
                  setLoginError(null);
                }}
                placeholder={t('GitCode Personal Access Token')}
                className="w-full px-3 py-2 text-sm bg-input rounded-lg border border-border focus:border-primary focus:outline-none font-mono"
              />
              <button
                onClick={handleLogin}
                disabled={isLoggingIn || !token.trim()}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-foreground text-background hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {isLoggingIn ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {t('Connecting...')}
                  </>
                ) : (
                  <>
                    <Globe className="w-4 h-4" />
                    {t('Connect')}
                  </>
                )}
              </button>
              <p className="text-xs text-muted-foreground">
                {t(
                  'Generate a token at gitcode.com/-/profile/personal_access_tokens (needs api scope)',
                )}
              </p>
            </div>

            {/* Login Error */}
            {loginError && (
              <div className="flex items-start gap-2 text-sm text-red-500 bg-red-500/10 rounded-lg p-3">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{loginError}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
