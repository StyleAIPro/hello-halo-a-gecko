/**
 * ToolPermissionCard - Renders tool permission requests from the main agent
 *
 * When the AI agent wants to execute a high-risk operation (Bash, Write, Edit, etc.),
 * this card presents the request for the user to approve or deny before execution.
 */

import { useState, useEffect, useRef } from 'react';
import { ShieldAlert, ShieldCheck, Terminal, Pencil, FilePlus, FileEdit, BookOpen, CheckSquare } from 'lucide-react';
import { useTranslation } from '../../i18n';
import type { ToolPermissionRequest } from '../../types';

interface ToolPermissionCardProps {
  permission: ToolPermissionRequest;
  onResolve: (approved: boolean) => void;
}

const TOOL_ICONS: Record<string, React.ReactNode> = {
  Bash: <Terminal size={14} className="text-red-500" />,
  Write: <FilePlus size={14} className="text-amber-500" />,
  Edit: <Pencil size={14} className="text-amber-500" />,
  Create: <FilePlus size={14} className="text-amber-500" />,
  NotebookEdit: <BookOpen size={14} className="text-amber-500" />,
  TodoWrite: <CheckSquare size={14} className="text-amber-500" />,
  MultiEdit: <FileEdit size={14} className="text-amber-500" />,
};

const TOOL_RISK_LABELS: Record<string, string> = {
  Bash: 'bash',
  Write: 'write',
  Edit: 'edit',
  Create: 'create',
  NotebookEdit: 'notebook',
  TodoWrite: 'task',
  MultiEdit: 'multi-edit',
};

export function ToolPermissionCard({ permission, onResolve }: ToolPermissionCardProps) {
  const { t } = useTranslation();
  const [resolved, setResolved] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  // Auto-scroll into view when card mounts
  useEffect(() => {
    cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, []);

  const handleResolve = (approved: boolean) => {
    if (resolved) return;
    setResolved(true);
    onResolve(approved);
  };

  const { toolName, toolInput } = permission;
  const icon = TOOL_ICONS[toolName] || <ShieldAlert size={14} className="text-amber-500" />;

  // Format command for display
  const formatToolPreview = (): string => {
    if (toolName === 'Bash') {
      const cmd = String(toolInput.command || '');
      return cmd.length > 300 ? cmd.substring(0, 300) + '...' : cmd;
    }
    if (toolName === 'Write') {
      const filePath = String(toolInput.file_path || toolInput.path || '');
      const content = String(toolInput.content || '');
      const contentPreview = content.length > 200 ? content.substring(0, 200) + '...' : content;
      return contentPreview ? `${filePath}\n${contentPreview}` : filePath;
    }
    if (toolName === 'Edit') {
      const filePath = String(toolInput.file_path || '');
      const oldStr = String(toolInput.old_string || '');
      const newStr = String(toolInput.new_string || '');
      const truncate = (s: string) => (s.length > 100 ? s.substring(0, 100) + '...' : s);
      return `${filePath}\n- ${truncate(oldStr)}\n+ ${truncate(newStr)}`;
    }
    if (toolName === 'Create' || toolName === 'MultiEdit') {
      const filePath = String(toolInput.file_path || toolInput.path || '');
      return filePath;
    }
    if (toolName === 'NotebookEdit') {
      const path = String(toolInput.notebook_path || '');
      return path;
    }
    if (toolName === 'TodoWrite') {
      const subject = String(toolInput.subject || '');
      return subject;
    }
    const entries = Object.entries(toolInput).slice(0, 3);
    return entries.map(([k, v]) => `${k}: ${typeof v === 'string' ? v.substring(0, 100) : JSON.stringify(v).substring(0, 100)}`).join('\n');
  };

  const preview = formatToolPreview();

  // Keyboard shortcuts: Y = approve, N = deny
  useEffect(() => {
    if (resolved) return;
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'y' || e.key === 'Y') handleResolve(true);
      if (e.key === 'n' || e.key === 'N') handleResolve(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [resolved]);

  const riskLabel = TOOL_RISK_LABELS[toolName] || toolName.toLowerCase();

  return (
    <div
      ref={cardRef}
      className={`
        mt-3 rounded-xl border overflow-hidden transition-all duration-300
        ${
          resolved
            ? 'border-border/50 bg-card/30 opacity-60'
            : 'border-amber-400/60 bg-gradient-to-br from-amber-50/80 via-background to-amber-100/5 animate-fade-in'
        }
      `}
    >
      {/* Header */}
      <div
        className={`px-3 py-2 flex items-center gap-2 ${
          resolved ? 'bg-muted/30' : 'bg-gradient-to-r from-amber-500/10 to-transparent'
        }`}
      >
        {!resolved ? (
          <ShieldAlert size={14} className="text-amber-600 animate-pulse-gentle" />
        ) : (
          <ShieldCheck size={14} className="text-green-500" />
        )}
        <span className="text-xs font-medium text-foreground">
          {t('toolPermission.title', 'Permission Required')}
        </span>
        <span className="text-[10px] text-muted-foreground ml-auto">
          {new Date(permission.timestamp).toLocaleTimeString()}
        </span>
      </div>

      {/* Body */}
      <div className="p-3 space-y-2">
        <div className="flex items-center gap-2 text-xs">
          {icon}
          <span className="text-muted-foreground">
            {t('toolPermission.request', 'AI requests permission to use:')}
          </span>
        </div>

        {/* Tool name badge */}
        <div className="ml-5 px-2.5 py-1 bg-red-500/10 border border-red-500/20 rounded-md font-mono text-xs text-red-600 font-medium">
          {toolName}
        </div>

        {/* Tool preview */}
        <div className="ml-5 p-2 bg-muted/30 rounded-md">
          <pre className="text-[11px] text-muted-foreground whitespace-pre-wrap font-mono break-all max-h-32 overflow-hidden">
            {preview || '(no input)'}
          </pre>
        </div>

        {/* Action buttons */}
        {!resolved && (
          <div className="flex items-center gap-2 pt-1 ml-5">
            <button
              onClick={() => handleResolve(true)}
              className="text-xs bg-green-600 hover:bg-green-700 text-white px-3 py-1.5 rounded-md transition-colors font-medium"
            >
              {t('toolPermission.approve', 'Allow')} (Y)
            </button>
            <button
              onClick={() => handleResolve(false)}
              className="text-xs bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 rounded-md transition-colors font-medium"
            >
              {t('toolPermission.deny', 'Deny')} (N)
            </button>
          </div>
        )}

        {/* Resolved status */}
        {resolved && (
          <div className="text-xs text-muted-foreground ml-5">
            {permission.status === 'approved'
              ? t('toolPermission.approved', 'Approved')
              : t('toolPermission.denied', 'Denied')}
          </div>
        )}
      </div>
    </div>
  );
}
