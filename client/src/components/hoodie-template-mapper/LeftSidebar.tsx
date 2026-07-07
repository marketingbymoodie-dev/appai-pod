import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Eye,
  EyeOff,
  Lock,
  Unlock,
  Trash2,
  RefreshCw,
  Image as ImageIcon,
  ChevronDown,
  ChevronRight,
  Combine,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import MergeLayersDialog from "./MergeLayersDialog";
import {
  PANEL_DISPLAY_LABEL,
  panelsEligibleForView,
  resolvePlacerEditor,
  resolveGarmentLayout,
  layerRenderPriority,
  type HoodieView,
} from "@shared/hoodieTemplate";
import { useHoodieMapperStore } from "./store";
import {
  listMockups,
  listTemplates,
  mockupUrlsMatch,
  type MockupListEntry,
  type TemplateListEntry,
} from "./api";
import { readMapperAssetDimensions } from "./lib/mapperAssetImage";

/**
 * Persisted expanded/collapsed state for each LeftSidebar section.
 * Stored as a single object in localStorage so the user's layout
 * preference survives reloads. New section keys default to whatever
 * `defaults` says; missing keys are filled in on read.
 */
type SectionId = "layers" | "eligible" | "mockups" | "templates";
type SectionState = Record<SectionId, boolean>;
const SECTION_STORAGE_KEY = "hoodie-mapper-sidebar-sections-v1";
const SECTION_DEFAULTS: SectionState = {
  // Layers expanded, secondary sections collapsed by default — when
  // the user opens the mapper we want to show them their tracing
  // progress, not the static "eligible panels" reference list.
  layers: true,
  eligible: false,
  mockups: false,
  templates: false,
};

function loadSectionState(): SectionState {
  if (typeof window === "undefined") return { ...SECTION_DEFAULTS };
  try {
    const raw = window.localStorage.getItem(SECTION_STORAGE_KEY);
    if (!raw) return { ...SECTION_DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<SectionState>;
    return { ...SECTION_DEFAULTS, ...parsed };
  } catch {
    return { ...SECTION_DEFAULTS };
  }
}

function saveSectionState(state: SectionState) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SECTION_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore quota / privacy errors — collapsing is non-critical UX.
  }
}

/**
 * Collapsible section header. Click anywhere on the row toggles the
 * body (or the user can click the chevron explicitly). Optional
 * `actions` slot renders to the right of the title (refresh button,
 * count badge, etc.) and stops click propagation so action clicks
 * don't accidentally collapse the section.
 */
function SectionHeader({
  title,
  expanded,
  onToggle,
  count,
  actions,
}: {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  count?: number;
  actions?: ReactNode;
}) {
  return (
    <div
      className="flex cursor-pointer items-center justify-between border-t border-slate-800 px-3 py-2 text-[11px] uppercase tracking-wide text-slate-400 hover:bg-slate-800/40"
      onClick={onToggle}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle();
        }
      }}
    >
      <span className="flex items-center gap-1">
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-slate-500" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-slate-500" />
        )}
        <span>{title}</span>
        {typeof count === "number" && (
          <span className="ml-1 rounded bg-slate-800 px-1 text-[10px] text-slate-300">
            {count}
          </span>
        )}
      </span>
      {actions && (
        <span onClick={(e) => e.stopPropagation()} className="flex items-center gap-1">
          {actions}
        </span>
      )}
    </div>
  );
}

/**
 * Left sidebar: layer list + eligible panel reference + saved templates.
 * Phase 1 has no draggable layers yet — the layer list shows the panels the
 * admin will be mapping for the active view, plus a list of recently saved
 * templates for quick context. Phase 2 adds real layer rows.
 */
function inferViewFromFilename(filename: string): HoodieView | null {
  if (/-front\.[a-z0-9]+$/i.test(filename)) return "front";
  if (/-back\.[a-z0-9]+$/i.test(filename)) return "back";
  return null;
}

