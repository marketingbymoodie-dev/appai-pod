/**
 * DEV-ONLY: Hoodie AOP Placer playground
 *
 * Mounts the customer-facing `HoodieAopPlacer` against the published
 * `unisex-zip-hoodie-aop-L` template so we can iterate on it before
 * wiring it into `embed-design.tsx` for product 20 (Stage 3).
 *
 * Access at: /dev/hoodie-placer
 *
 * The page is tree-shaken out of production builds via the dev guard
 * in `App.tsx`.
 */

import { useState } from "react";
import HoodieAopPlacer, {
  type HoodieAopPlacerApplyResult,
  type HoodieAopPlacerState,
} from "@/components/designer/HoodieAopPlacer";

const DEFAULT_TEMPLATE_NAME = "unisex-zip-hoodie-aop-L";

export default function DevHoodiePlacerPage() {
  if (!import.meta.env.DEV) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">Not available in production.</p>
      </div>
    );
  }

  const [templateName, setTemplateName] = useState(DEFAULT_TEMPLATE_NAME);
  const [pendingTemplate, setPendingTemplate] = useState(DEFAULT_TEMPLATE_NAME);
  const [lastApply, setLastApply] = useState<HoodieAopPlacerApplyResult | null>(null);
  const [latestState, setLatestState] = useState<HoodieAopPlacerState | null>(null);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 bg-slate-900/40 px-6 py-4">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold">Hoodie AOP Placer (dev)</h1>
            <p className="text-xs text-slate-400">
              Stage 2 playground — customer-facing artwork placer for AOP
              hoodies. Not wired into the embed yet.
            </p>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setTemplateName(pendingTemplate);
            }}
            className="flex items-center gap-2"
          >
            <label className="text-[11px] text-slate-400">Template</label>
            <input
              value={pendingTemplate}
              onChange={(e) => setPendingTemplate(e.target.value)}
              className="h-7 rounded border border-slate-700 bg-slate-900 px-2 text-xs"
              spellCheck={false}
            />
            <button
              type="submit"
              className="rounded bg-fuchsia-600 px-2 py-1 text-xs font-medium text-white hover:bg-fuchsia-500"
            >
              Load
            </button>
          </form>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-6">
        <HoodieAopPlacer
          templateName={templateName}
          onApply={(r) => setLastApply(r)}
          onChange={(s) => setLatestState(s)}
        />

        <section className="mt-8 grid gap-4 lg:grid-cols-2">
          <div className="rounded border border-slate-800 bg-slate-900/40 p-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
              Live state (autosave preview)
            </div>
            <pre className="max-h-72 overflow-auto rounded bg-black/40 p-2 text-[10px] leading-tight text-slate-300">
              {latestState ? JSON.stringify(latestState, null, 2) : "—"}
            </pre>
          </div>
          <div className="rounded border border-slate-800 bg-slate-900/40 p-4">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Last "Apply" → exported canvases
              </div>
              <button
                disabled={!lastApply}
                onClick={() => {
                  const c = lastApply?.renderView("front");
                  if (c) {
                    const url = c.toDataURL("image/png");
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = "hoodie-aop-front.png";
                    a.click();
                  }
                }}
                className="rounded bg-slate-800 px-2 py-1 text-[11px] font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-40"
              >
                Download front
              </button>
            </div>
            <p className="text-[11px] text-slate-400">
              Stage 3 will replace this with the real "Apply to product" → upload
              pipeline (panelUrls + Printify mockup background-fire).
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}
