/**
 * TerminalPanel - Shared terminal for human-agent collaboration
 *
 * Features:
 * - Real-time display of Agent command execution
 * - User can execute commands to help Agent
 * - Bidirectional awareness (Agent sees user commands, user sees Agent commands)
 * - Uses xterm.js for terminal rendering
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  X,
  Minimize2,
  Maximize2,
  Trash2,
  Terminal as TerminalIcon,
  Send,
  Sparkles,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useTerminalStore } from '../../stores/terminal.store';
import { useTranslation } from '../../i18n';

import '@xterm/xterm/css/xterm.css';
import './TerminalPanel.css';

interface TerminalPanelProps {
  spaceId?: string;
  conversationId?: string;
  onGenerateSkill?: () => void;
  isVisible?: boolean; // Controlled by parent component
}

export function TerminalPanel({
  spaceId,
  conversationId,
  onGenerateSkill,
  isVisible: parentIsVisible,
}: TerminalPanelProps) {
  const { t } = useTranslation();
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [inputValue, setInputValue] = useState('');
  const [isInputMode, setIsInputMode] = useState(false);
  const [isGeneratingSkill, setIsGeneratingSkill] = useState(false);

  const {
    isVisible: storeIsVisible,
    isExpanded,
    isConnected,
    commands,
    currentOutput,
    toggleVisibility,
    toggleExpanded,
    clearTerminal,
    sendCommand,
    disconnect,
  } = useTerminalStore();

  // Use parent's isVisible if provided, otherwise use store's isVisible
  const isVisible = parentIsVisible !== undefined ? parentIsVisible : storeIsVisible;

  // Determine panel state class
  const getPanelClass = () => {
    if (!isVisible) return 'terminal-panel hidden';
    if (isExpanded) return 'terminal-panel expanded';
    return 'terminal-panel minimized'; // New: minimized state (header only)
  };

  // Initialize xterm.js - only when expanded and visible
  useEffect(() => {
    // Only initialize when panel is visible AND expanded (not minimized)
    if (!terminalRef.current || !isVisible || !isExpanded) return;

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#1e1e1e',
        foreground: '#f8f8f2',
        cursor: '#f8f8f2',
        cursorAccent: '#1e1e1e',
        selection: 'rgba(255, 255, 255, 0.3)',
        black: '#1e1e1e',
        red: '#ff5555',
        green: '#50fa7b',
        yellow: '#f1fa8c',
        blue: '#bd93f9',
        magenta: '#ff79c6',
        cyan: '#8be9fd',
        white: '#f8f8f2',
        brightBlack: '#6272a4',
        brightRed: '#ff6e67',
        brightGreen: '#69ff94',
        brightYellow: '#ffffa5',
        brightBlue: '#d6acff',
        brightMagenta: '#ff92df',
        brightCyan: '#a4ffff',
        brightWhite: '#ffffff',
      },
      scrollback: 10000,
      tabStopWidth: 4,
      convertEol: true,
      rightClickSelectsWord: true,
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    fitAddon.fit();

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
    });
    resizeObserver.observe(terminalRef.current);

    // Display welcome message
    term.writeln(
      '\x1b[1;36m' + '╔═══════════════════════════════════════════════════════════╗' + '\x1b[0m',
    );
    term.writeln(
      '\x1b[1;36m' +
        '║' +
        '  🤖 Shared Terminal - Human-Agent Collaboration  '.padEnd(55) +
        '║' +
        '\x1b[0m',
    );
    term.writeln(
      '\x1b[1;36m' + '╚═══════════════════════════════════════════════════════════╝' + '\x1b[0m',
    );
    term.writeln('');
    term.writeln('\x1b[33m' + 'Connected to remote agent' + '\x1b[0m');
    term.writeln('\x1b[90m' + 'Agent commands will appear below...' + '\x1b[0m');
    term.writeln('');

    return () => {
      resizeObserver.disconnect();
      term.dispose();
    };
  }, [isVisible, isExpanded]); // Re-run when visibility or expansion state changes

  // Call fit() when expanding from minimized state
  useEffect(() => {
    if (isExpanded && fitAddonRef.current && xtermRef.current) {
      setTimeout(() => {
        fitAddonRef.current?.fit();
      }, 100); // Small delay to allow DOM to settle
    }
  }, [isExpanded]);

  // Register terminal output callback with store - this enables real-time terminal data
  useEffect(() => {
    const term = xtermRef.current;
    if (!term || !isExpanded || !isVisible) return;

    // Create callback that writes to xterm.js
    const callback = (data: string) => {
      term.write(data);
    };

    // Register with store
    const { setTerminalOutputCallback } = useTerminalStore.getState();
    setTerminalOutputCallback(callback);

    // Cleanup on unmount or when terminal is recreated
    return () => {
      setTerminalOutputCallback(null);
    };
  }, [isExpanded, isVisible]);

  // Update terminal output when commands change (for command history display)
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;

    // Clear and replay all commands
    term.clear();
    term.writeln('\x1b[1;36m' + '═══ Shared Terminal ═══' + '\x1b[0m');
    term.writeln('');

    commands.forEach((cmd) => {
      const sourceColor =
        cmd.source === 'agent' ? '\x1b[1;34m[AGENT]\x1b[0m' : '\x1b[1;32m[USER]\x1b[0m';
      const promptColor = cmd.status === 'error' ? '\x1b[1;31m$\x1b[0m' : '\x1b[1;32m$\x1b[0m';

      term.writeln(`${sourceColor} ${promptColor} ${cmd.command}`);

      if (cmd.output) {
        const outputLines = cmd.output.split('\n');
        outputLines.forEach((line) => {
          if (line.trim()) {
            term.writeln(`  ${line}`);
          }
        });
      }

      if (cmd.status === 'completed') {
        term.writeln(`  \x1b[90m[Exit code: ${cmd.exitCode}]\x1b[0m`);
      } else if (cmd.status === 'error') {
        term.writeln(`  \x1b[31m[Command failed]\x1b[0m`);
      }

      term.writeln('');
    });

    // Show current streaming output
    if (currentOutput) {
      const outputLines = currentOutput.split('\n');
      outputLines.forEach((line) => {
        if (line.trim()) {
          term.writeln(`  ${line}`);
        }
      });
    }

    // Show input prompt
    if (isConnected) {
      term.writeln('');
      term.write('\x1b[1;32m$\x1b[0m ');
    }

    // Auto scroll to bottom
    term.scrollToBottom();
  }, [commands, currentOutput, isConnected]);

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isVisible || !isConnected) return;

      // Focus input on '/' key when not typing elsewhere
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault();
        inputRef.current?.focus();
      }

      // Toggle visibility with Ctrl+`
      if (e.key === '`' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        toggleVisibility();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isVisible, isConnected, toggleVisibility]);

  const handleSendCommand = () => {
    if (!inputValue.trim() || !isConnected) return;

    sendCommand(inputValue.trim());
    setInputValue('');
    setIsInputMode(false);

    // Refocus input for next command
    setTimeout(() => inputRef.current?.focus(), 100);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSendCommand();
    } else if (e.key === 'Escape') {
      setIsInputMode(false);
    }
  };

  if (!isVisible) {
    return null;
  }

  return (
    <div className={getPanelClass()}>
      {/* Header */}
      <div className="terminal-header">
        <div className="terminal-title">
          <TerminalIcon className="w-4 h-4" />
          <span>{t('Shared Terminal')}</span>
          {!isConnected && (
            <span className="terminal-status disconnected">{t('Disconnected')}</span>
          )}
          {isConnected && <span className="terminal-status connected">{t('Connected')}</span>}
        </div>
        <div className="terminal-actions">
          {/* Generate Skill Button */}
          <button
            onClick={() => {
              setIsGeneratingSkill(true);
              onGenerateSkill?.();
              setTimeout(() => setIsGeneratingSkill(false), 3000);
            }}
            className="terminal-btn skill-btn"
            title={t('Generate Skill from terminal history')}
            disabled={!isConnected || isGeneratingSkill}
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>{t('Generate Skill')}</span>
          </button>

          <button onClick={clearTerminal} className="terminal-btn" title={t('Clear Terminal')}>
            <Trash2 className="w-4 h-4" />
          </button>

          {/* Minimize/Expand toggle */}
          <button
            onClick={() => {
              if (isExpanded) {
                // From expanded -> minimized (header only)
                toggleExpanded();
              } else {
                // From minimized -> expanded
                toggleExpanded();
              }
            }}
            className="terminal-btn"
            title={isExpanded ? t('Minimize') : t('Expand')}
          >
            {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
          </button>

          <button onClick={toggleVisibility} className="terminal-btn" title={t('Close')}>
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Terminal Content - only render when not minimized */}
      {!isExpanded && isVisible && (
        <div className="terminal-content">
          <div ref={terminalRef} className="terminal-instance" />
        </div>
      )}

      {/* Input Area - only show when expanded */}
      {isExpanded && isConnected && (
        <div className="terminal-input-area">
          <span className="terminal-prompt">$</span>
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setIsInputMode(true)}
            onBlur={() => setIsInputMode(false)}
            placeholder={isInputMode ? t('Type command...') : t('Focus to type (or press /)')}
            className="terminal-input"
            disabled={!isConnected}
          />
          <button
            onClick={handleSendCommand}
            className="terminal-send-btn"
            disabled={!inputValue.trim() || !isConnected}
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Help Text - only show when expanded */}
      {isExpanded && (
        <div className="terminal-help">
          <span>
            Ctrl+` {t('toggle')} • / {t('focus')} • Esc {t('blur')}
          </span>
        </div>
      )}
    </div>
  );
}
