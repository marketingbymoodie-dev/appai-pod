import { useEffect, useMemo, useRef, useState } from "react";
import AdminLayout from "@/components/admin-layout";
import HoodieCanvas from "@/components/hoodie-template-mapper/canvas/HoodieCanvas";
import LeftSidebar from "@/components/hoodie-template-mapper/LeftSidebar";
import RightSidebar from "@/components/hoodie-template-mapper/RightSidebar";
import Toolbar from "@/components/hoodie-template-mapper/Toolbar";
import DeleteLayerConfirmDialog from "@/components/hoodie-template-mapper/DeleteLayerConfirmDialog";
import { useHoodieMapperStore } from "@/components/hoodie-template-mapper/store";
import {
  loadTemplate as apiLoadTemplate,
  listMockups,
} from "@/components/hoodie-template-mapper/api";
import {
  clearAutosave,
  hasMeaningfulContent,
  readAutosave,
  summarizeSnapshot,
  writeAutosave,
  type AutosaveSnapshot,
} from "@/components/hoodie-template-mapper/lib/autosave";
import { useToast } from "@/hooks/use-toast";
import { History, X } from "lucide-react";
import type { HoodieView } from "@shared/hoodieTemplate";
import { isValidAopTemplateSlug, normalizeAopTemplateSlugInput } from "@shared/hoodieTemplate";
import { readMapperAssetDimensions } from "@/components/hoodie-template-mapper/lib/mapperAssetImage";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Admin route: /admin/hoodie-template-mapper
 *
 * Phase 1 shell. Wires the toolbar, sidebars, and Konva canvas to the
 * Zustand store, plus a save/load dialog. No mask drawing yet — that
 * arrives in phase 2 (polygon pen).
 */

function readImageDimsFromUrl(url: string): Promise<{ width: number; height: number } | null> {
  return readMapperAssetDimensions(url).catch(() => null);
}

