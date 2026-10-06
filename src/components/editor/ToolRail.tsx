import {
  Hand,
  MinusCircle,
  MousePointer2,
  PlusCircle,
  Search,
  type LucideIcon,
} from 'lucide-react';
import { strings } from '@/i18n/strings';
import { useEditorStore, type Tool } from '@/stores/editorStore';

const t = strings.editor.tools;
const tools: { tool: Tool; label: string; icon: LucideIcon; key: string }[] = [
  { tool: 'move', label: t.move, icon: MousePointer2, key: 'V' },
  { tool: 'keep', label: t.keep, icon: PlusCircle, key: 'B' },
  { tool: 'erase', label: t.erase, icon: MinusCircle, key: 'E' },
  { tool: 'pan', label: t.pan, icon: Hand, key: 'H' },
  { tool: 'zoom', label: t.zoom, icon: Search, key: 'Z' },
];

export function ToolRail() {
  const active = useEditorStore((s) => s.tool);
  const setTool = useEditorStore((s) => s.setTool);
  return (
    <div
      role="toolbar"
      aria-label={t.label}
      aria-orientation="vertical"
      className="flex w-[100px] shrink-0 flex-col gap-2 border-r border-border bg-surface px-2.5 py-3"
    >
      {tools.map(({ tool, label, icon: Icon, key }) => (
        <button
          key={tool}
          type="button"
          aria-pressed={active === tool}
          title={`${label} (${key})`}
          onClick={() => setTool(tool)}
          className={`flex flex-col items-center gap-1.5 rounded-md px-2 py-3 text-sm transition-colors ${
            active === tool ? 'bg-muted font-medium text-primary' : 'text-fg hover:bg-muted'
          }`}
        >
          <Icon size={26} strokeWidth={1.6} aria-hidden />
          {label}
        </button>
      ))}
    </div>
  );
}
