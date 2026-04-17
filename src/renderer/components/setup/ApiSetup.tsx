/**
 * API Setup - Custom API configuration
 * Reuses the same ProviderSelector component as the Settings page
 * for a consistent AI provider configuration experience.
 */

import { useState } from 'react';
import { useAppStore } from '../../stores/app.store';
import { api } from '../../api';
import { Lightbulb } from '../icons/ToolIcons';
import { Globe, ChevronDown, ArrowLeft } from 'lucide-react';
import type { AISource, AISourcesConfig } from '../../types';
import { ProviderSelector } from '../settings/ProviderSelector';
import {
  useTranslation,
  setLanguage,
  getCurrentLanguage,
  SUPPORTED_LOCALES,
  type LocaleCode,
} from '../../i18n';

interface ApiSetupProps {
  /** Called when user clicks back button */
  onBack?: () => void;
  /** Whether to show the back button */
  showBack?: boolean;
}

export function ApiSetup({ onBack, showBack = false }: ApiSetupProps) {
  const { t } = useTranslation();
  const { config, setConfig, setView } = useAppStore();

  // Language selector state
  const [isLangDropdownOpen, setIsLangDropdownOpen] = useState(false);
  const [currentLang, setCurrentLang] = useState<LocaleCode>(getCurrentLanguage());

  // Build empty AISourcesConfig for ProviderSelector (first-time setup has no sources)
  const emptyAiSources: AISourcesConfig = {
    version: 2,
    currentId: null,
    sources: [],
  };

  // Handle language change
  const handleLanguageChange = (lang: LocaleCode) => {
    setLanguage(lang);
    setCurrentLang(lang);
    setIsLangDropdownOpen(false);
  };

  // Handle save from ProviderSelector — persist config and enter the app
  const handleSave = async (source: AISource) => {
    const newAiSources: AISourcesConfig = {
      version: 2,
      currentId: source.id,
      sources: [source],
    };

    const newConfig = {
      ...config,
      isFirstLaunch: false,
      aiSources: newAiSources,
    };

    await api.setConfig(newConfig);
    setConfig(newConfig as any);
    setView('home');
  };

  // Handle cancel from ProviderSelector — go back to provider selection
  const handleCancel = () => {
    onBack?.();
  };

  return (
    <div className="h-full w-full flex flex-col items-center justify-center bg-background p-8 relative overflow-auto">
      {/* Language Selector - Top Right */}
      <div className="absolute top-6 right-6">
        <div className="relative">
          <button
            onClick={() => setIsLangDropdownOpen(!isLangDropdownOpen)}
            className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-secondary/80 rounded-lg transition-colors"
          >
            <Globe className="w-4 h-4" />
            <span>{SUPPORTED_LOCALES[currentLang]}</span>
            <ChevronDown
              className={`w-4 h-4 transition-transform ${isLangDropdownOpen ? 'rotate-180' : ''}`}
            />
          </button>

          {/* Dropdown */}
          {isLangDropdownOpen && (
            <>
              {/* Backdrop to close dropdown */}
              <div className="fixed inset-0 z-10" onClick={() => setIsLangDropdownOpen(false)} />
              <div className="absolute right-0 mt-1 py-1 w-40 bg-card border border-border rounded-lg shadow-lg z-20">
                {Object.entries(SUPPORTED_LOCALES).map(([code, name]) => (
                  <button
                    key={code}
                    onClick={() => handleLanguageChange(code as LocaleCode)}
                    className={`w-full px-4 py-2 text-left text-sm hover:bg-secondary/80 transition-colors ${
                      currentLang === code ? 'text-primary font-medium' : 'text-foreground'
                    }`}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Header */}
      <div className="flex flex-col items-center mb-8">
        {/* Logo */}
        <div className="w-16 h-16 rounded-full border-2 border-primary/60 flex items-center justify-center aico-bot-glow">
          <div className="w-12 h-12 rounded-full bg-gradient-to-br from-primary/30 to-transparent" />
        </div>
        <h1 className="mt-4 text-2xl font-light">AICO-Bot</h1>
      </div>

      {/* Main content */}
      <div className="w-full max-w-md">
        <div className="relative mb-6">
          {/* Back Button */}
          {showBack && onBack && (
            <button
              onClick={onBack}
              className="absolute left-0 top-1/2 -translate-y-1/2 flex items-center gap-1.5 px-2 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-secondary/80 rounded-lg transition-colors"
            >
              <ArrowLeft className="w-5 h-5" />
              <span>{t('Back')}</span>
            </button>
          )}
          <h2 className="text-center text-lg">{t('Before you start, configure your AI')}</h2>
        </div>

        <ProviderSelector aiSources={emptyAiSources} onSave={handleSave} onCancel={handleCancel} />

        {/* Help link */}
        <p className="text-center mt-4 text-sm text-muted-foreground">
          <a
            href="https://console.anthropic.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary cursor-pointer hover:underline inline-flex items-center gap-1"
          >
            <Lightbulb className="w-4 h-4 text-yellow-500" />
            {t("Don't know how to get it? View tutorial")}
          </a>
        </p>
      </div>
    </div>
  );
}
