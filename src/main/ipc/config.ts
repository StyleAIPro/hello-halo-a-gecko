/**
 * Config IPC Handlers (v2)
 */

import { ipcMain } from 'electron'
import { saveConfig, getDecryptedConfig, saveConfigAndNotify } from '../services/config.service'
import { getAISourceManager } from '../services/ai-sources'
import { validateApiConnection, fetchModelsFromApi } from '../services/api-validator.service'
import { emitConfigChange, runConfigProbe } from '../services/health'
import type { AISourcesConfig } from '../../shared/types'

export function registerConfigHandlers(): void {
  // Get configuration
  ipcMain.handle('config:get', async () => {
    console.log('[Settings] config:get - Loading settings')
    try {
      const decryptedConfig = getDecryptedConfig()
      console.log('[Settings] config:get - Loaded, aiSources v2, currentId:', decryptedConfig.aiSources?.currentId || 'none')
      return { success: true, data: decryptedConfig }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // Save configuration
  ipcMain.handle('config:set', async (_event, updates: Record<string, unknown>) => {
    const updateKeys = Object.keys(updates)
    const incomingAiSources = updates.aiSources as AISourcesConfig | undefined
    console.log('[Settings] config:set - Saving:', updateKeys.join(', '), incomingAiSources?.currentId ? `(currentId: ${incomingAiSources.currentId})` : '')

    try {
      const config = saveConfigAndNotify(updates)
      console.log('[Settings] config:set - Saved successfully')
      return { success: true, data: config }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // Validate API connection via SDK
  ipcMain.handle(
    'config:validate-api',
    async (_event, apiKey: string, apiUrl: string, provider: string, model?: string) => {
      console.log('[Settings] config:validate-api - Validating:', provider, apiUrl ? `(url: ${apiUrl.slice(0, 30)}...)` : '(default url)', model ? `(model: ${model})` : '(no model)')
      try {
        const result = await validateApiConnection({
          apiKey,
          apiUrl,
          provider: provider as 'anthropic' | 'openai',
          model
        })
        console.log('[Settings] config:validate-api - Result:', result.valid ? 'valid' : 'invalid')
        return { success: true, data: result }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[Settings] config:validate-api - Failed:', err.message)
        return { success: false, error: err.message }
      }
    }
  )

  // Fetch available models from API endpoint
  ipcMain.handle(
    'config:fetch-models',
    async (_event, apiKey: string, apiUrl: string) => {
      console.log('[Settings] config:fetch-models - Fetching from:', apiUrl ? `${apiUrl.slice(0, 30)}...` : '(no url)')
      try {
        const result = await fetchModelsFromApi({ apiKey, apiUrl })
        console.log('[Settings] config:fetch-models - Found', result.models.length, 'models')
        return { success: true, data: result }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[Settings] config:fetch-models - Failed:', err.message)
        return { success: false, error: err.message }
      }
    }
  )

  // Refresh AI sources configuration (auto-detects logged-in sources)
  ipcMain.handle('config:refresh-ai-sources', async () => {
    console.log('[Settings] config:refresh-ai-sources - Refreshing all AI sources')
    try {
      const manager = getAISourceManager()
      await manager.refreshAllConfigs()
      const config = getConfig()
      console.log('[Settings] config:refresh-ai-sources - Refreshed, current:', (config as any).aiSources?.current || 'custom')
      return { success: true, data: config }
    } catch (error: unknown) {
      const err = error as Error
      console.error('[Settings] config:refresh-ai-sources - Failed:', err.message)
      return { success: false, error: err.message }
    }
  })

  // ===== AI Sources CRUD (atomic operations) =====
  // These handlers read from disk before writing, ensuring rotating tokens are never overwritten.

  // Switch current source
  ipcMain.handle('ai-sources:switch-source', async (_event, sourceId: string) => {
    console.log('[Settings] ai-sources:switch-source - Switching to:', sourceId)
    try {
      const manager = getAISourceManager()
      const result = manager.setCurrentSource(sourceId)
      if (result.currentId !== sourceId) {
        return { success: false, error: `Source not found: ${sourceId}` }
      }
      emitConfigChange(['aiSources.currentId'])
      runConfigProbe().catch(err => console.error('[Settings] ai-sources:switch-source - Probe failed:', err))
      return { success: true, data: result }
    } catch (error: unknown) {
      const err = error as Error
      console.error('[Settings] ai-sources:switch-source - Failed:', err.message)
      return { success: false, error: err.message }
    }
  })

  // Set model for current source
  ipcMain.handle('ai-sources:set-model', async (_event, modelId: string) => {
    console.log('[Settings] ai-sources:set-model - Setting model:', modelId)
    try {
      const manager = getAISourceManager()
      const result = manager.setCurrentModel(modelId)
      emitConfigChange(['aiSources.model'])
      return { success: true, data: result }
    } catch (error: unknown) {
      const err = error as Error
      console.error('[Settings] ai-sources:set-model - Failed:', err.message)
      return { success: false, error: err.message }
    }
  })

  // Add new source
  ipcMain.handle('ai-sources:add-source', async (_event, source: AISource) => {
    console.log('[Settings] ai-sources:add-source - Adding source:', source.name)
    try {
      const manager = getAISourceManager()
      const result = manager.addSource(source)
      emitConfigChange(['aiSources.sources'])
      runConfigProbe().catch(err => console.error('[Settings] ai-sources:add-source - Probe failed:', err))
      return { success: true, data: result }
    } catch (error: unknown) {
      const err = error as Error
      console.error('[Settings] ai-sources:add-source - Failed:', err.message)
      return { success: false, error: err.message }
    }
  })

  // Update existing source (merges updates into disk state via manager.updateSource)
  ipcMain.handle('ai-sources:update-source', async (_event, sourceId: string, updates: Partial<AISource>) => {
    console.log('[Settings] ai-sources:update-source - Updating:', sourceId)
    try {
      const manager = getAISourceManager()
      const result = manager.updateSource(sourceId, updates)
      emitConfigChange(['aiSources.sources'])
      runConfigProbe().catch(err => console.error('[Settings] ai-sources:update-source - Probe failed:', err))
      return { success: true, data: result }
    } catch (error: unknown) {
      const err = error as Error
      console.error('[Settings] ai-sources:update-source - Failed:', err.message)
      return { success: false, error: err.message }
    }
  })

  // Delete source
  ipcMain.handle('ai-sources:delete-source', async (_event, sourceId: string) => {
    console.log('[Settings] ai-sources:delete-source - Deleting:', sourceId)
    try {
      const manager = getAISourceManager()
      const result = manager.deleteSource(sourceId)
      emitConfigChange(['aiSources.sources'])
      return { success: true, data: result }
    } catch (error: unknown) {
      const err = error as Error
      console.error('[Settings] ai-sources:delete-source - Failed:', err.message)
      return { success: false, error: err.message }
    }
  })

  console.log('[Settings] Config handlers registered')
}
