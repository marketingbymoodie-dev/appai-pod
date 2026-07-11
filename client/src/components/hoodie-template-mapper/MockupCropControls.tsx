import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from "lucide-react";
import {
  centerCropOnCanvas,
  clampCrop,
  nudgeCropRect,
  setCropSizeKeepCenter,
  type CropRect,
} from "./lib/mockupCrop";

type Props = {
  rect: CropRect;
  maxW: number;
  maxH: number;
  onChange: (rect: CropRect) => void;
};

function parsePx(raw: string, fallback: number): number {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export default function MockupCropControls({ rect, maxW, maxH, onChange }: Props) {
  const [keepCenter, setKeepCenter] = useState(true);
  const [step, setStep] = useState(1);

  function apply(next: CropRect) {
    onChange(clampCrop(next, maxW, maxH));
  }

  function patch(partial: Partial<CropRect>) {
    if (keepCenter && (partial.width != null || partial.height != null)) {
      apply(
        setCropSizeKeepCenter(
          rect,
          partial.width ?? rect.width,
          partial.height ?? rect.height,
          maxW,
          maxH,
        ),
      );
      return;
    }
    apply({ ...rect, ...partial });
  }

  function nudge(dx: number, dy: number) {
    apply(nudgeCropRect(rect, dx * step, dy * step, maxW, maxH));
  }

  return (
    <div className="space-y-2 rounded border border-slate-800 bg-slate-900/60 p-2">
      <div className="text-[10px] font-medium uppercase tracking-wide text-slate-400">Crop region (px)</div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-[10px] text-slate-500">X</Label>
          <Input
            type="number"
            className="h-7 text-xs"
            value={Math.round(rect.x)}
            onChange={(e) => patch({ x: parsePx(e.target.value, rect.x) })}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[10px] text-slate-500">Y</Label>
          <Input
            type="number"
            className="h-7 text-xs"
            value={Math.round(rect.y)}
            onChange={(e) => patch({ y: parsePx(e.target.value, rect.y) })}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[10px] text-slate-500">Width</Label>
          <Input
            type="number"
            min={1}
            className="h-7 text-xs"
            value={Math.round(rect.width)}
            onChange={(e) => patch({ width: Math.max(1, parsePx(e.target.value, rect.width)) })}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[10px] text-slate-500">Height</Label>
          <Input
            type="number"
            min={1}
            className="h-7 text-xs"
            value={Math.round(rect.height)}
            onChange={(e) => patch({ height: Math.max(1, parsePx(e.target.value, rect.height)) })}
          />
        </div>
      </div>

      <label className="flex items-center gap-2 text-[10px] text-slate-400">
        <input
          type="checkbox"
          checked={keepCenter}
          onChange={(e) => setKeepCenter(e.target.checked)}
          className="rounded border-slate-600"
        />
        Keep center when changing W×H
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] text-slate-500">Nudge</span>
        <select
          className="h-7 rounded border border-slate-700 bg-slate-950 px-1 text-[10px] text-slate-200"
          value={step}
          onChange={(e) => setStep(Number(e.target.value) || 1)}
        >
          <option value={1}>1 px</option>
          <option value={5}>5 px</option>
          <option value={10}>10 px</option>
          <option value={25}>25 px</option>
        </select>
        <div className="grid grid-cols-3 gap-0.5">
          <span />
          <Button type="button" size="sm" variant="outline" className="h-7 w-7 p-0" onClick={() => nudge(0, -1)} title="Up">
            <ChevronUp className="h-3.5 w-3.5" />
          </Button>
          <span />
          <Button type="button" size="sm" variant="outline" className="h-7 w-7 p-0" onClick={() => nudge(-1, 0)} title="Left">
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <Button type="button" size="sm" variant="outline" className="h-7 w-7 p-0" onClick={() => nudge(0, 1)} title="Down">
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
          <Button type="button" size="sm" variant="outline" className="h-7 w-7 p-0" onClick={() => nudge(1, 0)} title="Right">
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 text-[10px]"
          onClick={() => apply(centerCropOnCanvas(rect, maxW, maxH))}
        >
          Center on mockup
        </Button>
      </div>
    </div>
  );
}
