import type { PrintShape, CanvasConfig } from "./types";

interface SafeZoneMaskProps {
  shape: PrintShape;
  canvasConfig: CanvasConfig;
  showMask?: boolean;
  className?: string;
}

export function SafeZoneMask({ 
  shape, 
  canvasConfig, 
  showMask = false,
  className = ""
}: SafeZoneMaskProps) {
  if (!showMask) return null;

  const { width, height, safeZoneMargin } = canvasConfig;
  const safeWidth = width - (safeZoneMargin * 2);
  const safeHeight = height - (safeZoneMargin * 2);
  const marginPercent = (safeZoneMargin / Math.min(width, height)) * 100;

  if (shape === "circle") {
    const radius = Math.min(safeWidth, safeHeight) / 2;
    const cx = width / 2;
    const cy = height / 2;
    
    return (
      <svg 
        className={`absolute inset-0 pointer-events-none ${className}`}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
      >
        <defs>
          <mask id="circleSafeZone">
            <rect width="100%" height="100%" fill="white" />
            <circle cx={cx} cy={cy} r={radius} fill="black" />
          </mask>
        </defs>
        <rect 
          width="100%" 
          height="100%" 
          fill="rgba(0,0,0,0.5)" 
          mask="url(#circleSafeZone)"
        />
        <circle 
          cx={cx} 
          cy={cy} 
          r={radius} 
          fill="none" 
          stroke="rgba(255,255,255,0.5)" 
          strokeWidth="2"
          strokeDasharray="8 4"
        />
      </svg>
    );
  }

  return (
    <div 
      className={`absolute inset-0 pointer-events-none ${className}`}
      style={{
        boxShadow: `inset 0 0 0 ${marginPercent}% rgba(0,0,0,0.3)`,
        border: "2px dashed rgba(255,255,255,0.5)",
        margin: `${marginPercent}%`,
      }}
    />
  );
}

export function generateSafeZonePrompt(
  shape: PrintShape,
  bleedMarginPercent: number
): string {
  const margin = bleedMarginPercent || 5;
  
  switch (shape) {
    case "circle":
      return `Design for a circular printable area. Center all important elements (faces, text, focal points) within the inner ${100 - margin * 2}% of the circle. Keep a ${margin}% margin from the circular edge for bleed.`;
    case "square":
      return `Design for a square printable area. Center important elements within the inner ${100 - margin * 2}% of the canvas. Keep a ${margin}% margin from all edges for bleed.`;
    default:
      return `Center important elements within the inner ${100 - margin * 2}% of the canvas. Keep a ${margin}% margin from all edges for bleed.`;
  }
}

export function generateSafeZoneMaskDataUrl(
  shape: PrintShape,
  width: number,
  height: number,
  safeZoneMargin: number
): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  ctx.fillStyle = "rgba(0, 0, 0, 0.3)";
  ctx.fillRect(0, 0, width, height);

  ctx.globalCompositeOperation = "destination-out";

  if (shape === "circle") {
    const radius = Math.min(width, height) / 2 - safeZoneMargin;
    ctx.beginPath();
    ctx.arc(width / 2, height / 2, radius, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.fillRect(
      safeZoneMargin,
      safeZoneMargin,
      width - safeZoneMargin * 2,
      height - safeZoneMargin * 2
    );
  }

  ctx.globalCompositeOperation = "source-over";
  ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 4]);

  if (shape === "circle") {
    const radius = Math.min(width, height) / 2 - safeZoneMargin;
    ctx.beginPath();
    ctx.arc(width / 2, height / 2, radius, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    ctx.strokeRect(
      safeZoneMargin,
      safeZoneMargin,
      width - safeZoneMargin * 2,
      height - safeZoneMargin * 2
    );
  }

  return canvas.toDataURL("image/png");
}
