import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { MockupCalibration } from "../types/mockupTypes";

type CalibrationJsonEditorProps = {
  calibration: MockupCalibration;
  onApply: (calibration: MockupCalibration) => void;
};

export function CalibrationJsonEditor({ calibration, onApply }: CalibrationJsonEditorProps) {
  const [json, setJson] = useState(() => JSON.stringify(calibration, null, 2));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setJson(JSON.stringify(calibration, null, 2));
    setError(null);
  }, [calibration]);

  return (
    <div className="space-y-3 rounded-lg border bg-background p-4">
      <div>
        <h3 className="text-sm font-semibold">Calibration JSON</h3>
        <p className="text-xs text-muted-foreground">Paste or edit calibration JSON, then apply it to the editor.</p>
      </div>
      <Textarea className="min-h-[360px] font-mono text-xs" value={json} onChange={(event) => setJson(event.target.value)} />
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <Button
        variant="outline"
        onClick={() => {
          try {
            const parsed = JSON.parse(json) as MockupCalibration;
            if (parsed.productType !== "zip_hoodie_aop" || parsed.provider !== "printify") {
              throw new Error("Expected zip_hoodie_aop / printify calibration JSON.");
            }
            onApply(parsed);
            setError(null);
          } catch (err: any) {
            setError(err?.message || "Invalid JSON");
          }
        }}
      >
        Apply JSON
      </Button>
    </div>
  );
}
