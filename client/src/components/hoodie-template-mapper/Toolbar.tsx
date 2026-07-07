import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  Undo2,
  Redo2,
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
  Sparkles,
  CloudUpload,
  Download,
} from "lucide-react";
import type { HoodieToolId, HoodieView } from "@shared/hoodieTemplate";
import { useHoodieMapperStore } from "./store";
import {
  readImageDimensions,
  publishTemplateToSupabase,
  saveTemplate,
  uploadMockup,
  downloadPrintifyBlankMockups,
  appendCacheBust,
  type SaveTemplatePublishResult,
} from "./api";
import AopPreviewModal from "./AopPreviewModal";
import FreshStartDialog from "./FreshStartDialog";
import { clearAutosave } from "./lib/autosave";

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err && typeof (err as { message?: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
}

type Props = {
  onOpenLoadDialog: () => void;
  onLoadTemplate: (slug: string) => void;
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
  { id: "mesh-warp", icon: Grid3X3, label: "Mesh Warp (W)", phase: 4, shortcut: "w" },
  { id: "corner-pin", icon: Frame, label: "Corner Pin", phase: 4 },
  { id: "rotate", icon: RotateCw, label: "Rotate", phase: 4 },
  { id: "scale", icon: Maximize2, label: "Scale", phase: 4 },
];

const HIGHEST_ENABLED_PHASE = 2;
/**
 * Phase-4 tools that we've shipped early. Mesh warp is enabled even though
 * it's nominally phase 4 — corner-pin / rotate / scale stay disabled.
 */
const ENABLED_PHASE_4_TOOLS: ReadonlySet<HoodieToolId> = new Set<HoodieToolId>([
  "mesh-warp",
]);

function isToolEnabled(t: { id: HoodieToolId; phase: number }): boolean {
  return t.phase <= HIGHEST_ENABLED_PHASE || ENABLED_PHASE_4_TOOLS.has(t.id);
}

function publishToastLines(
  publish: SaveTemplatePublishResult,
  fileHint?: string,
): { title: string; description: string; variant?: "destructive" } {
  if (publish.ok) {
    const mockupSummary =
      publish.uploadedMockups.length > 0
        ? `mockups: ${publish.uploadedMockups.join(", ")}`
        : "JSON only (mockups unchanged)";
    return {
      title: "Published to Supabase",
      description: [fileHint, `→ ${publish.publicName}`, mockupSummary, publish.jsonUrl]
        .filter(Boolean)
        .join("\n"),
    };
  }
  if (publish.skipped) {
    return {
      title: "Publish skipped",
      description: [fileHint, publish.reason].filter(Boolean).join("\n"),
    };
  }
  return {
    title: "Publish failed",
    description: [fileHint, publish.error].filter(Boolean).join("\n"),
    variant: "destructive",
  };
}

export default function Toolbar({ onOpenLoadDialog, onLoadTemplate }: Props) {
  const { toast } = useToast();
  const tool = useHoodieMapperStore((s) => s.tool);
  const view = useHoodieMapperStore((s) => s.view);
  const template = useHoodieMapperStore((s) => s.template);
  const dirty = useHoodieMapperStore((s) => s.dirty);
  const busy = useHoodieMapperStore((s) => s.busy);
  const canUndo = useHoodieMapperStore((s) => s.undoStack.length > 0);
  const canRedo = useHoodieMapperStore((s) => s.redoStack.length > 0);
  const actions = useHoodieMapperStore((s) => s.actions);

  const frontInputRef = useRef<HTMLInputElement | null>(null);
  const backInputRef = useRef<HTMLInputElement | null>(null);

  const [previewOpen, setPreviewOpen] = useState(false);
  const [freshStartOpen, setFreshStartOpen] = useState(false);

  // Per-view layer counts for the Preview button's enabled state. We don't
  // want users opening the modal on a totally empty template — that's just
  // a confusing "blank canvas" experience.
  const totalLayers =
    template.views.front.layers.length + template.views.back.layers.length;
  const hasMockup = Boolean(
    template.views.front.mockup?.src || template.views.back.mockup?.src,
  );
  const previewReady = totalLayers > 0 && hasMockup;

  // Keyboard shortcuts: V (Move), P (Polygon Pen), M (Magnetic Pen), Ctrl+Z / Ctrl+Shift+Z.
  // Skipped while typing in form fields so we don't hijack input.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && /input|textarea|select/i.test(target.tagName)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) actions.redo();
        else actions.undo();
        return;
      }
      if (mod || e.altKey) return;
      const key = e.key.toLowerCase();
      const match = TOOL_BUTTONS.find((t) => t.shortcut === key);
      if (!match) return;
      if (!isToolEnabled(match)) return;
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

  async function handleDownloadPrintifyBlanks() {
    if (!template.blueprintId) {
      toast({
        title: "Set blueprint first",
        description: "Enter the Printify blueprint ID in the sidebar before downloading blanks.",
        variant: "destructive",
      });
      return;
    }
    actions.setBusy(true);
    try {
      await saveTemplate(template.name, template);
      const result = await downloadPrintifyBlankMockups(template.name);
      for (const d of result.downloaded) {
        actions.setMockup(d.view, {
          src: appendCacheBust(d.url, Date.now()),
          width: d.width,
          height: d.height,
        });
      }
      toast({
        title: "Blank mockups downloaded",
        description: `Printify bp ${result.blueprintId}: ${result.downloaded.map((d) => d.view).join(", ")}`,
      });
    } catch (err: unknown) {
      toast({
        title: "Printify download failed",
        description: formatError(err),
        variant: "destructive",
      });
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

      // Surface the auto-publish result so the admin knows whether the
      // save also pushed to Supabase (production storefront) or only landed
      // on local disk. Three cases:
      //   1. publish.ok           → "Published to Supabase".
      //   2. publish.skipped      → "Published skipped" (e.g. dev with no SB env).
      //   3. publish.error        → red toast so they know to retry/check creds.
      const publish = result.publish;
      if (publish && publish.ok) {
        const t = publishToastLines(publish, result.file);
        toast({ title: `Saved & ${t.title.toLowerCase()}`, description: [t.description, meta].filter(Boolean).join("\n") });
      } else if (publish) {
        const t = publishToastLines(publish, result.file);
        toast({
          title: publish.skipped ? "Saved (publish skipped)" : "Saved, but publish FAILED",
          description: [t.description, meta].filter(Boolean).join("\n"),
          variant: t.variant,
        });
      } else {
        toast({
          title: "Template saved",
          description: meta ? `${result.file}\n${meta}` : result.file,
        });
      }
    } catch (err: any) {
      toast({ title: "Save failed", description: err?.message || String(err), variant: "destructive" });
    } finally {
      actions.setBusy(false);
    }
  }

  async function handlePublish() {
    actions.setBusy(true);
    try {
      if (dirty) {
        const saveResult = await saveTemplate(template.name, template);
        actions.markSaved();
        if (saveResult.publish?.ok) {
          const t = publishToastLines(saveResult.publish, saveResult.file);
          toast({ title: `Saved & ${t.title.toLowerCase()}`, description: t.description });
          return;
        }
      }
      const result = await publishTemplateToSupabase(template.name);
      const t = publishToastLines(result.publish, template.name);
      toast({ title: t.title, description: t.description, variant: t.variant });
    } catch (err: any) {
      toast({ title: "Publish failed", description: err?.message || String(err), variant: "destructive" });
    } finally {
      actions.setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-1 border-b border-slate-800 bg-slate-900 px-3 py-2 text-sm">
      {/* Tool buttons */}
      <div className="flex items-center gap-1 rounded-md border border-slate-800 bg-slate-950 p-1">
        {TOOL_BUTTONS.map(({ id, icon: Icon, label, phase }) => {
          const enabled = isToolEnabled({ id, phase });
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

      <Button
        size="sm"
        variant="ghost"
        className="h-8 w-8 p-0"
        onClick={() => actions.undo()}
        disabled={!canUndo || busy}
        title="Undo (Ctrl+Z)"
        data-testid="hoodie-undo"
      >
        <Undo2 className="h-4 w-4" />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-8 w-8 p-0"
        onClick={() => actions.redo()}
        disabled={!canRedo || busy}
        title="Redo (Ctrl+Shift+Z)"
        data-testid="hoodie-redo"
      >
        <Redo2 className="h-4 w-4" />
      </Button>

      <div className="mx-2 h-6 w-px bg-slate-700" />

      {/* View switcher — compact dropdown so FRONT/BACK stays usable in narrow Shopify admin iframes */}
      <Select
        value={view}
        onValueChange={(v) => actions.setView(v as HoodieView)}
      >
        <SelectTrigger
          className="h-8 w-[5.5rem] shrink-0 border-slate-700 bg-slate-950 px-2 text-xs uppercase tracking-wide"
          aria-label="Mockup view"
          data-testid="hoodie-view-select"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="front" className="text-xs uppercase" data-testid="hoodie-view-front">
            Front
          </SelectItem>
          <SelectItem value="back" className="text-xs uppercase" data-testid="hoodie-view-back">
            Back
          </SelectItem>
        </SelectContent>
      </Select>

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
      <Button
        size="sm"
        variant="outline"
        className="h-8 gap-1 text-xs"
        onClick={() => void handleDownloadPrintifyBlanks()}
        disabled={busy || !template.blueprintId}
        title="Create a temp Printify product with transparent print and download blank garment photos"
        data-testid="hoodie-download-printify-blanks"
      >
        <Download className="h-3.5 w-3.5" />
        Printify blanks
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
        <Button
          size="sm"
          variant="outline"
          className="h-8 gap-1 border-fuchsia-700/60 bg-fuchsia-500/10 text-xs text-fuchsia-200 hover:bg-fuchsia-500/20"
          onClick={() => setPreviewOpen(true)}
          disabled={busy || !previewReady}
          title={
            !hasMockup
              ? "Attach a mockup first"
              : totalLayers === 0
                ? "Trace at least one panel mask first"
                : "Preview the AOP composited onto your masks"
          }
          data-testid="hoodie-preview-aop"
        >
          <Sparkles className="h-3.5 w-3.5" />
          Preview AOP
        </Button>
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
          onClick={() => setFreshStartOpen(true)}
          disabled={busy}
          title="Blank template with a new slug (won't overwrite saved files)"
          data-testid="hoodie-fresh-start"
        >
          <Plus className="h-3.5 w-3.5" />
          Fresh start
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
        <Button
          size="sm"
          variant="outline"
          className="h-8 gap-1 border-sky-700/60 bg-sky-500/10 text-xs text-sky-100 hover:bg-sky-500/20"
          onClick={handlePublish}
          disabled={busy}
          title="Upload saved template + mockups to Supabase (requires SUPABASE_* in .env)"
          data-testid="hoodie-publish"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <CloudUpload className="h-3.5 w-3.5" />
          )}
          Publish
        </Button>
      </div>

      <AopPreviewModal open={previewOpen} onOpenChange={setPreviewOpen} />
      <FreshStartDialog
        open={freshStartOpen}
        onOpenChange={setFreshStartOpen}
        onLoadExisting={onLoadTemplate}
        onConfirm={(template) => {
          actions.loadTemplate(template);
          clearAutosave();
          toast({
            title: "Fresh template started",
            description: `${template.name} (bp ${template.blueprintId}) — upload mockups, map panels, then Save.`,
          });
        }}
      />
    </div>
  );
}
