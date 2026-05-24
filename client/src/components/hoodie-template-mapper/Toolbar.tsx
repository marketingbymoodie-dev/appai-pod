import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  MousePointer2,
  PenLine,
  Magnet,
  Grid3X3,
  Frame,
  RotateCw,
  Maximize2,
  Upload,
  Save,
  FolderOpen,
  Plus,
  Loader2,
  Check,
} from "lucide-react";
import type { HoodieToolId, HoodieView } from "@shared/hoodieTemplate";
import { useHoodieMapperStore } from "./store";
import { readImageDimensions, saveTemplate, uploadMockup } from "./api";

type Props = {
  onOpenLoadDialog: () => void;
};

const TOOL_BUTTONS: Array<{
  id: HoodieToolId;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  /** Earliest phase that ships this tool. Tools from earlier phases are enabled. */
  phase: number;
  shortcut?: string;
}> = [
  { id: "move", icon: MousePointer2, label: "Move (V)", phase: 1, shortcut: "v" },
  { id: "polygon-pen", icon: PenLine, label: "Polygon Pen (P)", phase: 2, shortcut: "p" },
  { id: "magnetic-pen", icon: Magnet, label: "Magnetic Pen (M)", phase: 2, shortcut: "m" },
  { id: "mesh-warp", icon: Grid3X3, label: "Mesh Warp", phase: 4 },
  { id: "corner-pin", icon: Frame, label: "Corner Pin", phase: 4 },
  { id: "rotate", icon: RotateCw, label: "Rotate", phase: 4 },
  { id: "scale", icon: Maximize2, label: "Scale", phase: 4 },
];

const HIGHEST_ENABLED_PHASE = 2;

export default function Toolbar({ onOpenLoadDialog }: Props) {
  const { toast } = useToast();
  const tool = useHoodieMapperStore((s) => s.tool);
  const view = useHoodieMapperStore((s) => s.view);
  const template = useHoodieMapperStore((s) => s.template);
  const dirty = useHoodieMapperStore((s) => s.dirty);
  const busy = useHoodieMapperStore((s) => s.busy);
  const actions = useHoodieMapperStore((s) => s.actions);

  const frontInputRef = useRef<HTMLInputElement | null>(null);
  const backInputRef = useRef<HTMLInputElement | null>(null);

  // Keyboard shortcuts: V (Move), P (Polygon Pen), M (Magnetic Pen).
  // Skipped while typing in form fields so we don't hijack input.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && /input|textarea|select/i.test(target.tagName)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const key = e.key.toLowerCase();
      const match = TOOL_BUTTONS.find((t) => t.shortcut === key);
      if (!match) return;
      if (match.phase > HIGHEST_ENABLED_PHASE) return;
      e.preventDefault();
      actions.setTool(match.id);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actions]);

  async function handleMockupUpload(targetView: HoodieView, file: File) {
    actions.setBusy(true);
    try {
      const { width, height } = await readImageDimensions(file);
      const { url } = await uploadMockup(template.name, targetView, file);
      actions.setMockup(targetView, { src: url, width, height });
      toast({ title: `Loaded ${targetView} mockup`, description: `${width}×${height}px` });
    } catch (err: any) {
      toast({ title: "Upload failed", description: err?.message || String(err), variant: "destructive" });
    } finally {
      actions.setBusy(false);
    }
  }

  async function handleSave() {
    actions.setBusy(true);
    try {
      const result = await saveTemplate(template.name, template);
      actions.markSaved();
      const meta = [
        result.bodySource ? `body=${result.bodySource}` : null,
        typeof result.elapsedMs === "number" ? `${result.elapsedMs}ms` : null,
        result.handler ? `srv=${result.handler}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      toast({
        title: "Template saved",
        description: meta ? `${result.file}\n${meta}` : result.file,
      });
    } catch (err: any) {
      toast({ title: "Save failed", description: err?.message || String(err), variant: "destructive" });
    } finally {
      actions.setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-1 border-b border-slate-800 bg-slate-900 px-3 py-2 text-sm">
      {/* Tool buttons */}
      <div className="flex items-center gap-1 rounded-md border border-slate-800 bg-slate-950 p-1">
        {TOOL_BUTTONS.map(({ id, icon: Icon, label, phase }) => {
          const enabled = phase <= HIGHEST_ENABLED_PHASE;
          return (
            <Button
              key={id}
              size="sm"
              variant={tool === id ? "default" : "ghost"}
              onClick={() => enabled && actions.setTool(id)}
              disabled={!enabled}
              title={enabled ? label : `${label} (phase ${phase})`}
              data-testid={`hoodie-tool-${id}`}
              className="h-8 w-8 p-0"
            >
              <Icon className="h-4 w-4" />
            </Button>
          );
        })}
      </div>

      <div className="mx-2 h-6 w-px bg-slate-700" />

      {/* View switcher */}
      <div className="flex overflow-hidden rounded-md border border-slate-700">
        {(["front", "back"] as HoodieView[]).map((v) => (
          <Button
            key={v}
            size="sm"
            variant={view === v ? "default" : "ghost"}
            onClick={() => actions.setView(v)}
            data-testid={`hoodie-view-${v}`}
            className="h-8 rounded-none border-0 px-3 text-xs uppercase tracking-wide"
          >
            {v}
          </Button>
        ))}
      </div>

      <div className="mx-2 h-6 w-px bg-slate-700" />

      {/* Upload mockups */}
      <Button
        size="sm"
        variant="outline"
        className="h-8 gap-1 text-xs"
        onClick={() => frontInputRef.current?.click()}
        disabled={busy}
        data-testid="hoodie-upload-front"
      >
        <Upload className="h-3.5 w-3.5" />
        Upload front
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="h-8 gap-1 text-xs"
        onClick={() => backInputRef.current?.click()}
        disabled={busy}
        data-testid="hoodie-upload-back"
      >
        <Upload className="h-3.5 w-3.5" />
        Upload back
      </Button>
      <input
        ref={frontInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleMockupUpload("front", f);
          e.target.value = "";
        }}
      />
      <input
        ref={backInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleMockupUpload("back", f);
          e.target.value = "";
        }}
      />

      <div className="ml-auto flex items-center gap-2">
        {dirty ? (
          <span
            className="rounded-sm bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-amber-300"
            title="You have unsaved changes"
          >
            unsaved
          </span>
        ) : (
          <span
            className="flex items-center gap-1 text-[11px] uppercase tracking-wide text-slate-500"
            title="All changes saved"
          >
            <Check className="h-3 w-3" />
            saved
          </span>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-8 gap-1 text-xs"
          onClick={() => actions.resetTemplate()}
          disabled={busy}
          title="New template"
          data-testid="hoodie-new"
        >
          <Plus className="h-3.5 w-3.5" />
          New
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-8 gap-1 text-xs"
          onClick={onOpenLoadDialog}
          disabled={busy}
          data-testid="hoodie-open"
        >
          <FolderOpen className="h-3.5 w-3.5" />
          Load
        </Button>
        <Button
          size="sm"
          variant="default"
          className={
            "h-8 gap-1 text-xs " +
            (dirty && !busy
              ? "border-emerald-400 bg-emerald-500 text-white hover:bg-emerald-400"
              : "border-slate-700 bg-slate-800 text-slate-400")
          }
          onClick={handleSave}
          disabled={busy || !dirty}
          title={
            busy
              ? "Saving…"
              : dirty
                ? "Save template (unsaved changes)"
                : "Nothing to save"
          }
          data-testid="hoodie-save"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
