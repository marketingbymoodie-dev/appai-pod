import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Eye, EyeOff, Lock, Unlock, Trash2, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { PANELS_PER_VIEW, PANEL_DISPLAY_LABEL } from "@shared/hoodieTemplate";
import { useHoodieMapperStore } from "./store";
import { listTemplates, type TemplateListEntry } from "./api";

/**
 * Left sidebar: layer list + eligible panel reference + saved templates.
 * Phase 1 has no draggable layers yet — the layer list shows the panels the
 * admin will be mapping for the active view, plus a list of recently saved
 * templates for quick context. Phase 2 adds real layer rows.
 */
export default function LeftSidebar({ onLoadTemplate }: { onLoadTemplate: (name: string) => void }) {
  const view = useHoodieMapperStore((s) => s.view);
  const layers = useHoodieMapperStore((s) => s.template.views[s.view].layers);
  const selectedLayerId = useHoodieMapperStore((s) => s.selectedLayerId);
  const hoverLayerId = useHoodieMapperStore((s) => s.hoverLayerId);
  const actions = useHoodieMapperStore((s) => s.actions);

  const [templates, setTemplates] = useState<TemplateListEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    if (renamingId) renameInputRef.current?.select();
  }, [renamingId]);

  async function refreshTemplates() {
    setLoading(true);
    try {
      setTemplates(await listTemplates());
    } catch (err: any) {
      toast({ title: "Could not list templates", description: err?.message || String(err), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refreshTemplates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const eligiblePanels = PANELS_PER_VIEW[view];

  return (
    <aside
      className="flex h-full w-64 flex-col border-r border-slate-800 bg-slate-900 text-slate-200"
      data-testid="hoodie-left-sidebar"
    >
      <div className="border-b border-slate-800 px-3 py-2 text-[11px] uppercase tracking-wide text-slate-400">
        Layers · {view}
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {layers.length === 0 ? (
          <div className="rounded border border-dashed border-slate-700 px-3 py-4 text-[11px] text-slate-500">
            No mask layers yet. Pick the Polygon (P) or Magnetic (M) pen and click on the mockup to start tracing each panel.
          </div>
        ) : (
          <ul className="space-y-1">
            {[...layers]
              .sort((a, b) => b.zIndex - a.zIndex)
              .map((l) => {
                const isSelected = selectedLayerId === l.id;
                const isHover = hoverLayerId === l.id;
                const isExclusion = l.isExclusion || l.kind === "exclusion";
                return (
                  <li
                    key={l.id}
                    onMouseEnter={() => actions.setHoverLayer(l.id)}
                    onMouseLeave={() => actions.setHoverLayer(null)}
                    onClick={() => actions.setSelectedLayer(l.id)}
                    onDoubleClick={() => setRenamingId(l.id)}
                    className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs transition ${
                      isSelected
                        ? "bg-slate-700"
                        : isHover
                          ? "bg-slate-800"
                          : "hover:bg-slate-800"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        actions.patchLayer(l.id, { visible: !l.visible });
                      }}
                      className="text-slate-300 hover:text-white"
                      title={l.visible ? "Hide layer" : "Show layer"}
                    >
                      {l.visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5 opacity-50" />}
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        actions.patchLayer(l.id, { locked: !l.locked });
                      }}
                      className="text-slate-300 hover:text-white"
                      title={l.locked ? "Unlock layer" : "Lock layer"}
                    >
                      {l.locked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5 opacity-50" />}
                    </button>
                    {renamingId === l.id ? (
                      <input
                        ref={renameInputRef}
                        defaultValue={l.name}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={(e) => {
                          const v = e.target.value.trim();
                          if (v && v !== l.name) actions.patchLayer(l.id, { name: v });
                          setRenamingId(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                          if (e.key === "Escape") setRenamingId(null);
                        }}
                        className="flex-1 rounded bg-slate-950 px-1 py-0.5 text-xs text-slate-100 outline-none ring-1 ring-slate-600"
                      />
                    ) : (
                      <span className="flex-1 truncate" title={l.panelKey ? PANEL_DISPLAY_LABEL[l.panelKey] : "unassigned"}>
                        {l.name}
                        {isExclusion && <span className="ml-1 rounded bg-red-900/40 px-1 text-[10px] text-red-200">EXCL</span>}
                        {l.panelKey && (
                          <span className="ml-1 text-[10px] text-slate-500">
                            · {PANEL_DISPLAY_LABEL[l.panelKey]}
                          </span>
                        )}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        actions.removeLayer(l.id);
                      }}
                      className="text-slate-500 hover:text-red-400"
                      title="Delete layer"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                );
              })}
          </ul>
        )}
      </div>

      <div className="border-t border-slate-800 px-3 py-2 text-[11px] uppercase tracking-wide text-slate-400">
        Eligible panels for {view}
      </div>
      <ul className="px-3 pb-2 text-[11px] text-slate-400">
        {eligiblePanels.map((key) => (
          <li key={key} className="py-0.5">
            · {PANEL_DISPLAY_LABEL[key]}
          </li>
        ))}
      </ul>

      <div className="flex items-center justify-between border-t border-slate-800 px-3 py-2 text-[11px] uppercase tracking-wide text-slate-400">
        <span>Saved templates</span>
        <button
          type="button"
          onClick={refreshTemplates}
          className="text-slate-300 hover:text-white"
          title="Refresh"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>
      <div className="max-h-40 overflow-y-auto px-2 pb-2">
        {templates.length === 0 ? (
          <div className="px-1 py-1 text-[11px] text-slate-500">No saved templates yet.</div>
        ) : (
          templates.map((t) => (
            <Button
              key={t.name}
              size="sm"
              variant="ghost"
              className="w-full justify-start text-[11px]"
              onClick={() => onLoadTemplate(t.name)}
              data-testid={`hoodie-load-template-${t.name}`}
            >
              <span className="truncate">{t.name}</span>
              <span className="ml-auto text-[10px] text-slate-500">
                {t.updatedAt.replace("T", " ").slice(0, 16)}
              </span>
            </Button>
          ))
        )}
      </div>
    </aside>
  );
}
