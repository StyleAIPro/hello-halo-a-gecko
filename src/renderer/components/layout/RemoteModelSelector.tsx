/**
 * RemoteModelSelector - Model selector for remote spaces
 * Shows the AI source bound to the remote server and allows switching.
 * Switching updates the server card's aiSourceId + credential snapshot.
 */

import { useState, useRef, useEffect } from 'react';
import { ChevronDown, Plus, Sparkles, X, Check } from 'lucide-react';
import { useAppStore } from '../../stores/app.store';
import { api } from '../../api';
import { type AISourcesConfig, type AISource, type ModelOption } from '../../types';
import { useTranslation } from '../../i18n';
import { useIsMobile } from '../../hooks/useIsMobile';

interface RemoteModelSelectorProps {
  space: {
    remoteServerId?: string;
  };
}

export function RemoteModelSelector({ space }: RemoteModelSelectorProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const { config, setConfig } = useAppStore();
  const [isOpen, setIsOpen] = useState(false);
  const [isAnimatingOut, setIsAnimatingOut] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [remoteServers, setRemoteServers] = useState<
    Array<{ id: string; aiSourceId?: string; claudeModel?: string; claudeBaseUrl?: string }>
  >([]);

  const [expandedSection, setExpandedSection] = useState<string | null>(null);

  // Get v2 aiSources config
  const aiSources: AISourcesConfig =
    config?.aiSources?.version === 2
      ? config.aiSources
      : { version: 2, currentId: null, sources: [] };

  // Find the remote server for this space
  const server = remoteServers.find((s) => s.id === space.remoteServerId);

  // Get the AI source bound to this server
  const serverSourceId = server?.aiSourceId;
  const serverSource = serverSourceId
    ? aiSources.sources.find((s) => s.id === serverSourceId)
    : undefined;

  // Current model display name — prioritize server's overridden model over source default
  const currentModelName = server?.claudeModel || serverSource?.model || t('Not configured');

  // Initialize expanded section to server's source when opening
  useEffect(() => {
    if (isOpen && serverSourceId) {
      setExpandedSection(serverSourceId);
    }
  }, [isOpen, serverSourceId]);

  // Load remote servers
  useEffect(() => {
    const loadServers = async () => {
      try {
        const result = await api.getRemoteServers();
        if (result.success && Array.isArray(result.data)) {
          setRemoteServers(result.data);
        }
      } catch (error) {
        console.error('[RemoteModelSelector] Failed to load remote servers:', error);
      }
    };
    loadServers();
  }, []);

  const toggleSection = (sourceId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedSection((prev) => (prev === sourceId ? null : sourceId));
  };

  // Close dropdown when clicking outside (desktop only)
  useEffect(() => {
    if (!isOpen || isMobile) return;

    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    const timeoutId = setTimeout(() => {
      document.addEventListener('click', handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('click', handleClickOutside);
    };
  }, [isOpen, isMobile]);

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        handleClose();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  const handleClose = () => {
    if (isMobile) {
      setIsAnimatingOut(true);
      setTimeout(() => {
        setIsOpen(false);
        setIsAnimatingOut(false);
      }, 200);
    } else {
      setIsOpen(false);
    }
  };

  if (!config || !space.remoteServerId) return null;

  // Handle AI source selection for the remote server
  const handleSelectSource = async (sourceId: string) => {
    if (!space.remoteServerId) return;

    const result = await api.remoteServerUpdateAiSource(space.remoteServerId, sourceId);
    if (result.success) {
      // Reload remote servers to reflect updated config
      const serversResult = await api.getRemoteServers();
      if (serversResult.success && Array.isArray(serversResult.data)) {
        setRemoteServers(serversResult.data);
      }
    } else {
      console.error('[RemoteModelSelector] Failed to update AI source:', result.error);
    }
    handleClose();
  };

  // Handle model selection — switches AI source if needed, then sets model
  const handleSelectModel = async (sourceId: string, modelId: string) => {
    if (!space.remoteServerId) return;

    // If model is from a different source, switch the source first (updates URL + API key)
    if (serverSourceId !== sourceId) {
      const sourceResult = await api.remoteServerUpdateAiSource(space.remoteServerId, sourceId);
      if (!sourceResult.success) {
        console.error('[RemoteModelSelector] Failed to switch AI source:', sourceResult.error);
        handleClose();
        return;
      }
    }

    // Then update the model
    const result = await api.remoteServerUpdateModel(space.remoteServerId, modelId);
    if (result.success) {
      // Reload remote servers to reflect updated config
      const serversResult = await api.getRemoteServers();
      if (serversResult.success && Array.isArray(serversResult.data)) {
        setRemoteServers(serversResult.data);
      }
    } else {
      console.error('[RemoteModelSelector] Failed to update model:', result.error);
    }
    handleClose();
  };

  // Get available models for a source
  const getModelsForSource = (source: AISource): ModelOption[] => {
    // If source has its own available models (user fetched or configured), use them
    if (source.availableModels && source.availableModels.length > 0) {
      return source.availableModels;
    }
    // Fallback: return current model as single option
    if (source.model) {
      return [{ id: source.model, name: source.model }];
    }
    return [];
  };

  // Get display name for source
  const getSourceDisplayName = (source: AISource): string => {
    if (source.name) return source.name;
    if (source.authType === 'oauth') return 'OAuth Provider';
    return t('Custom API');
  };

  // Render model list
  const renderModelList = () => (
    <>
      {aiSources.sources.map((source) => {
        const isExpanded = expandedSection === source.id;
        const isActiveSource = serverSourceId === source.id;
        const models = getModelsForSource(source);
        const displayName = getSourceDisplayName(source);

        return (
          <div key={source.id}>
            <div
              className={`px-3 py-2 text-xs font-medium flex items-center justify-between cursor-pointer hover:bg-secondary/50 transition-colors ${isActiveSource ? 'text-primary' : 'text-muted-foreground'}`}
              onClick={(e) => toggleSection(source.id, e)}
            >
              <div className="flex items-center gap-2">
                <ChevronDown
                  className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                />
                <span>{displayName}</span>
              </div>
              <div className="flex items-center gap-2">
                {isActiveSource ? (
                  <span className="w-2.5 h-2.5 rounded-full bg-primary" title={t('Active')} />
                ) : (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSelectSource(source.id);
                    }}
                    className="w-2.5 h-2.5 rounded-full border border-muted-foreground hover:border-primary hover:bg-primary/20 transition-colors"
                    title={t('Switch to this source')}
                  />
                )}
              </div>
            </div>

            {isExpanded && (
              <div className="bg-secondary/10 pb-1">
                {models.map((model) => {
                  const modelId = typeof model === 'string' ? model : model.id;
                  const modelName = typeof model === 'string' ? model : model.name || model.id;
                  const isSelected = isActiveSource && server?.claudeModel === modelId;

                  return (
                    <button
                      key={modelId}
                      onClick={() => handleSelectModel(source.id, modelId)}
                      className={`w-full px-3 py-3 text-left text-sm hover:bg-secondary/80 transition-colors flex items-center gap-2 pl-8 ${
                        isSelected ? 'text-primary' : 'text-foreground'
                      }`}
                    >
                      {isSelected ? <Check className="w-3 h-3" /> : <span className="w-3" />}
                      {modelName}
                    </button>
                  );
                })}
              </div>
            )}
            <div className="border-t border-border/50" />
          </div>
        );
      })}

      {/* Add source button */}
      {aiSources.sources.length === 0 ? (
        <button
          onClick={() => {
            handleClose();
            setConfig({ ...config, appView: 'settings' });
          }}
          className="w-full px-3 py-3 text-left text-sm text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-colors flex items-center gap-2"
        >
          <Plus className="w-3.5 h-3.5" />
          {t('Add AI Provider')}
        </button>
      ) : (
        <button
          onClick={() => {
            handleClose();
            setConfig({ ...config, appView: 'settings' });
          }}
          className="w-full px-3 py-2 text-left text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors flex items-center gap-2"
        >
          <Plus className="w-3 h-3" />
          {t('Manage AI Provider')}
        </button>
      )}
    </>
  );

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Trigger Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-secondary/80 rounded-lg transition-colors"
        title={currentModelName}
      >
        <Sparkles className="w-4 h-4 sm:hidden" />
        <span className="hidden sm:inline max-w-[140px] truncate">{currentModelName}</span>
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {/* Dropdown/Bottom Sheet */}
      {isOpen && (
        <>
          {isMobile ? (
            <>
              <div
                onClick={handleClose}
                className={`fixed inset-0 bg-black/40 z-40 ${isAnimatingOut ? 'animate-fade-out' : 'animate-fade-in'}`}
                style={{ animationDuration: '0.2s' }}
              />
              <div
                className={`
                  fixed inset-x-0 bottom-0 z-50
                  bg-card rounded-t-2xl border-t border-border/50
                  shadow-2xl overflow-hidden
                  ${isAnimatingOut ? 'animate-slide-out-bottom' : 'animate-slide-in-bottom'}
                `}
                style={{ maxHeight: '60vh' }}
              >
                <div className="flex justify-center py-2">
                  <div className="w-10 h-1 bg-muted-foreground/30 rounded-full" />
                </div>
                <div className="px-4 py-2 border-b border-border/50 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-5 h-5 text-primary" />
                    <div>
                      <h3 className="text-base font-semibold text-foreground">
                        {t('Select Model')}
                      </h3>
                      <p className="text-xs text-muted-foreground">{currentModelName}</p>
                    </div>
                  </div>
                  <button
                    onClick={handleClose}
                    className="p-2 hover:bg-secondary rounded-lg transition-colors"
                  >
                    <X className="w-5 h-5 text-muted-foreground" />
                  </button>
                </div>
                <div className="overflow-auto" style={{ maxHeight: 'calc(60vh - 80px)' }}>
                  {renderModelList()}
                </div>
              </div>
            </>
          ) : (
            <div className="absolute right-0 top-full mt-1 w-64 bg-card border border-border rounded-xl shadow-lg z-50 py-1 max-h-[60vh] overflow-y-auto">
              {renderModelList()}
            </div>
          )}
        </>
      )}
    </div>
  );
}
