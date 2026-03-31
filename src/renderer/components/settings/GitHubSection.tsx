/**
 * GitHub Section Component
 *
 * Settings UI for GitHub CLI authentication and git configuration.
 * Self-contained - manages its own state via IPC calls.
 */

import { useState, useEffect, useCallback } from 'react'
import { Github, ExternalLink, LogOut, Loader2, Check, AlertCircle } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { api } from '../../api'

interface AuthStatus {
  authenticated: boolean
  user: string | null
  hostname: string | null
  protocol: string | null
  error?: string
}

export function GitHubSection() {
  const { t } = useTranslation()

  // Auth state
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null)
  const [isLoadingStatus, setIsLoadingStatus] = useState(true)

  // Login state
  const [isLoggingInBrowser, setIsLoggingInBrowser] = useState(false)
  const [showTokenInput, setShowTokenInput] = useState(false)
  const [token, setToken] = useState('')
  const [isLoggingInToken, setIsLoggingInToken] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)
  const [loginProgress, setLoginProgress] = useState<{ code?: string; url?: string; message: string } | null>(null)

  // Git config state
  const [gitUserName, setGitUserName] = useState('')
  const [gitUserEmail, setGitUserEmail] = useState('')
  const [isSavingGitConfig, setIsSavingGitConfig] = useState(false)
  const [isConfiguringCredentials, setIsConfiguringCredentials] = useState(false)
  const [gitConfigMessage, setGitConfigMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const loadAuthStatus = useCallback(async () => {
    setIsLoadingStatus(true)
    try {
      const response = await api.githubGetAuthStatus()
      if (response.success && response.data) {
        setAuthStatus(response.data as AuthStatus)
      } else {
        setAuthStatus({ authenticated: false, user: null, hostname: null, protocol: null })
      }
    } catch {
      setAuthStatus({ authenticated: false, user: null, hostname: null, protocol: null })
    } finally {
      setIsLoadingStatus(false)
    }
  }, [])

  const loadGitConfig = useCallback(async () => {
    try {
      const [nameRes, emailRes] = await Promise.all([
        api.githubGetGitConfig('user.name'),
        api.githubGetGitConfig('user.email')
      ])
      if (nameRes.success && nameRes.data) {
        setGitUserName(nameRes.data as string)
      }
      if (emailRes.success && emailRes.data) {
        setGitUserEmail(emailRes.data as string)
      }
    } catch {
      // Git may not be installed, that's fine
    }
  }, [])

  useEffect(() => {
    loadAuthStatus()
    loadGitConfig()
  }, [loadAuthStatus, loadGitConfig])

  const handleLoginBrowser = async () => {
    setIsLoggingInBrowser(true)
    setLoginError(null)
    setLoginProgress(null)

    // Listen for progress events (one-time code, URL, status messages)
    const unsubscribe = api.onGithubLoginProgress((data) => {
      setLoginProgress(data)
    })

    try {
      const response = await api.githubLoginBrowser()
      if (response.success) {
        await loadAuthStatus()
      } else {
        setLoginError(response.error || t('Login failed'))
      }
    } catch (error: any) {
      setLoginError(error.message || t('Login failed'))
    } finally {
      setIsLoggingInBrowser(false)
      unsubscribe()
    }
  }

  const handleLoginToken = async () => {
    if (!token.trim()) return
    setIsLoggingInToken(true)
    setLoginError(null)
    try {
      const response = await api.githubLoginToken(token.trim())
      if (response.success) {
        setToken('')
        setShowTokenInput(false)
        await loadAuthStatus()
      } else {
        setLoginError(response.error || t('Invalid token'))
      }
    } catch (error: any) {
      setLoginError(error.message || t('Login failed'))
    } finally {
      setIsLoggingInToken(false)
    }
  }

  const handleLogout = async () => {
    try {
      await api.githubLogout()
      setAuthStatus({ authenticated: false, user: null, hostname: null, protocol: null })
    } catch {
      // Ignore errors
    }
  }

  const handleSaveGitConfig = async () => {
    setIsSavingGitConfig(true)
    setGitConfigMessage(null)
    try {
      if (gitUserName.trim()) {
        await api.githubGitConfig('user.name', gitUserName.trim())
      }
      if (gitUserEmail.trim()) {
        await api.githubGitConfig('user.email', gitUserEmail.trim())
      }
      setGitConfigMessage({ type: 'success', text: t('Saved') })
      setTimeout(() => setGitConfigMessage(null), 3000)
    } catch (error: any) {
      setGitConfigMessage({ type: 'error', text: error.message || t('Failed to save') })
    } finally {
      setIsSavingGitConfig(false)
    }
  }

  const handleSetupCredentials = async () => {
    setIsConfiguringCredentials(true)
    setGitConfigMessage(null)
    try {
      const response = await api.githubSetupGitCredentials()
      if (response.success) {
        setGitConfigMessage({ type: 'success', text: t('Credential helper configured') })
        setTimeout(() => setGitConfigMessage(null), 3000)
      } else {
        setGitConfigMessage({ type: 'error', text: response.error || t('Failed to configure') })
      }
    } catch (error: any) {
      setGitConfigMessage({ type: 'error', text: error.message || t('Failed to configure') })
    } finally {
      setIsConfiguringCredentials(false)
    }
  }

  return (
    <section id="github" className="bg-card rounded-xl border border-border p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-medium">{t('GitHub')}</h2>
        <button
          onClick={() => { loadAuthStatus(); loadGitConfig() }}
          disabled={isLoadingStatus}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {isLoadingStatus ? t('Loading...') : t('Refresh')}
        </button>
      </div>

      {/* Connection Status */}
      <div className="space-y-4">
        <div className={`rounded-lg p-4 ${authStatus?.authenticated ? 'bg-green-500/10 border border-green-500/30' : 'bg-secondary/50'}`}>
          {isLoadingStatus ? (
            <div className="flex items-center gap-3">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              <span className="text-sm text-muted-foreground">{t('Checking status...')}</span>
            </div>
          ) : authStatus?.authenticated ? (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <img
                  src={`https://github.com/${authStatus.user}.png`}
                  alt={authStatus.user || ''}
                  className="w-8 h-8 rounded-full"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none'
                  }}
                />
                <div>
                  <div className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-green-500" />
                    <span className="font-medium text-sm">{authStatus.user}</span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {t('Connected to {{host}}', { host: authStatus.hostname || 'github.com' })}
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
        {!authStatus?.authenticated && !isLoadingStatus && (
          <div className="space-y-3">
            {/* Browser Login */}
            <button
              onClick={handleLoginBrowser}
              disabled={isLoggingInBrowser}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-foreground text-background hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {isLoggingInBrowser ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {t('Waiting for browser login...')}
                </>
              ) : (
                <>
                  <ExternalLink className="w-4 h-4" />
                  {t('Login with Browser')}
                </>
              )}
            </button>

            {/* Browser login hint */}
            {isLoggingInBrowser && (
              <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-4">
                <div className="flex items-start gap-2">
                  <Loader2 className="w-4 h-4 animate-spin text-blue-500 mt-0.5 shrink-0" />
                  <div>
                    {loginProgress?.code ? (
                      <>
                        <p className="text-sm text-blue-500 font-medium">{t('Enter this code in your browser:')}</p>
                        <p className="text-2xl font-mono font-bold text-foreground mt-2 tracking-widest">{loginProgress.code}</p>
                        <p className="text-xs text-muted-foreground mt-2">
                          {t('A browser page should have opened. Paste the code there to authenticate.')}
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="text-sm text-blue-500 font-medium">{t('Browser should be opening...')}</p>
                        <p className="text-xs text-muted-foreground mt-1">
                          {t('Complete the login in your browser. This page will update automatically when done.')}
                        </p>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Token Login Toggle */}
            <div>
              <button
                onClick={() => { setShowTokenInput(!showTokenInput); setLoginError(null) }}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {showTokenInput ? t('Hide token input') : t('Or login with Personal Access Token')}
              </button>

              {showTokenInput && (
                <div className="mt-3 space-y-2">
                  <input
                    type="password"
                    value={token}
                    onChange={(e) => { setToken(e.target.value); setLoginError(null) }}
                    placeholder={t('ghp_xxxxxxxxxxxx')}
                    className="w-full px-3 py-2 text-sm bg-input rounded-lg border border-border focus:border-primary focus:outline-none font-mono"
                  />
                  <button
                    onClick={handleLoginToken}
                    disabled={isLoggingInToken || !token.trim()}
                    className="w-full px-4 py-2 rounded-lg bg-secondary text-sm hover:bg-secondary/80 transition-colors disabled:opacity-50"
                  >
                    {isLoggingInToken ? t('Connecting...') : t('Connect')}
                  </button>
                  <p className="text-xs text-muted-foreground">
                    {t('Generate a token at github.com/settings/tokens (needs repo, read:org scopes)')}
                  </p>
                </div>
              )}
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
                className="px-4 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                {isSavingGitConfig ? t('Saving...') : t('Save')}
              </button>

              <button
                onClick={handleSetupCredentials}
                disabled={isConfiguringCredentials || !authStatus?.authenticated}
                className="px-4 py-2 text-sm rounded-lg bg-secondary hover:bg-secondary/80 transition-colors disabled:opacity-50"
                title={!authStatus?.authenticated ? t('Connect to GitHub first') : undefined}
              >
                {isConfiguringCredentials ? t('Configuring...') : t('Setup Git Credential Helper')}
              </button>
            </div>

            {gitConfigMessage && (
              <p className={`text-xs ${gitConfigMessage.type === 'success' ? 'text-green-500' : 'text-red-500'}`}>
                {gitConfigMessage.text}
              </p>
            )}

            <p className="text-xs text-muted-foreground">
              {t('These settings are used for git commit author info. The credential helper allows git push/pull without entering passwords.')}
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
