import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import AdminLayout from "@/components/admin-layout";
import HoodieCanvas from "@/components/hoodie-template-mapper/canvas/HoodieCanvas";
import LeftSidebar from "@/components/hoodie-template-mapper/LeftSidebar";
import RightSidebar from "@/components/hoodie-template-mapper/RightSidebar";
import Toolbar from "@/components/hoodie-template-mapper/Toolbar";
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
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

export default function HoodieTemplateMapperPage() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [{ width, height }, setSize] = useState({ width: 0, height: 0 });
  const [openLoad, setOpenLoad] = useState(false);
  const [loadName, setLoadName] = useState("");
  const [autosavePrompt, setAutosavePrompt] = useState<AutosaveSnapshot | null>(null);
  const actions = useHoodieMapperStore((s) => s.actions);
  const dirty = useHoodieMapperStore((s) => s.dirty);
  const templateName = useHoodieMapperStore((s) => s.template.name);
  const frontMockup = useHoodieMapperStore((s) => s.template.views.front?.mockup ?? null);
  const backMockup = useHoodieMapperStore((s) => s.template.views.back?.mockup ?? null);
  const { toast } = useToast();

  // Defensive size measurement for the canvas container. We've seen the
  // ResizeObserver-only path land at 0x0 in dev (likely StrictMode running
  // the effect, then cleanup, then re-running before the initial RO
  // callback could fire — leaving us subscribed but never delivered a
  // size). Use useLayoutEffect (synchronous post-DOM measure), plus a
  // ResizeObserver, plus a window resize listener, plus a few rAF
  // re-measures so a missed initial measurement self-heals on the next
  // frames.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    function measure() {
      const node = containerRef.current;
      if (!node) return;
      const r = node.getBoundingClientRect();
      const w = Math.floor(r.width);
      const h = Math.floor(r.height);
      setSize((prev) => (prev.width === w && prev.height === h ? prev : { width: w, height: h }));
    }
    measure();
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    window.addEventListener("resize", measure);
    // Re-measure on the next several animation frames in case the layout
    // wasn't settled yet at this point in the commit (font load,
    // sidebar/dialog mount, etc.).
    const rafIds: number[] = [];
    let remaining = 6;
    const tick = () => {
      remaining -= 1;
      measure();
      if (remaining > 0) rafIds.push(window.requestAnimationFrame(tick));
    };
    rafIds.push(window.requestAnimationFrame(tick));
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
      for (const id of rafIds) window.cancelAnimationFrame(id);
    };
  }, []);

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

  async function handleLoad(name: string) {
    if (!name.trim()) return;
    actions.setBusy(true);
    try {
      const tpl = await apiLoadTemplate(name.trim());
      actions.loadTemplate(tpl);
      setOpenLoad(false);
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
              <h1 className="text-base font-semibold tracking-tight">Hoodie Template Mapper</h1>
              <p className="text-[11px] text-slate-400">
                Manual remapping engine. Production panel shapes are the source of truth — masks built here drive
                customer previews, Printify production exports, and Blender renders (wired in later phases).
              </p>
            </div>
            <div className="text-[11px] text-slate-500">phase 1 · shell + canvas + JSON save/load</div>
          </div>
        </header>

        <Toolbar onOpenLoadDialog={() => setOpenLoad(true)} />

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
          <div ref={containerRef} className="relative flex-1 overflow-hidden">
            {width > 0 && height > 0 ? (
              <HoodieCanvas width={width} height={height} />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-xs text-amber-300">
                <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2">
                  Canvas container has no size yet ({width}×{height}). If this stays put, the
                  flex layout failed to give the middle column any space.
                </div>
              </div>
            )}
          </div>
          <RightSidebar />
        </div>

        <Dialog open={openLoad} onOpenChange={setOpenLoad}>
          <DialogContent className="bg-slate-900 text-slate-100">
            <DialogHeader>
              <DialogTitle>Load template</DialogTitle>
              <DialogDescription>
                Enter the slug of a template saved under <code>tmp/hoodie-templates/templates/</code>, or pick one from the left sidebar list.
              </DialogDescription>
            </DialogHeader>
            <Input
              placeholder="zip-hoodie-aop-L"
              value={loadName}
              onChange={(e) => setLoadName(e.target.value)}
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
      </div>
    </AdminLayout>
  );
}