export default function HoodieTemplateMapperPage() {
  const [openLoad, setOpenLoad] = useState(false);
  const [loadName, setLoadName] = useState("");
  const [autosavePrompt, setAutosavePrompt] = useState<AutosaveSnapshot | null>(null);
  const actions = useHoodieMapperStore((s) => s.actions);
  const dirty = useHoodieMapperStore((s) => s.dirty);
  const templateName = useHoodieMapperStore((s) => s.template.name);
  const frontMockup = useHoodieMapperStore((s) => s.template.views.front?.mockup ?? null);
  const backMockup = useHoodieMapperStore((s) => s.template.views.back?.mockup ?? null);
  const { toast } = useToast();

  // Warn before navigating away with unsaved changes.
  useEffect(() => {
    function beforeUnload(e: BeforeUnloadEvent) {
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  // Autosave (mount): if there's a stored snapshot with real content, offer
  // to restore it. We don't auto-restore so the user is never surprised by
  // unfamiliar layers reappearing.
  useEffect(() => {
    const snap = readAutosave();
    if (snap && hasMeaningfulContent(snap.template)) {
      setAutosavePrompt(snap);
    }
  }, []);

  // Autosave (write): every time the in-memory template becomes dirty we
  // mirror the latest state to localStorage (debounced). When a save / load
  // / reset clears dirty we drop the snapshot — disk is now the source of
  // truth and stale autosave would just confuse the user on next reload.
  useEffect(() => {
    let timer: number | null = null;
    let lastDirty = useHoodieMapperStore.getState().dirty;
    const unsub = useHoodieMapperStore.subscribe((s) => {
      if (s.dirty) {
        if (timer !== null) window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          writeAutosave({
            template: s.template,
            view: s.view,
            tool: s.tool,
            savedAt: new Date().toISOString(),
          });
        }, 400);
      } else if (lastDirty) {
        // Just transitioned from dirty=true -> false: explicit save / load /
        // reset. Drop any pending write and clear the autosave snapshot.
        if (timer !== null) {
          window.clearTimeout(timer);
          timer = null;
        }
        clearAutosave();
      }
      lastDirty = s.dirty;
    });
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      unsub();
    };
  }, []);

  // Auto-attach existing mockup PNGs from the dev API. Mockup uploads
  // already persist to disk — but if the user reloads / starts fresh we
  // currently force them to re-upload from the file picker. Match by the
  // current template name (server names mockups `<template>-<view>.<ext>`)
  // and call setMockup so the canvas can pick up the existing files.
  const autoAttachKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (frontMockup && backMockup) return;
    const key = `${templateName}::${Boolean(frontMockup)}::${Boolean(backMockup)}`;
    if (autoAttachKeyRef.current === key) return;
    autoAttachKeyRef.current = key;

    let cancelled = false;
    (async () => {
      try {
        const all = await listMockups();
        const prefix = `${templateName}-`;
        for (const view of ["front", "back"] as HoodieView[]) {
          const haveAlready = view === "front" ? frontMockup : backMockup;
          if (haveAlready) continue;
          const match = all.find((m) => m.filename.startsWith(`${prefix}${view}.`));
          if (!match) continue;
          const dims = await readImageDimsFromUrl(match.url);
          if (cancelled || !dims) continue;
          actions.setMockup(view, { src: match.url, width: dims.width, height: dims.height });
          // Re-attaching an existing mockup shouldn't be marked dirty, since
          // nothing new has changed relative to disk. setMockup currently
          // forces dirty=true; flip it back so the "unsaved" indicator
          // doesn't appear just from sitting on the page.
          actions.markSaved();
        }
      } catch {
        /* silent — the existing manual upload path still works */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [actions, templateName, frontMockup, backMockup]);

  async function handleLoad(rawName: string) {
    const name = normalizeAopTemplateSlugInput(rawName);
    if (!name) return;
    if (!isValidAopTemplateSlug(name)) {
      toast({
        title: "Invalid slug",
        description: "Use letters, numbers, dashes, and underscores — e.g. Spun_Polyester_Square_Pillow",
        variant: "destructive",
      });
      return;
    }
    actions.setBusy(true);
    try {
      const tpl = await apiLoadTemplate(name);
      actions.loadTemplate(tpl);
      setOpenLoad(false);
      setLoadName("");
      setAutosavePrompt(null);
      clearAutosave();
      toast({ title: "Template loaded", description: tpl.name });
    } catch (err: any) {
      toast({ title: "Load failed", description: err?.message || String(err), variant: "destructive" });
    } finally {
      actions.setBusy(false);
    }
  }

  function handleRestoreAutosave() {
    if (!autosavePrompt) return;
    actions.loadTemplate(autosavePrompt.template);
    actions.setView(autosavePrompt.view);
    actions.setTool(autosavePrompt.tool);
    setAutosavePrompt(null);
    toast({
      title: "Restored unsaved work",
      description: `${summarizeSnapshot(autosavePrompt)} — remember to click Save.`,
    });
  }

  function handleDiscardAutosave() {
    clearAutosave();
    setAutosavePrompt(null);
  }

  const restoreLabel = useMemo(
    () => (autosavePrompt ? summarizeSnapshot(autosavePrompt) : ""),
    [autosavePrompt],
  );

  return (
    <AdminLayout>
      {/* AdminLayout wraps children in a padded <main> with overflow-auto. We
          need full-bleed for the canvas, so cancel the p-6 with negative
          margins and stretch to the full main content box. */}
      <div className="-m-6 flex h-[calc(100%+3rem)] flex-col bg-slate-950 text-slate-100">
        <header className="border-b border-slate-800 bg-slate-900 px-4 py-2">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-base font-semibold tracking-tight">AOP Panel Mapper</h1>
              <p className="text-[11px] text-slate-400">
                Mesh-warp panel mapping for all-over-print apparel (hoodies today; same engine for other AOP
                garments). Masks here drive customer previews and Printify production exports.
              </p>
            </div>
            <div className="text-[11px] text-slate-500">phase 1 · shell + canvas + JSON save/load</div>
          </div>
        </header>

        <Toolbar onOpenLoadDialog={() => setOpenLoad(true)} onLoadTemplate={handleLoad} />

        {autosavePrompt && (
          <div
            className="flex items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-200"
            data-testid="hoodie-autosave-banner"
          >
            <History className="h-4 w-4 shrink-0 text-amber-300" />
            <div className="flex-1">
              <span className="font-medium">Unsaved work found</span>
              <span className="ml-2 text-amber-200/80">
                {restoreLabel} from {new Date(autosavePrompt.savedAt).toLocaleString()}
              </span>
            </div>
            <Button
              size="sm"
              variant="default"
              className="h-7 border-emerald-400 bg-emerald-500 text-xs text-white hover:bg-emerald-400"
              onClick={handleRestoreAutosave}
              data-testid="hoodie-autosave-restore"
            >
              Restore
            </Button>
            <button
              type="button"
              className="text-amber-200/70 hover:text-amber-100"
              onClick={handleDiscardAutosave}
              title="Discard autosave"
              data-testid="hoodie-autosave-discard"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        <div className="flex flex-1 overflow-hidden">
          <LeftSidebar onLoadTemplate={(name) => handleLoad(name)} />
          <div className="relative flex-1 overflow-hidden">
            {/* HoodieCanvas self-measures via its own wrapper ref —
                we don't pass width/height props, since the previous
                page-level useLayoutEffect+ResizeObserver path was
                landing at 0x0 in StrictMode and gating the canvas
                from mounting at all. */}
            <HoodieCanvas />
          </div>
          <RightSidebar />
        </div>

        <Dialog open={openLoad} onOpenChange={setOpenLoad}>
          <DialogContent className="bg-slate-900 text-slate-100">
            <DialogHeader>
              <DialogTitle>Load template</DialogTitle>
              <DialogDescription>
                Enter the admin slug (letters, numbers, dashes, underscores), or pick one from the left sidebar.
                Spaces are converted automatically — e.g. &quot;Spun Polyester Square Pillow&quot; becomes{" "}
                <span className="font-mono">Spun_Polyester_Square_Pillow</span>.
              </DialogDescription>
            </DialogHeader>
            <Input
              placeholder="Spun_Polyester_Square_Pillow"
              value={loadName}
              onChange={(e) => setLoadName(normalizeAopTemplateSlugInput(e.target.value))}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleLoad(loadName);
              }}
              autoFocus
            />
            <DialogFooter>
              <Button variant="ghost" onClick={() => setOpenLoad(false)}>
                Cancel
              </Button>
              <Button onClick={() => handleLoad(loadName)} disabled={!loadName.trim()}>
                Load
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <DeleteLayerConfirmDialog />
      </div>
    </AdminLayout>
  );
}
