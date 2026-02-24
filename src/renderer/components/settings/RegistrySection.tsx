/**
 * Registry Section Component
 * Manages App Store registry sources (view, add, remove, toggle)
 */

import { useState, useEffect, useCallback } from 'react'
import { Plus, Trash2, Loader2 } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import type { RegistrySource } from '../../../shared/store/store-types'

export function RegistrySection() {
  const { t } = useTranslation()

  // State
  const [registries, setRegistries] = useState<RegistrySource[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [newName, setNewName] = useState('')
  const [newUrl, setNewUrl] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  // Load registries on mount
  const loadRegistries = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const result = await api.storeGetRegistries()
      if (result.success && result.data) {
        setRegistries(result.data)
      } else {
        setError(result.error || t('Failed to load registries'))
      }
    } catch (err) {
      setError(t('Failed to load registries'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    loadRegistries()
  }, [loadRegistries])

  // Add registry
  const handleAdd = async () => {
    setAddError(null)

    // Validation
    const trimmedName = newName.trim()
    const trimmedUrl = newUrl.trim()

    if (!trimmedName) {
      setAddError(t('Name is required'))
      return
    }
    if (!trimmedUrl) {
      setAddError(t('URL is required'))
      return
    }

    try {
      new URL(trimmedUrl)
    } catch {
      setAddError(t('Please enter a valid URL'))
      return
    }

    try {
      setAdding(true)
      const result = await api.storeAddRegistry({ name: trimmedName, url: trimmedUrl })
      if (result.success) {
        setNewName('')
        setNewUrl('')
        setShowAddForm(false)
        await loadRegistries()
      } else {
        setAddError(result.error || t('Failed to add registry'))
      }
    } catch {
      setAddError(t('Failed to add registry'))
    } finally {
      setAdding(false)
    }
  }

  // Remove registry
  const handleRemove = async (registryId: string) => {
    try {
      setError(null)
      const result = await api.storeRemoveRegistry(registryId)
      if (result.success) {
        await loadRegistries()
      } else {
        setError(result.error || t('Failed to remove registry'))
      }
    } catch {
      setError(t('Failed to remove registry'))
    }
  }

  // Toggle registry enabled/disabled
  const handleToggle = async (registryId: string, enabled: boolean) => {
    try {
      setError(null)
      const result = await api.storeToggleRegistry(registryId, enabled)
      if (result.success) {
        // Optimistic update
        setRegistries((prev) =>
          prev.map((r) => (r.id === registryId ? { ...r, enabled } : r))
        )
      } else {
        setError(result.error || t('Failed to update registry'))
      }
    } catch {
      setError(t('Failed to update registry'))
    }
  }

  return (
    <section id="app-store" className="bg-card rounded-xl border border-border p-6">
      <div className="mb-4">
        <h2 className="text-lg font-medium">{t('App Store')}</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {t('Manage registry sources for discovering and installing apps')}
        </p>
      </div>

      {/* Error message */}
      {error && (
        <div className="mb-4 px-3 py-2 text-sm text-red-500 bg-red-500/10 rounded-lg">
          {error}
        </div>
      )}

      {/* Loading state */}
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
          <Loader2 className="w-4 h-4 animate-spin" />
          {t('Loading...')}
        </div>
      ) : (
        <>
          {/* Registry list */}
          <div className="space-y-0 divide-y divide-border rounded-lg border border-border overflow-hidden">
            {registries.map((registry) => (
              <div
                key={registry.id}
                className="flex items-center justify-between px-4 py-3"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">{registry.name}</span>
                    {registry.isDefault && (
                      <span className="inline-flex items-center px-1.5 py-0.5 text-xs rounded-full bg-secondary text-secondary-foreground">
                        {t('Default')}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground truncate mt-0.5">
                    {registry.url}
                  </p>
                </div>

                <div className="flex items-center gap-3 ml-4 shrink-0">
                  {/* Toggle switch */}
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={registry.enabled}
                      onChange={() => handleToggle(registry.id, !registry.enabled)}
                      className="sr-only peer"
                    />
                    <div className="w-11 h-6 bg-secondary rounded-full peer peer-checked:bg-primary transition-colors">
                      <div
                        className={`w-5 h-5 bg-white rounded-full shadow-md transform transition-transform ${
                          registry.enabled ? 'translate-x-5' : 'translate-x-0.5'
                        } mt-0.5`}
                      />
                    </div>
                  </label>

                  {/* Delete button - not shown for default registry */}
                  {!registry.isDefault && (
                    <button
                      type="button"
                      onClick={() => handleRemove(registry.id)}
                      className="p-1.5 text-muted-foreground hover:text-destructive rounded-lg transition-colors"
                      title={t('Remove registry')}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            ))}

            {registries.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                {t('No registries configured')}
              </div>
            )}
          </div>

          {/* Add Registry Form */}
          {showAddForm && (
            <div className="mt-4 p-4 border border-border rounded-lg space-y-3">
              <div className="space-y-1">
                <label className="text-sm text-muted-foreground">
                  {t('Name')}
                  <span className="text-red-400 ml-0.5">*</span>
                </label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={t('Registry name')}
                  className="w-full px-3 py-2 bg-muted border border-border rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm text-muted-foreground">
                  {t('URL')}
                  <span className="text-red-400 ml-0.5">*</span>
                </label>
                <input
                  type="text"
                  value={newUrl}
                  onChange={(e) => setNewUrl(e.target.value)}
                  placeholder={t('https://example.com/registry')}
                  className="w-full px-3 py-2 bg-muted border border-border rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>

              {/* Add form error */}
              {addError && (
                <p className="text-sm text-red-500">{addError}</p>
              )}

              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleAdd}
                  disabled={adding}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm bg-primary text-primary-foreground hover:bg-primary/90 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {adding && <Loader2 className="w-4 h-4 animate-spin" />}
                  {adding ? t('Adding...') : t('Add')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowAddForm(false)
                    setNewName('')
                    setNewUrl('')
                    setAddError(null)
                  }}
                  className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground rounded-lg transition-colors"
                >
                  {t('Cancel')}
                </button>
              </div>
            </div>
          )}

          {/* Add Registry Button */}
          {!showAddForm && (
            <button
              type="button"
              onClick={() => setShowAddForm(true)}
              className="mt-4 flex items-center gap-2 px-3 py-1.5 text-sm text-primary hover:bg-primary/10 rounded-lg transition-colors"
            >
              <Plus className="w-4 h-4" />
              {t('Add Registry')}
            </button>
          )}
        </>
      )}
    </section>
  )
}
