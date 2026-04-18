/**
 * SharedTerminalPanel - 人机共享终端面板
 *
 * 布局：左右分栏
 * - 左侧：Agent Terminal 显示区（只读，xterm.js 渲染）
 * - 右侧：用户 Terminal 区（真实 PTY，可输入）
 */

import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import {
  Terminal as TerminalIcon,
  PanelLeft,
  PanelLeftClose,
  Download,
  ArrowRightToLine,
  MessageSquarePlus,
} from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useTranslation } from '../../i18n';
import { api, onEvent } from '../../api';
import { useAgentCommandViewerStore } from '../../stores/agent-command.store';
import { useUserTerminalStore } from '../../stores/user-terminal.store';

import '@xterm/xterm/css/xterm.css';
import './SharedTerminalPanel.css';

interface SharedTerminalPanelProps {
  spaceId: string;
  conversationId: string;
  isVisible?: boolean;
}

export function SharedTerminalPanel({
  spaceId,
  conversationId,
  isVisible: parentIsVisible,
}: SharedTerminalPanelProps) {
  const { t } = useTranslation();

  // Refs for terminal containers
  const agentTerminalRef = useRef<HTMLDivElement>(null);
  const userTerminalRef = useRef<HTMLDivElement>(null);
  const resizeHandleRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Refs for terminal instances
  const agentXtermRef = useRef<Terminal | null>(null);
  const userXtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const userFitAddonRef = useRef<FitAddon | null>(null);

  // State
  const [terminalStatus, setTerminalStatus] = useState<'connected' | 'disconnected' | 'connecting'>(
    'disconnected',
  );
  // 默认收起 Agent Panel，有活动时通过状态点提示
  const [showAgentPanel, setShowAgentPanel] = useState(false);
  // Agent Terminal 状态：'idle' | 'running' | 'completed'
  const [agentTerminalStatus, setAgentTerminalStatus] = useState<'idle' | 'running' | 'completed'>(
    'idle',
  );
  // Agent panel width percentage (for resize handle)
  const [agentPaneWidth, setAgentPaneWidth] = useState(40);

  // Selection popup state for user terminal
  const [selectionPopup, setSelectionPopup] = useState<{
    visible: boolean;
    text: string;
    x: number;
    y: number;
  }>({ visible: false, text: '', x: 0, y: 0 });

  const isVisible = parentIsVisible !== undefined ? parentIsVisible : true;

  // Track if terminals have been initialized (to avoid re-initialization)
  const agentTerminalInitialized = useRef(false);
  const userTerminalInitialized = useRef(false);

  // WebSocket ref for direct terminal input
  const terminalWebSocketRef = useRef<WebSocket | null>(null);

  // Heartbeat timer ref (sends periodic pings to keep connection alive)
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Reconnect timer ref (exponential backoff on disconnection)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);

  // Connection guard: tracks the current connection attempt's ID.
  // Incremented when starting a new connection to invalidate previous in-flight attempts.
  const connectionGenerationRef = useRef(0);

  // Track if WebSocket is the active channel for agent terminal output
  // When WebSocket is connected, IPC handlers should NOT write to xterm to avoid duplicates
  const isWebSocketActiveRef = useRef(false);

  // Track if we received history output (to avoid sending extra \r on reconnection)
  const receivedHistoryRef = useRef(false);

  // Track if we have replayed history for current conversation (to avoid duplicate replay)
  const historyReplayedRef = useRef(false);

  // Track the last conversationId that was replayed (to detect conversation switches)
  const lastReplayedConversationIdRef = useRef<string | null>(null);

  // Track which commands have shown "正在执行..." placeholder and line count (shared between IPC and WebSocket handlers)
  const placeholderShownMap = useRef<Map<string, number>>(new Map());

  // Resize handle logic
  useEffect(() => {
    const handleResize = (e: MouseEvent) => {
      if (!containerRef.current) return;
      const containerRect = containerRef.current.getBoundingClientRect();
      const newWidth = ((e.clientX - containerRect.left) / containerRect.width) * 100;
      // Clamp between 20% and 80%
      const clampedWidth = Math.max(20, Math.min(80, newWidth));
      setAgentPaneWidth(clampedWidth);

      // Fit terminals to new size
      if (fitAddonRef.current) {
        fitAddonRef.current.fit();
      }
      if (userFitAddonRef.current) {
        userFitAddonRef.current.fit();
      }
    };

    const stopResize = () => {
      document.removeEventListener('mousemove', handleResize);
      document.removeEventListener('mouseup', stopResize);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    const startResize = () => {
      document.addEventListener('mousemove', handleResize);
      document.addEventListener('mouseup', stopResize);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    };

    const resizeHandle = resizeHandleRef.current;
    if (resizeHandle && showAgentPanel) {
      resizeHandle.addEventListener('mousedown', startResize);
    }

    return () => {
      if (resizeHandle) {
        resizeHandle.removeEventListener('mousedown', startResize);
      }
      document.removeEventListener('mousemove', handleResize);
      document.removeEventListener('mouseup', stopResize);
    };
  }, [showAgentPanel]);

  // Get commands from store for current conversation
  const { getCommandsForConversation, loadCommandsForConversation, exportToMarkdown } =
    useAgentCommandViewerStore();
  const currentCommands = getCommandsForConversation(conversationId);

  // Load persisted commands when conversation changes
  // Always force reload to ensure we have the latest commands
  useEffect(() => {
    if (spaceId && conversationId) {
      console.log(
        '[SharedTerminal] Force loading persisted commands for conversation:',
        conversationId,
      );
      // Force reload commands from disk (pass true for forceReload)
      loadCommandsForConversation(spaceId, conversationId, true);
      // Reset history replay flag when conversation changes
      historyReplayedRef.current = false;
    }
  }, [spaceId, conversationId]);

  // Replay command history when commands are loaded (after terminal initialization)
  // This effect handles:
  // 1. Initial load when terminal is first created
  // 2. Reloading when conversationId changes
  // 3. Reloading when terminal panel is reopened
  useEffect(() => {
    // Only replay if:
    // 1. Terminal is initialized
    // 2. Commands are loaded
    // 3. We haven't replayed yet for this conversation (check by comparing conversationId)
    const term = agentXtermRef.current;
    if (!term) {
      console.log('[SharedTerminal] Terminal not ready for history replay');
      return;
    }

    // Check if this is a new conversation or if we need to replay
    const isNewConversation = lastReplayedConversationIdRef.current !== conversationId;
    const hasCommands = currentCommands.length > 0;

    if (isNewConversation) {
      // Reset replay flag for new conversation
      historyReplayedRef.current = false;
      lastReplayedConversationIdRef.current = conversationId;

      // Clear terminal for new conversation
      term.clear();
      term.writeln(
        '\x1b[1;36m╔═══════════════════════════════════════════════════════════╗\x1b[0m',
      );
      term.writeln(
        '\x1b[1;36m║\x1b[0m  \x1b[1;33m🤖 Agent Terminal\x1b[0m - Read Only                      \x1b[1;36m║\x1b[0m',
      );
      term.writeln(
        '\x1b[1;36m╚═══════════════════════════════════════════════════════════╝\x1b[0m',
      );
      term.writeln('');
    }

    // Replay if we have commands and haven't replayed yet for this conversation
    if (hasCommands && !historyReplayedRef.current) {
      historyReplayedRef.current = true;
      console.log(
        `[SharedTerminal] Replaying ${currentCommands.length} commands for ${conversationId}`,
      );

      term.writeln(`\x1b[90m--- ${currentCommands.length} historical command(s) ---\x1b[0m`);
      term.writeln('');

      currentCommands.forEach((cmd) => {
        // Format environment label like a real terminal prompt
        // cwdLabel format: "user@host path % " -> extract parts
        const promptText = cmd.cwdLabel || cmd.pathOnly || '~';
        const cleanPrompt = promptText.trim();

        // Display environment label on its own line for clarity
        term.writeln(`\x1b[1;36m┌─\x1b[0m \x1b[1;33m${cleanPrompt}\x1b[0m`);
        term.writeln(`\x1b[1;36m└─\x1b[0m\x1b[1;32m$\x1b[0m \x1b[1m${cmd.command}\x1b[0m`);

        if (cmd.output) {
          const outputLines = cmd.output.split('\n');
          outputLines.forEach((line) => {
            term.writeln(`\x1b[90m${line}\x1b[0m`);
          });
        }
        if (cmd.exitCode !== null) {
          if (cmd.exitCode === 0) {
            term.writeln(`\x1b[90m[Process completed - exit code: ${cmd.exitCode}]\x1b[0m`);
          } else {
            term.writeln(`\x1b[31m[Process failed - exit code: ${cmd.exitCode}]\x1b[0m`);
          }
        }
        term.writeln('');
      });

      term.writeln('\x1b[90m--- End of history ---\x1b[0m');
      term.writeln('');
      // Scroll to top so user can see history from the beginning
      // They can scroll down to see more recent commands
      term.scrollToTop();
    } else if (!hasCommands && isNewConversation) {
      // Show placeholder if no commands
      term.writeln('\x1b[90mAgent 执行的命令和结果将显示在此处...\x1b[0m');
      term.writeln('');
    }
  }, [currentCommands, conversationId]);

  // Unified agent command rendering to xterm (used by both IPC and WebSocket handlers)
  const writeAgentCommandStart = useCallback(
    (msg: { command: string; cwdLabel?: string; pathOnly?: string }) => {
      const agentTerm = agentXtermRef.current;
      if (!agentTerm) return;
      const promptText = msg.cwdLabel || msg.pathOnly || '~';
      const cleanPrompt = promptText.trim();
      agentTerm.writeln('');
      agentTerm.writeln(`\x1b[1;36m┌─\x1b[0m \x1b[1;33m${cleanPrompt}\x1b[0m`);
      agentTerm.writeln(`\x1b[1;36m└─\x1b[0m\x1b[1;32m$\x1b[0m \x1b[1m${msg.command}\x1b[0m`);
      agentTerm.scrollToBottom();
    },
    [],
  );

  const writeAgentCommandOutput = useCallback(
    (commandId: string, output: string, isStream: boolean) => {
      const agentTerm = agentXtermRef.current;
      if (!agentTerm || !output) return;

      const isPlaceholder = isStream && output.includes('正在执行');
      const placeholderLines = placeholderShownMap.current.get(commandId);

      if (isPlaceholder) {
        const outputLines = output.split('\n').filter((l) => l.length > 0);
        placeholderShownMap.current.set(commandId, outputLines.length);
        outputLines.forEach((line) => {
          agentTerm.writeln(line);
        });
        agentTerm.scrollToBottom();
      } else if (placeholderLines != null && !isStream) {
        // Real output after placeholder - clear placeholder lines first
        for (let i = 0; i < placeholderLines; i++) {
          agentTerm.write('\x1b[1A\x1b[2K');
        }
        const outputLines = output.split('\n');
        outputLines.forEach((line) => {
          agentTerm.writeln(`\x1b[90m${line}\x1b[0m`);
        });
        agentTerm.scrollToBottom();
        placeholderShownMap.current.delete(commandId);
      } else {
        const outputLines = output.split('\n');
        outputLines.forEach((line) => {
          agentTerm.writeln(`\x1b[90m${line}\x1b[0m`);
        });
        agentTerm.scrollToBottom();
      }
    },
    [],
  );

  const writeAgentCommandComplete = useCallback((exitCode: number) => {
    const agentTerm = agentXtermRef.current;
    if (!agentTerm) return;
    if (exitCode === 0) {
      agentTerm.writeln(`\x1b[90m[Process completed - exit code: ${exitCode}]\x1b[0m`);
    } else {
      agentTerm.writeln(`\x1b[31m[Process failed - exit code: ${exitCode}]\x1b[0m`);
    }
    agentTerm.scrollToBottom();
  }, []);

  // Listen for IPC events from main process (for when WebSocket is not connected)
  useEffect(() => {
    const cleanupFns: (() => void)[] = [];

    // Listen for agent command start
    const unsubStart = onEvent('terminal:agent-command-start', (data: unknown) => {
      const msg = data as {
        id: string;
        command: string;
        cwd?: string;
        cwdLabel?: string;
        pathOnly?: string;
        timestamp: string;
        conversationId: string;
      };

      // Only process if it's for our conversation
      if (msg.conversationId === conversationId) {
        const { _onAgentCommandStart } = useAgentCommandViewerStore.getState();
        _onAgentCommandStart({
          id: msg.id,
          command: msg.command,
          timestamp: msg.timestamp,
          conversationId: msg.conversationId,
          cwd: msg.cwd,
          cwdLabel: msg.cwdLabel,
          pathOnly: msg.pathOnly,
        });
        setAgentTerminalStatus('running');

        // Write to Agent Terminal xterm only if WebSocket is NOT active
        if (!isWebSocketActiveRef.current) {
          writeAgentCommandStart(msg);
        }
      }
    });
    cleanupFns.push(unsubStart);

    // Listen for agent command output
    const unsubOutput = onEvent('terminal:agent-command-output', (data: unknown) => {
      const msg = data as {
        commandId: string;
        output: string;
        isStream: boolean;
        conversationId?: string;
        spaceId?: string;
      };

      // Only process if it's for our conversation (if conversationId is provided)
      if (msg.conversationId && msg.conversationId !== conversationId) {
        return;
      }

      const { _onAgentCommandOutput } = useAgentCommandViewerStore.getState();
      _onAgentCommandOutput(msg.commandId, msg.output);

      // Write to Agent Terminal xterm only if WebSocket is NOT active
      if (msg.output && !isWebSocketActiveRef.current) {
        writeAgentCommandOutput(msg.commandId, msg.output, msg.isStream);
      }
    });
    cleanupFns.push(unsubOutput);

    // Listen for agent command complete
    const unsubComplete = onEvent('terminal:agent-command-complete', (data: unknown) => {
      const msg = data as {
        commandId: string;
        exitCode: number;
        conversationId?: string;
        spaceId?: string;
      };

      // Only process if it's for our conversation (if conversationId is provided)
      if (msg.conversationId && msg.conversationId !== conversationId) {
        return;
      }

      const { _onAgentCommandComplete } = useAgentCommandViewerStore.getState();
      _onAgentCommandComplete(msg.commandId, msg.exitCode);
      setAgentTerminalStatus('completed');

      // Write completion to Agent Terminal xterm only if WebSocket is NOT active
      if (!isWebSocketActiveRef.current) {
        writeAgentCommandComplete(msg.exitCode);
      }
    });
    cleanupFns.push(unsubComplete);

    return () => {
      cleanupFns.forEach((fn) => fn());
    };
  }, [conversationId]);

  // Cleanup timers and stale connections on unmount or conversation change
  useEffect(() => {
    return () => {
      if (heartbeatTimerRef.current) {
        clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = null;
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      // Bump generation to invalidate any in-flight connection attempt
      connectionGenerationRef.current++;
      // Close any existing WebSocket (it will be recreated for the new conversation)
      if (terminalWebSocketRef.current) {
        terminalWebSocketRef.current.close();
        terminalWebSocketRef.current = null;
      }
      isWebSocketActiveRef.current = false;
    };
  }, [conversationId]);

  // Reset agent terminal status when conversation changes
  useEffect(() => {
    setAgentTerminalStatus('idle');
  }, [conversationId]);

  // Reset terminal initialization flags when conversation changes
  // CRITICAL: Use useLayoutEffect instead of useEffect to ensure this runs BEFORE the initialization effect
  useLayoutEffect(() => {
    agentTerminalInitialized.current = false;
    userTerminalInitialized.current = false;
    // also dispose existing terminals when conversation changes
    if (agentXtermRef.current) {
      agentXtermRef.current.dispose();
      agentXtermRef.current = null;
    }
    if (userXtermRef.current) {
      userXtermRef.current.dispose();
      userXtermRef.current = null;
    }
  }, [conversationId]);

  // Initialize Agent Terminal (left side - read only)
  // CRITICAL: Always initialize Agent Terminal regardless of visibility
  // This ensures the terminal can receive and buffer data even when the panel is hidden
  // The terminal data comes from IPC events which are received regardless of panel visibility
  useEffect(() => {
    // Only check for DOM element and avoid re-initialization
    if (!agentTerminalRef.current || agentTerminalInitialized.current) return;

    console.log('[SharedTerminal] Initializing agent terminal (isVisible:', isVisible, ')');
    agentTerminalInitialized.current = true;

    const term = new Terminal({
      cursorBlink: false,
      cursorStyle: 'underline',
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#1a1a2e',
        foreground: '#a0a0a0',
        cursor: '#a0a0a0',
        selection: 'rgba(255, 255, 255, 0.2)',
        black: '#1a1a2e',
        red: '#ff6b6b',
        green: '#50fa7b',
        yellow: '#f1fa8c',
        blue: '#6eb5ff',
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
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(agentTerminalRef.current);
    // Only call fit() if the panel is visible (has dimensions)
    // When hidden (display: none), fit() would fail silently
    const element = agentTerminalRef.current;
    if (element && element.offsetWidth > 0 && element.offsetHeight > 0) {
      fitAddon.fit();
    }

    agentXtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Note: Header is displayed in the history replay effect
    // to avoid duplication and ensure proper timing

    // Trigger history replay after terminal is initialized
    // This ensures the replay effect runs after the terminal is ready
    const commands = getCommandsForConversation(conversationId);
    if (commands.length > 0) {
      console.log(
        `[SharedTerminal] Terminal initialized, triggering replay of ${commands.length} commands`,
      );
      // Reset replay flag to allow replay
      historyReplayedRef.current = false;
      // Don't reset lastReplayedConversationIdRef - let the effect handle it properly
    }

    // Resize observer - only fit when panel is visible (has dimensions)
    const resizeObserver = new ResizeObserver(() => {
      // Check if the element has visible dimensions (not display: none)
      const element = agentTerminalRef.current;
      if (element && element.offsetWidth > 0 && element.offsetHeight > 0) {
        fitAddon.fit();
      }
    });
    resizeObserver.observe(agentTerminalRef.current);

    return () => {
      resizeObserver.disconnect();
      term.dispose();
      agentTerminalInitialized.current = false;
    };
  }, [isVisible, conversationId]);

  // Fit agent terminal when panel is expanded
  useEffect(() => {
    if (showAgentPanel && fitAddonRef.current) {
      // Delay to allow CSS transition to complete
      const timer = setTimeout(() => {
        fitAddonRef.current?.fit();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [showAgentPanel]);

  // Initialize User Terminal (right side - real PTY with direct input)
  useEffect(() => {
    if (!userTerminalRef.current || !isVisible || userTerminalInitialized.current) return;

    console.log('[SharedTerminal] Initializing user terminal...');

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 13,
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
      disableStdin: false,
      allowProposedApi: true,
      rightClickSelectsWord: true,
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true,
      // Intercept key events BEFORE xterm.js processes them
      // This ensures selection is still available when we handle Ctrl+C copy
      customKeyEventHandler: (event: KeyboardEvent) => {
        const isCtrlOrCmd = event.ctrlKey || event.metaKey;
        if (!isCtrlOrCmd) return false;

        // Ctrl/Cmd + Shift + C: always copy (standard terminal shortcut)
        if (event.key.toLowerCase() === 'c' && event.shiftKey) {
          const selection = term.getSelection();
          if (selection) {
            navigator.clipboard.writeText(selection).catch(console.error);
            term.clearSelection();
            event.preventDefault();
            return true; // prevent xterm.js from processing
          }
        }

        // Ctrl/Cmd + C: copy if selection exists, otherwise send SIGINT (\x03) to terminal
        if (event.key.toLowerCase() === 'c' && !event.shiftKey) {
          if (term.hasSelection()) {
            const selection = term.getSelection();
            navigator.clipboard.writeText(selection).catch(console.error);
            term.clearSelection();
            event.preventDefault();
            return true; // prevent xterm.js from processing (don't send \x03 to PTY)
          }
          // No selection - let xterm.js send \x03 (SIGINT) to PTY
          return false;
        }

        // Ctrl/Cmd + V: let onData handler handle paste via clipboard API
        // (handled below in onData, don't intercept here)
        if (event.key.toLowerCase() === 'v') {
          return false;
        }

        return false;
      },
    });

    const userFitAddon = new FitAddon();
    term.loadAddon(userFitAddon);
    term.open(userTerminalRef.current);
    userFitAddon.fit();

    userXtermRef.current = term;
    userFitAddonRef.current = userFitAddon;
    userTerminalInitialized.current = true;

    // Display header
    term.writeln('\x1b[1;36m╔═══════════════════════════════════════════════════════════╗\x1b[0m');
    term.writeln(
      '\x1b[1;36m║\x1b[0m  \x1b[1;32m👤 Your Terminal\x1b[0m - Interactive                        \x1b[1;36m║\x1b[0m',
    );
    term.writeln('\x1b[1;36m╚═══════════════════════════════════════════════════════════╝\x1b[0m');
    term.writeln('');
    term.writeln('\x1b[90mType commands directly in this terminal\x1b[0m');
    term.writeln('\x1b[90mPress Ctrl+` to toggle Agent Commands panel\x1b[0m');
    term.writeln('');

    // Selection popup - use mouseup event to capture selection and position
    const handleMouseUp = (e: MouseEvent) => {
      // Small delay to ensure selection is complete
      setTimeout(() => {
        const selection = term.getSelection();
        console.log('[SharedTerminal] Mouse up, selection:', selection?.length || 0, 'chars');

        if (selection && selection.trim().length > 0) {
          // Position popup near the mouse cursor
          const x = e.clientX - 60; // Center the popup
          const y = e.clientY + 10; // Slightly below cursor

          console.log('[SharedTerminal] Showing popup at:', x, y);
          setSelectionPopup({
            visible: true,
            text: selection,
            x: x,
            y: y,
          });
        }
      }, 10);
    };

    // Also listen for selection changes to hide popup when selection is cleared
    const selectionDisposable = term.onSelectionChange(() => {
      const selection = term.getSelection();
      if (!selection || selection.trim().length === 0) {
        setSelectionPopup((prev) => (prev.visible ? { ...prev, visible: false } : prev));
      }
    });

    const container = userTerminalRef.current;
    if (container) {
      container.addEventListener('mouseup', handleMouseUp);
    }

    // DOM-level keydown interceptor as fallback for Ctrl+C/Ctrl+V
    // Runs in capture phase (before xterm.js and Electron menu can intercept)
    const handleKeyDownCapture = (e: KeyboardEvent) => {
      const isCtrlOrCmd = e.ctrlKey || e.metaKey;
      if (!isCtrlOrCmd) return;

      if (e.key.toLowerCase() === 'c' && !e.shiftKey && term.hasSelection()) {
        // Ctrl+C with selection: copy to clipboard, prevent all default behavior
        e.preventDefault();
        e.stopPropagation();
        const selection = term.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection).catch(console.error);
        }
        term.clearSelection();
      }
    };
    // Use capture phase to intercept before Electron/xterm.js
    userTerminalRef.current?.addEventListener('keydown', handleKeyDownCapture, true);

    // Resize observer - also notify backend about terminal size changes
    const resizeObserver = new ResizeObserver(() => {
      userFitAddon.fit();
      // Send resize to backend PTY/SSH
      const ws = terminalWebSocketRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        const cols = term.cols;
        const rows = term.rows;
        if (cols && rows) {
          ws.send(
            JSON.stringify({
              type: 'terminal:resize',
              data: { cols, rows },
            }),
          );
        }
      }
    });
    resizeObserver.observe(userTerminalRef.current);

    return () => {
      resizeObserver.disconnect();
      selectionDisposable.dispose();
      if (container) {
        container.removeEventListener('mouseup', handleMouseUp);
      }
      userTerminalRef.current?.removeEventListener('keydown', handleKeyDownCapture, true);
      // NOTE: Do NOT dispose the terminal - keep it for re-use when panel reopens
    };
  }, [isVisible, conversationId]);

  // Handle user terminal WebSocket messages
  // MUST be defined before startConnection to avoid TDZ (Temporal Dead Zone) error
  const handleUserTerminalMessage = useCallback(
    (message: any, ws: WebSocket) => {
      const term = userXtermRef.current;
      const { _onAgentCommandStart, _onAgentCommandOutput, _onAgentCommandComplete } =
        useAgentCommandViewerStore.getState();

      switch (message.type) {
        case 'terminal:data':
          if (term && message.data?.content) {
            term.write(message.data.content);
          }
          break;

        case 'terminal:agent-command-start':
          if (message.data?.conversationId && message.data.conversationId !== conversationId) {
            break;
          }
          _onAgentCommandStart({
            id: message.data.id,
            command: message.data.command,
            timestamp: message.data.timestamp,
            conversationId: message.data.conversationId,
            cwd: message.data.cwd,
            cwdLabel: message.data.cwdLabel,
            pathOnly: message.data.pathOnly,
          });
          setAgentTerminalStatus('running');
          writeAgentCommandStart(message.data);
          break;

        case 'terminal:agent-command-output':
          _onAgentCommandOutput(message.data.commandId, message.data.output);
          if (message.data.output) {
            writeAgentCommandOutput(
              message.data.commandId,
              message.data.output,
              message.data.isStream,
            );
          }
          break;

        case 'terminal:agent-command-complete':
          _onAgentCommandComplete(message.data.commandId, message.data.exitCode);
          setAgentTerminalStatus('completed');
          writeAgentCommandComplete(message.data.exitCode);
          break;

        case 'terminal:ready':
          break;

        case 'terminal:exit':
          if (term) {
            term.writeln('');
            term.writeln('\x1b[31mTerminal session exited\x1b[0m');
          }
          setTerminalStatus('disconnected');
          break;

        case 'terminal:history-output':
          if (term && message.data?.content) {
            receivedHistoryRef.current = true;
            term.clear();
            term.write(message.data.content);
          }
          break;
      }
    },
    [conversationId, writeAgentCommandStart, writeAgentCommandOutput, writeAgentCommandComplete],
  );

  // Helper: cancel any pending reconnect and stop heartbeat
  const cancelTimers = useCallback(() => {
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  // Helper: schedule a reconnect attempt (used by onclose)
  const scheduleReconnect = useCallback(() => {
    cancelTimers();
    reconnectAttemptRef.current++;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttemptRef.current - 1), 30000);
    console.log(
      `[SharedTerminal] Reconnecting in ${delay}ms (attempt ${reconnectAttemptRef.current})`,
    );

    reconnectTimerRef.current = setTimeout(() => {
      // Check latest state via refs instead of stale closure values
      if (userTerminalInitialized.current && userXtermRef.current) {
        // Don't reconnect if already connected
        const currentWs = terminalWebSocketRef.current;
        if (currentWs && currentWs.readyState === WebSocket.OPEN) return;
        console.log('[SharedTerminal] Auto-reconnecting...');
        startConnection();
      }
    }, delay);
  }, [cancelTimers]);

  // Core connection function - uses generation guard to prevent concurrent connections
  const startConnection = useCallback(() => {
    // Bump generation to invalidate any previous in-flight connection
    const gen = ++connectionGenerationRef.current;

    // If already connected, just focus
    if (
      terminalWebSocketRef.current &&
      terminalWebSocketRef.current.readyState === WebSocket.OPEN
    ) {
      userXtermRef.current?.focus();
      setTerminalStatus('connected');
      return;
    }

    // Clean up stale WebSocket
    if (terminalWebSocketRef.current) {
      terminalWebSocketRef.current = null;
    }

    api
      .getTerminalWebSocketUrl(spaceId, conversationId)
      .then((result) => {
        // Guard: another connection was started while we were waiting
        if (connectionGenerationRef.current !== gen) {
          console.log('[SharedTerminal] Connection generation mismatch, aborting stale connection');
          return;
        }

        const wsUrl = result.data?.wsUrl;
        if (!wsUrl) {
          console.error('[SharedTerminal] Failed to get WebSocket URL');
          setTerminalStatus('disconnected');
          return;
        }

        const ws = new WebSocket(wsUrl);
        terminalWebSocketRef.current = ws;

        ws.onopen = () => {
          // Guard: check generation again
          if (connectionGenerationRef.current !== gen) {
            console.log('[SharedTerminal] Stale connection opened, closing');
            ws.close();
            return;
          }

          console.log('[SharedTerminal] User terminal connected');
          setTerminalStatus('connected');
          isWebSocketActiveRef.current = true;
          reconnectAttemptRef.current = 0; // Reset reconnect counter on successful connect

          // Start heartbeat to keep connection alive
          if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
          heartbeatTimerRef.current = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'ping' }));
            }
          }, 30000); // Send ping every 30s

          const term = userXtermRef.current;
          if (term) {
            // Dispose old data handler if exists
            if ((term as any)._onDataDisposable) {
              (term as any)._onDataDisposable.dispose();
            }

            const onDataDisposable = term.onData((data: string) => {
              if (ws.readyState === WebSocket.OPEN) {
                if (data === '\x16') {
                  navigator.clipboard
                    .readText()
                    .then((clipboardText) => {
                      if (clipboardText && ws.readyState === WebSocket.OPEN) {
                        const normalizedText = clipboardText
                          .replace(/\r\n/g, '\n')
                          .replace(/\r/g, '\n');
                        ws.send(
                          JSON.stringify({
                            type: 'terminal:raw-input',
                            data: { input: normalizedText },
                          }),
                        );
                      }
                    })
                    .catch(() => {});
                  return;
                }

                ws.send(
                  JSON.stringify({
                    type: 'terminal:raw-input',
                    data: { input: data },
                  }),
                );
              }
            });
            (term as any)._onDataDisposable = onDataDisposable;

            // Reset history flag on new connection
            receivedHistoryRef.current = false;

            // Send a newline to trigger shell to display prompt
            setTimeout(() => {
              if (
                ws.readyState === WebSocket.OPEN &&
                userXtermRef.current &&
                !receivedHistoryRef.current
              ) {
                ws.send(
                  JSON.stringify({
                    type: 'terminal:raw-input',
                    data: { input: '\r' },
                  }),
                );
              }
            }, 150);

            term.focus();
          }
        };

        ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data);
            handleUserTerminalMessage(message, ws);
          } catch (error) {
            console.error('[SharedTerminal] Failed to parse message:', error);
          }
        };

        ws.onclose = (event) => {
          // Guard: only process close for the current generation
          if (connectionGenerationRef.current !== gen) {
            return; // Old connection closed, ignore
          }

          console.log('[SharedTerminal] User terminal disconnected', {
            code: event.code,
            wasClean: event.wasClean,
          });
          setTerminalStatus('disconnected');
          isWebSocketActiveRef.current = false;

          // Stop heartbeat
          if (heartbeatTimerRef.current) {
            clearInterval(heartbeatTimerRef.current);
            heartbeatTimerRef.current = null;
          }

          // Auto-reconnect with exponential backoff
          // Only if this is still the current generation (no new connection started)
          if (connectionGenerationRef.current === gen) {
            scheduleReconnect();
          }
        };

        ws.onerror = (error) => {
          console.error('[SharedTerminal] User terminal error:', error);
        };
      })
      .catch((error) => {
        if (connectionGenerationRef.current !== gen) return; // Stale
        console.error('[SharedTerminal] Connection error:', error);
        setTerminalStatus('disconnected');
        scheduleReconnect();
      });
  }, [spaceId, conversationId, scheduleReconnect, handleUserTerminalMessage]);

  // Connect to user terminal session
  // Handles both initial connection and reconnection when panel is reopened
  useEffect(() => {
    // Only connect when visible and terminal is initialized
    if (!isVisible || !userTerminalInitialized.current || !userXtermRef.current) {
      return;
    }

    // Skip if already connected
    if (
      terminalWebSocketRef.current &&
      terminalWebSocketRef.current.readyState === WebSocket.OPEN
    ) {
      userXtermRef.current.focus();
      setTerminalStatus('connected');
      return;
    }

    console.log('[SharedTerminal] Starting WebSocket connection...');
    setTerminalStatus('connecting');

    // Small delay to ensure terminal is fully ready
    const timer = setTimeout(() => {
      startConnection();
    }, 50);

    return () => clearTimeout(timer);
  }, [isVisible, conversationId, startConnection]);

  // Keyboard shortcut: Ctrl+` to toggle agent panel
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === '`') {
        e.preventDefault();
        setShowAgentPanel((prev) => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Close selection popup when clicking outside or pressing Escape
  useEffect(() => {
    if (!selectionPopup.visible) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.selection-popup') && !target.closest('.xterm-selection')) {
        setSelectionPopup((prev) => ({ ...prev, visible: false }));
        const term = userXtermRef.current;
        if (term) {
          term.clearSelection();
        }
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectionPopup((prev) => ({ ...prev, visible: false }));
        const term = userXtermRef.current;
        if (term) {
          term.clearSelection();
        }
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [selectionPopup.visible]);

  // Handle export to markdown
  const handleExportCommands = useCallback(async () => {
    const commands = getCommandsForConversation(conversationId);
    if (commands.length === 0) {
      console.log('[SharedTerminal] No commands to export');
      return;
    }
    await exportToMarkdown(conversationId, spaceId);
  }, [conversationId, spaceId, getCommandsForConversation, exportToMarkdown]);

  // Handle append user terminal content to input
  const handleAppendToInput = useCallback(() => {
    const term = userXtermRef.current;
    if (!term) {
      console.log('[SharedTerminal] Terminal not ready');
      return;
    }

    // Get terminal content from xterm.js
    // Use the scrollback buffer to get all content
    const lines: string[] = [];
    const buffer = term.buffer.active;
    if (buffer) {
      const startLine = 0;
      const endLine = Math.min(buffer.length, startLine + 1000); // Limit to last 1000 lines
      for (let i = startLine; i < endLine; i++) {
        const line = buffer.getLine(i);
        if (line) {
          lines.push(line.translateToString(true));
        }
      }
    }

    const terminalContent = lines.join('\n');

    if (!terminalContent.trim()) {
      console.log('[SharedTerminal] No terminal content to append');
      return;
    }

    // Dispatch custom event to append to input
    const event = new CustomEvent('append-terminal-content', {
      detail: {
        content: `\`\`\`\n${terminalContent}\n\`\`\``,
      },
    });
    window.dispatchEvent(event);
    console.log('[SharedTerminal] Terminal content appended to input');
  }, []);

  // Handle send selected text to chat input
  const handleSendSelectionToInput = useCallback(() => {
    if (!selectionPopup.text.trim()) {
      return;
    }

    // Dispatch custom event to append to input
    const event = new CustomEvent('append-terminal-content', {
      detail: {
        content: `\`\`\`\n${selectionPopup.text}\n\`\`\``,
      },
    });
    window.dispatchEvent(event);
    console.log('[SharedTerminal] Selection sent to input:', selectionPopup.text.length, 'chars');

    // Hide popup and clear selection
    setSelectionPopup((prev) => ({ ...prev, visible: false }));
    const term = userXtermRef.current;
    if (term) {
      term.clearSelection();
    }
  }, [selectionPopup.text]);

  if (!isVisible) {
    return null;
  }

  return (
    <div className="shared-terminal-panel">
      {/* Header */}
      <div className="shared-terminal-header">
        <div className="shared-terminal-title">
          <TerminalIcon className="w-4 h-4" />
          <span>{t('Shared Terminal')}</span>
          <span className={`terminal-status ${terminalStatus}`}>
            {terminalStatus === 'connected'
              ? t('Connected')
              : terminalStatus === 'connecting'
                ? t('Connecting...')
                : t('Disconnected')}
          </span>
        </div>
        <div className="shared-terminal-actions">
          {/* Toggle Agent Terminal Panel - 带状态点提示 */}
          <button
            onClick={() => setShowAgentPanel((prev) => !prev)}
            className="terminal-btn"
            title={showAgentPanel ? t('Hide Agent Terminal') : t('Show Agent Terminal')}
          >
            <div className="agent-panel-toggle">
              {showAgentPanel ? (
                <PanelLeftClose className="w-4 h-4" />
              ) : (
                <PanelLeft className="w-4 h-4" />
              )}
              {/* 状态点：运行时闪烁蓝点，完成后绿点 */}
              {!showAgentPanel && agentTerminalStatus !== 'idle' && (
                <span className={`status-dot ${agentTerminalStatus}`}></span>
              )}
            </div>
          </button>
        </div>
      </div>

      {/* Terminal Content - Left/Right Split */}
      <div className="shared-terminal-body" data-show-agent={showAgentPanel} ref={containerRef}>
        {/* Left: Agent Terminal (collapsible) - Always render DOM, use CSS to hide */}
        <div
          className="terminal-pane agent-pane"
          style={{ display: showAgentPanel ? 'flex' : 'none', flexBasis: `${agentPaneWidth}%` }}
        >
          <div className="terminal-pane-header">
            <span className="pane-title">{t('Agent Terminal')}</span>
            <span className="pane-subtitle">{t('Read Only')}</span>
            {/* Export to Markdown - 仅在有命令时显示 */}
            <button
              onClick={handleExportCommands}
              className="terminal-btn pane-action-btn"
              title={t('Export to Markdown')}
            >
              <Download className="w-4 h-4" />
            </button>
          </div>
          <div ref={agentTerminalRef} className="terminal-instance agent-terminal" />
        </div>

        {/* Resize Handle */}
        {showAgentPanel && (
          <div className="terminal-resize-handle" ref={resizeHandleRef} title="Drag to resize" />
        )}

        {/* Right: User Terminal */}
        <div className="terminal-pane user-pane" data-full={!showAgentPanel}>
          <div className="terminal-pane-header">
            <span className="pane-title">{t('Your Terminal')}</span>
            <span className="pane-subtitle">
              {t('Interactive')} - {t('Type directly')}
            </span>
            {/* Append to Input - 将用户终端内容追加到输入框 */}
            <button
              onClick={handleAppendToInput}
              className="terminal-btn pane-action-btn"
              title={t('Append terminal content to input')}
            >
              <ArrowRightToLine className="w-4 h-4" />
            </button>
          </div>
          <div ref={userTerminalRef} className="terminal-instance user-terminal" />
        </div>
      </div>

      {/* Selection Popup - 显示在选中文本附近 */}
      {selectionPopup.visible && (
        <div
          className="selection-popup"
          style={{
            position: 'fixed',
            left: selectionPopup.x,
            top: selectionPopup.y + 5,
            zIndex: 1000,
          }}
        >
          <button
            className="selection-popup-btn"
            onClick={handleSendSelectionToInput}
            title={t('Send to chat input')}
          >
            <MessageSquarePlus className="w-4 h-4" />
            <span>{t('Send to Chat')}</span>
          </button>
        </div>
      )}
    </div>
  );
}