export default function LeftSidebar({ onLoadTemplate }: { onLoadTemplate: (name: string) => void }) {
  const view = useHoodieMapperStore((s) => s.view);
  const layers = useHoodieMapperStore((s) => s.template.views[s.view].layers);
  const frontMockupSrc = useHoodieMapperStore((s) => s.template.views.front?.mockup?.src ?? null);
  const backMockupSrc = useHoodieMapperStore((s) => s.template.views.back?.mockup?.src ?? null);
  const selectedLayerId = useHoodieMapperStore((s) => s.selectedLayerId);
  const mergeSelectionIds = useHoodieMapperStore((s) => s.mergeSelectionIds);
  const hoverLayerId = useHoodieMapperStore((s) => s.hoverLayerId);
  const saveSeq = useHoodieMapperStore((s) => s.saveSeq);
  const activeTemplateName = useHoodieMapperStore((s) => s.template.name);
  const blueprintId = useHoodieMapperStore((s) => s.template.blueprintId);
  const placerEditor = useHoodieMapperStore((s) => resolvePlacerEditor(s.template));
  const garmentLayout = useHoodieMapperStore((s) => resolveGarmentLayout(s.template));
  const actions = useHoodieMapperStore((s) => s.actions);

  const [templates, setTemplates] = useState<TemplateListEntry[]>([]);
  const [mockups, setMockups] = useState<MockupListEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [mockupLoading, setMockupLoading] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const { toast } = useToast();

  // Per-section expand/collapse, persisted to localStorage so the
  // user's layout sticks across reloads.
  const [sections, setSections] = useState<SectionState>(() => loadSectionState());
  const toggleSection = (id: SectionId) =>
    setSections((cur) => {
      const next = { ...cur, [id]: !cur[id] };
      saveSectionState(next);
      return next;
    });

  useEffect(() => {
    if (renamingId) renameInputRef.current?.select();
  }, [renamingId]);

  async function refreshTemplates(options?: { silent?: boolean }) {
    setLoading(true);
    try {
      setTemplates(await listTemplates());
    } catch (err: any) {
      const msg = err?.message || String(err);
      const isAuth = msg.includes("401") || msg.includes("403");
      if (!options?.silent && !isAuth) {
        toast({ title: "Could not list templates", description: msg, variant: "destructive" });
      }
    } finally {
      setLoading(false);
    }
  }

  async function refreshMockups(options?: { silent?: boolean }) {
    setMockupLoading(true);
    try {
      setMockups(await listMockups());
    } catch (err: any) {
      const msg = err?.message || String(err);
      const isAuth = msg.includes("401") || msg.includes("403");
      if (!options?.silent && !isAuth) {
        toast({ title: "Could not list mockups", description: msg, variant: "destructive" });
      }
    } finally {
      setMockupLoading(false);
    }
  }

  async function attachMockupToView(entry: MockupListEntry, target?: HoodieView) {
    const inferredView = target ?? inferViewFromFilename(entry.filename) ?? view;
    let dims: { width: number; height: number } | null = null;
    try {
      dims = await readMapperAssetDimensions(entry.url);
    } catch {
      dims = null;
    }
    if (!dims) {
      toast({
        title: "Could not load mockup",
        description: `Failed to read dimensions for ${entry.filename}`,
        variant: "destructive",
      });
      return;
    }
    actions.setMockup(inferredView, { src: entry.url, width: dims.width, height: dims.height });
    toast({
      title: `Attached ${inferredView} mockup`,
      description: `${entry.filename} (${dims.width}\u00d7${dims.height}px). Save, then Publish — reused zip/other files upload from their on-disk path.`,
    });
  }

  useEffect(() => {
    refreshTemplates();
    refreshMockups();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fetch the saved-templates list every time markSaved() bumps saveSeq,
  // so a template the user just saved appears in this sidebar without them
  // having to click the refresh icon.
  useEffect(() => {
    if (saveSeq === 0) return;
    refreshTemplates({ silent: true });
    refreshMockups({ silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveSeq]);

  const eligiblePanels = panelsEligibleForView(view, blueprintId, placerEditor, garmentLayout);

  const mergeIdsOnView = mergeSelectionIds.filter((id) => layers.some((l) => l.id === id));
  const canOpenMerge = mergeIdsOnView.length >= 2;

  return (
    <aside
      className="flex h-full w-64 flex-col border-r border-slate-800 bg-slate-900 text-slate-200"
      data-testid="hoodie-left-sidebar"
    >
      <SectionHeader
        title={`Layers · ${view}`}
        expanded={sections.layers}
        onToggle={() => toggleSection("layers")}
        count={layers.length}
      />
      <div
        className={`overflow-y-auto px-2 py-2 ${
          // The Layers section is the only one that gets to grow into
          // remaining vertical space — everything below is scrollable
          // within itself, so collapsing the others reclaims real
          // estate for the layer rows.
          sections.layers ? "flex-1" : "hidden"
        }`}
      >
        {layers.length === 0 ? (
          <div className="rounded border border-dashed border-slate-700 px-3 py-4 text-[11px] text-slate-500">
            No mask layers yet. Pick the Polygon (P) or Magnetic (M) pen and click on the mockup to start tracing each panel.
          </div>
        ) : (
          <>
            <div className="mb-2 space-y-1.5">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="h-7 w-full text-[11px]"
                disabled={!canOpenMerge}
                onClick={() => setMergeDialogOpen(true)}
                data-testid="merge-layers-open"
              >
                <Combine className="mr-1 h-3 w-3" />
                Merge selected ({mergeIdsOnView.length})
              </Button>
              <p className="text-[10px] leading-snug text-slate-500">
                Check layers to merge, or Ctrl+click. Merged mesh is cleared — re-mesh if needed.
              </p>
            </div>
            <ul className="space-y-1">
            {[...layers]
              // Topmost-rendered at the top of the list (Photoshop convention).
              // Uses anatomical render priority so e.g. Front Pocket sits at
              // the top of the list, matching what shows on the canvas.
              .sort((a, b) => layerRenderPriority(b) - layerRenderPriority(a))
              .map((l) => {
                const isPrimary = selectedLayerId === l.id;
                const inMergeSelection = mergeIdsOnView.includes(l.id);
                const isHover = hoverLayerId === l.id;
                const isExclusion = l.isExclusion || l.kind === "exclusion";
                return (
                  <li
                    key={l.id}
                    onMouseEnter={() => actions.setHoverLayer(l.id)}
                    onMouseLeave={() => actions.setHoverLayer(null)}
                    onClick={(e) =>
                      actions.setSelectedLayer(l.id, {
                        additive: e.ctrlKey || e.metaKey,
                      })
                    }
                    onDoubleClick={() => setRenamingId(l.id)}
                    className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs transition ${
                      inMergeSelection
                        ? "ring-1 ring-violet-400/80 bg-slate-700"
                        : isPrimary
                          ? "bg-slate-700"
                          : isHover
                            ? "bg-slate-800"
                            : "hover:bg-slate-800"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={inMergeSelection}
                      title="Include in merge"
                      aria-label={`Include ${l.name} in merge`}
                      className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-violet-400"
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => actions.toggleMergeSelection(l.id)}
                      data-testid={`merge-select-${l.id}`}
                    />
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
                        {!isExclusion && l.mesh && l.productionPanelSrc && (
                          <span
                            className="ml-1 rounded bg-emerald-500/20 px-1 text-[10px] font-medium uppercase text-emerald-300"
                            title="Mesh warp + source artwork ready"
                          >
                            M
                          </span>
                        )}
                        {!isExclusion && l.mesh && !l.productionPanelSrc && (
                          <span
                            className="ml-1 rounded bg-amber-500/20 px-1 text-[10px] font-medium uppercase text-amber-300"
                            title="Mesh exists — upload source artwork to complete"
                          >
                            M?
                          </span>
                        )}
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
                        actions.requestRemoveLayer(l.id, l.name);
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
          </>
        )}
      </div>

      <MergeLayersDialog
        open={mergeDialogOpen}
        onOpenChange={setMergeDialogOpen}
        view={view}
        layerIds={mergeIdsOnView}
      />

      <SectionHeader
        title={`Eligible panels · ${view}`}
        expanded={sections.eligible}
        onToggle={() => toggleSection("eligible")}
        count={eligiblePanels.length}
      />
      {sections.eligible && (
        <ul className="px-3 pb-2 text-[11px] text-slate-400">
          {eligiblePanels.map((key) => (
            <li key={key} className="py-0.5">
              · {PANEL_DISPLAY_LABEL[key]}
            </li>
          ))}
        </ul>
      )}

      <SectionHeader
        title="Mockup files"
        expanded={sections.mockups}
        onToggle={() => toggleSection("mockups")}
        count={mockups.length}
        actions={
          <button
            type="button"
            onClick={refreshMockups}
            className="text-slate-300 hover:text-white"
            title="Refresh"
          >
            <RefreshCw className={`h-3 w-3 ${mockupLoading ? "animate-spin" : ""}`} />
          </button>
        }
      />
      <div
        className={`max-h-40 overflow-y-auto px-2 pb-2 ${sections.mockups ? "" : "hidden"}`}
        data-testid="hoodie-mockup-list"
      >
        {mockups.length === 0 ? (
          <div className="px-1 py-1 text-[11px] text-slate-500">
            No uploaded mockups yet. Use Upload front / Upload back in the toolbar.
          </div>
        ) : (
          mockups.map((m) => {
            const inferred = inferViewFromFilename(m.filename);
            const isAttachedFront = mockupUrlsMatch(frontMockupSrc, m.url);
            const isAttachedBack = mockupUrlsMatch(backMockupSrc, m.url);
            const isAttached = isAttachedFront || isAttachedBack;
            return (
              <div
                key={m.filename}
                className="flex items-center gap-1 rounded px-1 py-1 text-[11px] hover:bg-slate-800"
              >
                <ImageIcon className="h-3 w-3 shrink-0 text-slate-500" />
                <button
                  type="button"
                  onClick={() => attachMockupToView(m)}
                  className="flex-1 truncate text-left text-slate-300 hover:text-white"
                  title={`Attach to ${inferred ?? view} view`}
                  data-testid={`hoodie-mockup-${m.filename}`}
                >
                  {m.filename}
                </button>
                {isAttached && (
                  <span className="rounded bg-emerald-500/20 px-1 text-[10px] font-medium uppercase text-emerald-300">
                    {isAttachedFront ? "F" : "B"}
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>

      <SectionHeader
        title="Saved templates"
        expanded={sections.templates}
        onToggle={() => toggleSection("templates")}
        count={templates.length}
        actions={
          <button
            type="button"
            onClick={refreshTemplates}
            className="text-slate-300 hover:text-white"
            title="Refresh"
          >
            <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
          </button>
        }
      />
      <div className={`max-h-40 overflow-y-auto px-2 pb-2 ${sections.templates ? "" : "hidden"}`}>
        {templates.length === 0 ? (
          <div className="px-1 py-1 text-[11px] text-slate-500">No saved templates yet.</div>
        ) : (
          templates.map((t) => {
            const isActive = t.name === activeTemplateName;
            return (
              <Button
                key={t.name}
                size="sm"
                variant="ghost"
                className={`w-full justify-start text-[11px] ${
                  isActive ? "bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/15" : ""
                }`}
                onClick={() => onLoadTemplate(t.name)}
                data-testid={`hoodie-load-template-${t.name}`}
                title={isActive ? "Currently open — click to reload from disk" : `Load ${t.name}`}
              >
                <span className="truncate">
                  {isActive && <span className="mr-1 text-emerald-300">●</span>}
                  {t.name}
                </span>
                <span className="ml-auto text-[10px] text-slate-500">
                  {t.updatedAt.replace("T", " ").slice(0, 16)}
                </span>
              </Button>
            );
          })
        )}
      </div>
    </aside>
  );
}
