/**
 * MirrorSourceSection - Remote Deployment Mirror Source Configuration
 *
 * Allows users to configure mirror sources for remote server deployment.
 * Supports preset profiles (e.g., Huawei Intranet) and custom profiles.
 * Self-contained: reads config from useAppStore, no props needed.
 */

import { useState, useCallback, useMemo } from 'react';
import { Check, Plus, Trash2, ChevronDown, ChevronRight, Save } from 'lucide-react';
import { useTranslation } from '../../i18n';
import { useAppStore } from '../../stores/app.store';
import type {
  MirrorSourceProfile,
  MirrorSourceUrls,
  DeployMirrorConfig,
} from '../../../shared/types/mirror-source';
import {
  BUILTIN_MIRROR_PRESETS,
  DEFAULT_MIRROR_URLS,
  createEmptyCustomProfile,
} from '../../../shared/types/mirror-source';

/** URL 验证：必须以 http:// 或 https:// 开头 */
function isValidUrl(url: string): boolean {
  if (!url.trim()) return true; // 空值允许（使用默认值）
  return url.trim().startsWith('http://') || url.trim().startsWith('https://');
}

export function MirrorSourceSection() {
  const { t } = useTranslation();
  const config = useAppStore((s) => s.config);
  const updateConfig = useAppStore((s) => s.updateConfig);

  // 编辑状态
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [editingSources, setEditingSources] = useState<MirrorSourceUrls | null>(null);
  const [editingName, setEditingName] = useState<string>('');
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [newProfileName, setNewProfileName] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);

  // 获取当前配置（含内置预设初始化）
  const mirrorConfig = useMemo<DeployMirrorConfig>(() => {
    const existing = config?.deployMirror;
    if (existing && existing.profiles.length > 0) {
      return existing;
    }
    // 首次初始化：合并内置预设 + 已有自定义
    const customProfiles = existing?.profiles.filter((p) => !p.isPreset) || [];
    return {
      activeProfileId: existing?.activeProfileId ?? null,
      profiles: [...BUILTIN_MIRROR_PRESETS, ...customProfiles],
    };
  }, [config?.deployMirror]);

  const profiles = mirrorConfig.profiles;
  const activeProfileId = mirrorConfig.activeProfileId;
  const activeProfile = profiles.find((p) => p.id === activeProfileId) ?? null;

  // 选择方案
  const handleSelectProfile = useCallback(
    (profileId: string | null) => {
      setSaveError(null);
      setEditingProfileId(null);
      setEditingSources(null);
      updateConfig({
        deployMirror: { ...mirrorConfig, activeProfileId: profileId },
      });
    },
    [mirrorConfig, updateConfig],
  );

  // 开始编辑自定义方案
  const handleStartEdit = useCallback((profile: MirrorSourceProfile) => {
    if (profile.isPreset) return;
    setSaveError(null);
    setEditingProfileId(profile.id);
    setEditingSources({ ...profile.sources });
    setEditingName(profile.name);
  }, []);

  // 取消编辑
  const handleCancelEdit = useCallback(() => {
    setEditingProfileId(null);
    setEditingSources(null);
    setEditingName('');
    setSaveError(null);
  }, []);

  // 保存编辑
  const handleSaveEdit = useCallback(() => {
    if (!editingProfileId || !editingSources) return;

    // 验证
    if (!isValidUrl(editingSources.npmRegistry)) {
      setSaveError(t('npm Registry must start with http:// or https://'));
      return;
    }
    if (!isValidUrl(editingSources.nodeDownloadMirror)) {
      setSaveError(t('Node.js mirror must start with http:// or https://'));
      return;
    }

    const updatedProfiles = profiles.map((p) =>
      p.id === editingProfileId ? { ...p, name: editingName, sources: editingSources } : p,
    );
    updateConfig({
      deployMirror: { ...mirrorConfig, profiles: updatedProfiles },
    });
    setEditingProfileId(null);
    setEditingSources(null);
    setEditingName('');
    setSaveError(null);
  }, [editingProfileId, editingSources, editingName, profiles, mirrorConfig, updateConfig, t]);

  // 新增自定义方案
  const handleAddProfile = useCallback(() => {
    const name = newProfileName.trim();
    if (!name) return;

    const newProfile = createEmptyCustomProfile(name);
    const updatedProfiles = [...profiles, newProfile];
    updateConfig({
      deployMirror: { ...mirrorConfig, profiles: updatedProfiles },
    });
    setNewProfileName('');
    setShowAddDialog(false);
    // 立即开始编辑新方案
    setEditingProfileId(newProfile.id);
    setEditingSources({ ...newProfile.sources });
    setEditingName(newProfile.name);
  }, [newProfileName, profiles, mirrorConfig, updateConfig]);

  // 删除自定义方案
  const handleDeleteProfile = useCallback(
    (profileId: string) => {
      if (profileId === activeProfileId) {
        setSaveError(t('mirror.deleteInUseConfirm'));
        return;
      }
      const updatedProfiles = profiles.filter((p) => p.id !== profileId);
      updateConfig({
        deployMirror: { ...mirrorConfig, profiles: updatedProfiles },
      });
      if (editingProfileId === profileId) {
        handleCancelEdit();
      }
    },
    [activeProfileId, profiles, mirrorConfig, updateConfig, editingProfileId, handleCancelEdit, t],
  );

  // 提取域名用于摘要显示
  const extractDomain = (url: string) => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  };

  return (
    <div className="mt-6 pt-6 border-t border-border">
      {/* 标题和说明 */}
      <div className="mb-4">
        <h3 className="text-base font-medium">{t('Mirror Source Config')}</h3>
        <p className="text-xs text-muted-foreground mt-1">{t('mirror.description')}</p>
      </div>
      <div className="space-y-4">
        {/* 方案列表 */}
        <div className="space-y-1">
          {/* 不配置镜像源 */}
          <div
            className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-colors ${
              activeProfileId === null ? 'bg-primary/10' : 'hover:bg-muted'
            }`}
            onClick={() => handleSelectProfile(null)}
          >
            <button
              type="button"
              className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${
                activeProfileId === null
                  ? 'border-primary bg-primary'
                  : 'border-border-secondary hover:border-primary'
              }`}
            >
              {activeProfileId === null && <Check size={12} className="text-white" />}
            </button>
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium">{t('mirror.noConfig')}</span>
              <p className="text-xs text-muted-foreground">{t('mirror.noConfigDesc')}</p>
            </div>
          </div>

          {/* 预设和自定义方案 */}
          {profiles.map((profile) => {
            const isActive = profile.id === activeProfileId;
            const isEditing = profile.id === editingProfileId;
            return (
              <div
                key={profile.id}
                className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-colors ${
                  isActive ? 'bg-primary/10' : 'hover:bg-muted'
                }`}
                onClick={() => handleSelectProfile(profile.id)}
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleSelectProfile(profile.id);
                  }}
                  className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors shrink-0 ${
                    isActive
                      ? 'border-primary bg-primary'
                      : 'border-border-secondary hover:border-primary'
                  }`}
                >
                  {isActive && <Check size={12} className="text-white" />}
                </button>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">{profile.name}</span>
                    {profile.isPreset && (
                      <span className="inline-flex items-center px-1.5 py-0.5 text-xs rounded-full bg-secondary text-secondary-foreground">
                        {t('Preset')}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    npm: {extractDomain(profile.sources.npmRegistry)}
                    {' / '}
                    Node: {extractDomain(profile.sources.nodeDownloadMirror)}
                  </p>
                </div>
                {/* 展开详情 */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!profile.isPreset) {
                      handleStartEdit(profile);
                    }
                  }}
                  className={`p-1 rounded transition-colors shrink-0 ${
                    profile.isPreset
                      ? 'text-muted-foreground/50 cursor-not-allowed'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                  title={profile.isPreset ? t('Preset profiles cannot be edited') : t('Edit')}
                >
                  {isEditing ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button>
              </div>
            );
          })}

          {/* 新增自定义方案 */}
          <button
            type="button"
            onClick={() => setShowAddDialog(true)}
            className="flex items-center gap-2 p-3 text-sm text-primary hover:bg-primary/5 rounded-lg transition-colors"
          >
            <Plus className="w-4 h-4" />
            {t('mirror.addCustom')}
          </button>
        </div>

        {/* 活跃方案详情 / 编辑区 */}
        {activeProfile && (
          <div className="border border-border rounded-lg p-4 space-y-4 mt-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">{t('mirror.currentProfile')}</h3>
              {!activeProfile.isPreset && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleDeleteProfile(activeProfile.id)}
                    className="flex items-center gap-1 px-2 py-1 text-xs text-destructive hover:bg-destructive/10 rounded transition-colors"
                  >
                    <Trash2 className="w-3 h-3" />
                    {t('mirror.delete')}
                  </button>
                </div>
              )}
            </div>

            {/* 预设：只读展示 */}
            {activeProfile.isPreset && (
              <div className="space-y-3">
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">{t('mirror.profileName')}</label>
                  <div className="px-3 py-2 bg-muted rounded-lg text-sm">{activeProfile.name}</div>
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">{t('mirror.npmRegistry')}</label>
                  <div className="px-3 py-2 bg-muted rounded-lg text-sm break-all">
                    {activeProfile.sources.npmRegistry}
                  </div>
                  <p className="text-xs text-muted-foreground">{t('mirror.npmRegistryDesc')}</p>
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">
                    {t('mirror.nodeDownloadMirror')}
                  </label>
                  <div className="px-3 py-2 bg-muted rounded-lg text-sm break-all">
                    {activeProfile.sources.nodeDownloadMirror}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t('mirror.nodeDownloadMirrorDesc')}
                  </p>
                </div>
              </div>
            )}

            {/* 自定义：可编辑 */}
            {!activeProfile.isPreset && editingSources && (
              <div className="space-y-3">
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">{t('mirror.profileName')}</label>
                  <input
                    type="text"
                    value={editingName}
                    onChange={(e) => setEditingName(e.target.value)}
                    className="w-full px-3 py-2 bg-muted border border-border rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">{t('mirror.npmRegistry')}</label>
                  <input
                    type="text"
                    value={editingSources.npmRegistry}
                    onChange={(e) =>
                      setEditingSources((prev) =>
                        prev ? { ...prev, npmRegistry: e.target.value } : prev,
                      )
                    }
                    placeholder={DEFAULT_MIRROR_URLS.npmRegistry}
                    className="w-full px-3 py-2 bg-muted border border-border rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  <p className="text-xs text-muted-foreground">{t('mirror.npmRegistryDesc')}</p>
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">
                    {t('mirror.nodeDownloadMirror')}
                  </label>
                  <input
                    type="text"
                    value={editingSources.nodeDownloadMirror}
                    onChange={(e) =>
                      setEditingSources((prev) =>
                        prev ? { ...prev, nodeDownloadMirror: e.target.value } : prev,
                      )
                    }
                    placeholder={DEFAULT_MIRROR_URLS.nodeDownloadMirror}
                    className="w-full px-3 py-2 bg-muted border border-border rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('mirror.nodeDownloadMirrorDesc')}
                  </p>
                </div>

                {/* 操作按钮 */}
                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={handleSaveEdit}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary text-primary-foreground hover:bg-primary/90 rounded-lg transition-colors"
                  >
                    <Save className="w-3.5 h-3.5" />
                    {t('mirror.save')}
                  </button>
                  <button
                    type="button"
                    onClick={handleCancelEdit}
                    className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground rounded-lg transition-colors"
                  >
                    {t('Cancel')}
                  </button>
                </div>
              </div>
            )}

            {/* 自定义但未展开编辑 */}
            {!activeProfile.isPreset && !editingSources && (
              <div className="space-y-3">
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">{t('mirror.profileName')}</label>
                  <div className="px-3 py-2 bg-muted rounded-lg text-sm">{activeProfile.name}</div>
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">{t('mirror.npmRegistry')}</label>
                  <div className="px-3 py-2 bg-muted rounded-lg text-sm break-all">
                    {activeProfile.sources.npmRegistry}
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">
                    {t('mirror.nodeDownloadMirror')}
                  </label>
                  <div className="px-3 py-2 bg-muted rounded-lg text-sm break-all">
                    {activeProfile.sources.nodeDownloadMirror}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleStartEdit(activeProfile)}
                  className="text-xs text-primary hover:underline"
                >
                  {t('Edit')}
                </button>
              </div>
            )}
          </div>
        )}

        {/* 保存错误提示 */}
        {saveError && (
          <div className="px-3 py-2 text-sm text-red-500 bg-red-500/10 rounded-lg">{saveError}</div>
        )}

        {/* 新增方案对话框 */}
        {showAddDialog && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-card border border-border rounded-xl p-6 w-full max-w-sm mx-4 shadow-xl">
              <h3 className="text-base font-medium mb-4">{t('mirror.addCustomTitle')}</h3>
              <input
                type="text"
                value={newProfileName}
                onChange={(e) => setNewProfileName(e.target.value)}
                placeholder={t('mirror.addCustomPlaceholder')}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newProfileName.trim()) handleAddProfile();
                  if (e.key === 'Escape') {
                    setShowAddDialog(false);
                    setNewProfileName('');
                  }
                }}
                className="w-full px-3 py-2 bg-muted border border-border rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <div className="flex items-center justify-end gap-2 mt-4">
                <button
                  type="button"
                  onClick={() => {
                    setShowAddDialog(false);
                    setNewProfileName('');
                  }}
                  className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground rounded-lg transition-colors"
                >
                  {t('Cancel')}
                </button>
                <button
                  type="button"
                  onClick={handleAddProfile}
                  disabled={!newProfileName.trim()}
                  className="px-3 py-1.5 text-sm bg-primary text-primary-foreground hover:bg-primary/90 rounded-lg transition-colors disabled:opacity-50"
                >
                  {t('Confirm')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
