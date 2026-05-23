import { useEffect, useRef, useState } from "react";
import AdminLayout from "@/components/admin-layout";
import HoodieCanvas from "@/components/hoodie-template-mapper/canvas/HoodieCanvas";
import LeftSidebar from "@/components/hoodie-template-mapper/LeftSidebar";
import RightSidebar from "@/components/hoodie-template-mapper/RightSidebar";
import Toolbar from "@/components/hoodie-template-mapper/Toolbar";
import { useHoodieMapperStore } from "@/components/hoodie-template-mapper/store";
import { loadTemplate as apiLoadTemplate } from "@/components/hoodie-template-mapper/api";
import { useToast } from "@/hooks/use-toast";
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
export default function HoodieTemplateMapperPage() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [{ width, height }, setSize] = useState({ width: 0, height: 0 });
  const [openLoad, setOpenLoad] = useState(false);
  const [loadName, setLoadName] = useState("");
  const actions = useHoodieMapperStore((s) => s.actions);
  const dirty = useHoodieMapperStore((s) => s.dirty);
  const { toast } = useToast();

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const r = entry.contentRect;
        setSize({ width: Math.floor(r.width), height: Math.floor(r.height) });
      }
    });
    ro.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
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

  async function handleLoad(name: string) {
    if (!name.trim()) return;
    actions.setBusy(true);
    try {
      const tpl = await apiLoadTemplate(name.trim());
      actions.loadTemplate(tpl);
      setOpenLoad(false);
      toast({ title: "Template loaded", description: tpl.name });
    } catch (err: any) {
      toast({ title: "Load failed", description: err?.message || String(err), variant: "destructive" });
    } finally {
      actions.setBusy(false);
    }
  }

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

        <div className="flex flex-1 overflow-hidden">
          <LeftSidebar onLoadTemplate={(name) => handleLoad(name)} />
          <div ref={containerRef} className="relative flex-1 overflow-hidden">
            {width > 0 && height > 0 && <HoodieCanvas width={width} height={height} />}
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
