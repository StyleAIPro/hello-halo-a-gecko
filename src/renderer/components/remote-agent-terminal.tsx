/**
 * Remote Agent Terminal Component
 * Displays command output from remote server operations
 */

import React from 'react';
import { Terminal, Minimize2, CheckCircle2, XCircle } from 'lucide-react';

interface TerminalEntry {
  id: string;
  timestamp: number;
  type: 'command' | 'output' | 'error' | 'success';
  content: string;
}

export function RemoteAgentTerminal({
  entries,
  isOpen,
  onClose,
}: {
  entries: TerminalEntry[];
  isOpen: boolean;
  onClose: () => void;
}) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-4 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-card border border-border rounded-xl w-full max-w-4xl max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Terminal className="w-5 h-5 text-primary" />
            <h3 className="text-lg font-semibold">{`Remote Server Terminal`}</h3>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-secondary/10 rounded-lg transition-colors"
          >
            <Minimize2 className="w-5 h-5 text-muted-foreground" />
          </button>
        </div>

        {/* Terminal Output */}
        <div className="flex-1 overflow-auto p-4 bg-neutral-950 font-mono text-sm">
          {entries.length === 0 ? (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              <p>No output yet...</p>
            </div>
          ) : (
            <div className="space-y-2">
              {entries.map((entry) => (
                <div key={entry.id} className="flex gap-2">
                  <span className="text-muted-foreground/50 text-xs shrink-0">
                    {new Date(entry.timestamp).toLocaleTimeString()}
                  </span>
                  {entry.type === 'command' && (
                    <span className="text-primary font-semibold">$ {entry.content}</span>
                  )}
                  {entry.type === 'output' && (
                    <span className="text-green-400">{entry.content}</span>
                  )}
                  {entry.type === 'error' && (
                    <span className="text-red-400 flex items-start gap-1.5">
                      <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>{entry.content}</span>
                    </span>
                  )}
                  {entry.type === 'success' && (
                    <span className="text-green-500 flex items-start gap-1.5">
                      <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>{entry.content}</span>
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
