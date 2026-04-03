import { useRef, useCallback, useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import type { PrintSize, FrameColor, ImageTransform, PrintShape, DesignerType } from "./types";
import { SafeZoneMask } from "./SafeZoneMask";

interface ProductMockupProps {
  imageUrl?: string | null;
  /** Composite mockup URL (e.g. Printify). When provided in storefront mode,
   *  this is shown instead of the raw artwork overlaid on a blank. */
  mockupUrl?: string | null;
  isLoading?: boolean;
  /** Which phase of loading is active, used for stage-specific spinner text. */
  loadingStage?: "generating" | "mockups" | null;
  selectedSize?: PrintSize | null;
  selectedFrameColor?: FrameColor | null;
  transform: ImageTransform;
  onTransformChange: (transform: ImageTransform) => void;
  enableDrag?: boolean;
  printShape?: PrintShape;
  designerType?: DesignerType;
  canvasConfig?: {
    width: number;
    height: number;
    safeZoneMargin: number;
    maxDimension: number;
  };
  showSafeZone?: boolean;
  blankImageUrl?: string | null;
  /** The product's aspect ratio string, e.g. "3:4" or "2:1". Used to detect
   *  landscape products that need a scale-up to fill the container. */
  aspectRatio?: string;
}

/* ─────────────────────────────────────────────────────────────────────────────
   FlowLoader — Google Flow-style fluid grey blob animation with dissolve
   ───────────────────────────────────────────────────────────────────────────── */

interface FlowLoaderProps {
  /** "generating" = blobs only; "mockups" = dissolve image in, show mockup text */
  stage: "generating" | "mockups";
  /** The generated artwork URL — used to dissolve in during "mockups" stage */
  imageUrl?: string | null;
}

// Pre-compute a noise field for the dissolve wipe (done once at module level)
const NOISE_W = 340;
const NOISE_H = 340;
const noiseField = (() => {
  const data = new Float32Array(NOISE_W * NOISE_H);
  function rand(x: number, y: number) {
    const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return n - Math.floor(n);
  }
  function smooth(px: number, py: number, scale: number) {
    const ix = Math.floor(px / scale), iy = Math.floor(py / scale);
    const fx = px / scale - ix, fy = py / scale - iy;
    const a = rand(ix, iy), b = rand(ix + 1, iy);
    const c = rand(ix, iy + 1), d = rand(ix + 1, iy + 1);
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    return a * (1 - ux) * (1 - uy) + b * ux * (1 - uy) + c * (1 - ux) * uy + d * ux * uy;
  }
  for (let py = 0; py < NOISE_H; py++) {
    for (let px = 0; px < NOISE_W; px++) {
      data[py * NOISE_W + px] =
        smooth(px, py, 60) * 0.5 +
        smooth(px, py, 30) * 0.3 +
        smooth(px, py, 15) * 0.2;
    }
  }
  return data;
})();

const BLOB_DEFS = [
  { ax: 0.31, ay: 0.27, px: 0.13, py: 0.07, r: 210, l: 65 },
  { ax: 0.19, ay: 0.23, px: 0.41, py: 0.29, r: 185, l: 45 },
  { ax: 0.27, ay: 0.17, px: 0.67, py: 0.53, r: 225, l: 78 },
  { ax: 0.15, ay: 0.21, px: 0.89, py: 0.11, r: 165, l: 55 },
  { ax: 0.22, ay: 0.30, px: 0.55, py: 0.75, r: 195, l: 38 },
];

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }
function hex2(n: number) { return clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0"); }

function FlowLoader({ stage, imageUrl }: FlowLoaderProps) {
  const blobCanvasRef = useRef<HTMLCanvasElement>(null);
  const dissolveCanvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const imgLoadedRef = useRef(false);
  const rafRef = useRef<number>(0);
  const timeRef = useRef(0);
  const dissolveStartRef = useRef<number | null>(null);
  const dissolveProgressRef = useRef(0);
  const [statusText, setStatusText] = useState("Generating your design…");
  const [pillVisible, setPillVisible] = useState(true);

  // When stage switches to "mockups", pre-load the artwork image
  useEffect(() => {
    if (stage === "mockups" && imageUrl) {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => { imgLoadedRef.current = true; };
      img.src = imageUrl;
      imgRef.current = img;
    }
  }, [stage, imageUrl]);

  useEffect(() => {
    const blobCanvas = blobCanvasRef.current;
    const dissolveCanvas = dissolveCanvasRef.current;
    if (!blobCanvas || !dissolveCanvas) return;

    const bCtx = blobCanvas.getContext("2d");
    const dCtx = dissolveCanvas.getContext("2d");
    if (!bCtx || !dCtx) return;

    const W = blobCanvas.width;
    const H = blobCanvas.height;

    // Speed: 0.008 (double the original 0.004)
    const BLOB_SPEED = 0.008;
    const DISSOLVE_DURATION = 1600; // ms — snappy dissolve

    function drawBlobs(t: number, blobAlpha: number) {
      bCtx!.globalAlpha = blobAlpha;
      bCtx!.fillStyle = "#1c1c1c";
      bCtx!.fillRect(0, 0, W, H);

      bCtx!.globalCompositeOperation = "screen";
      for (const b of BLOB_DEFS) {
        const x = W / 2 + Math.sin(t * b.ax + b.px * Math.PI * 2) * W * 0.38;
        const y = H / 2 + Math.cos(t * b.ay + b.py * Math.PI * 2) * H * 0.38;
        const grad = bCtx!.createRadialGradient(x, y, 0, x, y, b.r);
        const lc = hex2(b.l);
        const lc2 = hex2(b.l * 0.25);
        grad.addColorStop(0, `#${lc}${lc}${lc}`);
        grad.addColorStop(0.4, `#${lc2}${lc2}${lc2}`);
        grad.addColorStop(1, "#000000");
        bCtx!.fillStyle = grad;
        bCtx!.beginPath();
        bCtx!.arc(x, y, b.r, 0, Math.PI * 2);
        bCtx!.fill();
      }
      bCtx!.globalCompositeOperation = "source-over";
      bCtx!.globalAlpha = 1;

      // Subtle scan lines
      for (let sy = 0; sy < H; sy += 4) {
        bCtx!.fillStyle = "rgba(0,0,0,0.03)";
        bCtx!.fillRect(0, sy, W, 1);
      }
    }

    function drawDissolve(progress: number) {
      if (progress <= 0) {
        dCtx!.clearRect(0, 0, W, H);
        return;
      }
      if (!imgLoadedRef.current || !imgRef.current) return;

      // Draw the artwork image onto the dissolve canvas
      dCtx!.clearRect(0, 0, W, H);
      dCtx!.drawImage(imgRef.current, 0, 0, W, H);

      // Apply noise-threshold mask: pixels where noise > (1 - progress) are hidden
      // This creates a liquid blob wipe revealing the image
      const imageData = dCtx!.getImageData(0, 0, W, H);
      const d = imageData.data;
      const edge = 0.1;
      for (let i = 0; i < W * H; i++) {
        const n = noiseField[i];
        // alpha ramp: 0 = hidden, 1 = fully revealed
        const a = clamp((progress - (1 - n) + edge) / edge, 0, 1);
        d[i * 4 + 3] = Math.round(d[i * 4 + 3] * a);
      }
      dCtx!.putImageData(imageData, 0, 0);
    }

    function loop(now: number) {
      timeRef.current += BLOB_SPEED;

      let blobAlpha = 1;
      let dissolveProgress = 0;

      if (stage === "mockups") {
        // Start dissolve timer on first frame in mockups stage
        if (dissolveStartRef.current === null) {
          dissolveStartRef.current = now;
        }
        const elapsed = now - dissolveStartRef.current;
        dissolveProgress = clamp(elapsed / DISSOLVE_DURATION, 0, 1);
        dissolveProgressRef.current = dissolveProgress;

        // Ease in-out cubic
        const t = dissolveProgress;
        const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

        blobAlpha = 1 - eased;

        // Text swap at midpoint
        if (eased > 0.45 && statusText === "Generating your design…") {
          setStatusText("Creating mockups…");
        }

        // Fade pill out after dissolve completes
        if (eased >= 1) {
          setPillVisible(false);
        }

        drawDissolve(eased);
      } else {
        dissolveStartRef.current = null;
        dCtx!.clearRect(0, 0, W, H);
      }

      drawBlobs(timeRef.current, blobAlpha);

      rafRef.current = requestAnimationFrame(loop);
    }

    rafRef.current = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  return (
    <div className="absolute inset-0 overflow-hidden" style={{ background: "#1c1c1c" }}>
      {/* Layer 1: fluid grey blobs */}
      <canvas
        ref={blobCanvasRef}
        width={340}
        height={340}
        className="absolute inset-0 w-full h-full"
        style={{ display: "block" }}
      />
      {/* Layer 2: dissolving artwork image */}
      <canvas
        ref={dissolveCanvasRef}
        width={340}
        height={340}
        className="absolute inset-0 w-full h-full"
        style={{ display: "block" }}
      />
      {/* Vignette */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: "radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.4) 100%)",
          zIndex: 5,
        }}
      />
      {/* Status pill */}
      {pillVisible && (
        <div
          className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 rounded-full px-4 py-1.5 text-xs text-white/80 whitespace-nowrap z-10"
          style={{
            background: "rgba(255,255,255,0.09)",
            backdropFilter: "blur(10px)",
            border: "1px solid rgba(255,255,255,0.13)",
            transition: "opacity 0.5s ease",
          }}
        >
          <span
            className="w-1.5 h-1.5 rounded-full bg-white/60"
            style={{ animation: "appai-pulse-dot 1.6s ease-in-out infinite" }}
          />
          <span>{statusText}</span>
        </div>
      )}
      <style>{`
        @keyframes appai-pulse-dot {
          0%, 100% { opacity: 0.3; transform: scale(0.8); }
          50%       { opacity: 1;   transform: scale(1);   }
        }
      `}</style>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   SkeletonLoader — grey shimmer for saved design loading
   ───────────────────────────────────────────────────────────────────────────── */
function SkeletonLoader() {
  return (
    <div
      className="absolute inset-0"
      style={{
        background: "linear-gradient(90deg, #2c2c2c 25%, #393939 50%, #2c2c2c 75%)",
        backgroundSize: "200% 100%",
        animation: "appai-shimmer 1.8s ease-in-out infinite",
      }}
    >
      <style>{`
        @keyframes appai-shimmer {
          0%   { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   ProductMockup — main component
   ───────────────────────────────────────────────────────────────────────────── */

export function ProductMockup({
  imageUrl,
  mockupUrl,
  isLoading = false,
  loadingStage,
  selectedSize,
  selectedFrameColor,
  transform,
  onTransformChange,
  enableDrag = true,
  printShape = "rectangle",
  designerType = "generic",
  canvasConfig,
  showSafeZone = false,
  blankImageUrl,
  aspectRatio,
}: ProductMockupProps) {
  // When a composite mockup URL is available (e.g. Printify mockup after generation),
  // display it as a full-bleed image instead of the raw artwork overlaid on a blank.
  const displayUrl = mockupUrl ?? imageUrl;
  // Debug: log to window to ensure we can see it
  if (typeof window !== "undefined") {
    (window as any).__productMockupDebug = { designerType, imageUrl, isLoading };
  }
  console.log("[ProductMockup] RENDER designerType:", designerType, "imageUrl:", imageUrl, "isLoading:", isLoading);
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement | null>(null);

  /**
   * Determine whether the product is landscape (wider than tall).
   */
  const isLandscape = (() => {
    if (aspectRatio) {
      const [w, h] = aspectRatio.split(":").map(Number);
      if (w > 0 && h > 0) return w > h;
    }
    return false;
  })();

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!imageUrl || !enableDrag) return;
      e.preventDefault();
      e.stopPropagation();
      isDraggingRef.current = true;
      dragStartRef.current = { x: e.clientX, y: e.clientY };
      containerRef.current = e.currentTarget;
    },
    [imageUrl, enableDrag]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!isDraggingRef.current || !containerRef.current) return;
      e.preventDefault();
      e.stopPropagation();

      const rect = containerRef.current.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      const dx = e.clientX - dragStartRef.current.x;
      const dy = e.clientY - dragStartRef.current.y;
      if (dx === 0 && dy === 0) return;

      const deltaX = (dx / rect.width) * 100;
      const deltaY = (dy / rect.height) * 100;

      onTransformChange({
        ...transform,
        x: Math.max(0, Math.min(100, transform.x + deltaX)),
        y: Math.max(0, Math.min(100, transform.y + deltaY)),
      });
      dragStartRef.current = { x: e.clientX, y: e.clientY };
    },
    [transform, onTransformChange]
  );

  const handleMouseUp = useCallback(() => {
    isDraggingRef.current = false;
    containerRef.current = null;
  }, []);

  const getProductStyles = () => {
    const baseRadius = "0.375rem";

    switch (designerType) {
      case "pillow":
        return {
          borderRadius: printShape === "circle" ? "50%" : "0.5rem",
          boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
        };
      case "framed-print":
        return { borderRadius: baseRadius };
      case "mug":
        return { borderRadius: "0" };
      default:
        return { borderRadius: baseRadius };
    }
  };

  const renderImageContent = () => {
    if (isLoading) {
      // ── Google Flow-style animation ──────────────────────────────
      if (loadingStage === "generating") {
        return <FlowLoader stage="generating" imageUrl={imageUrl} />;
      }

      // ── Mockup generation: dissolve artwork in, keep blobs underneath ──
      if (loadingStage === "mockups" && imageUrl) {
        return <FlowLoader stage="mockups" imageUrl={imageUrl} />;
      }

      // ── Fallback: skeleton shimmer (e.g. loading a saved design) ──
      return <SkeletonLoader />;
    }

    // When a composite mockup URL exists, render it as a full-bleed product photo.
    if (mockupUrl) {
      console.log("[ProductMockup] Rendering composite mockup URL:", mockupUrl.substring(0, 80));
      return (
        <img
          src={mockupUrl}
          alt="Product mockup"
          className="absolute inset-0 w-full h-full object-cover"
          style={{ pointerEvents: "none" }}
          draggable={false}
          data-testid="img-mockup"
          onLoad={() => console.log("[ProductMockup] Mockup loaded successfully")}
          onError={(e) => console.error("[ProductMockup] Mockup failed to load:", e)}
        />
      );
    }

    if (displayUrl) {
      const scaleVal = transform.scale / 100;
      const xOffset = transform.x - 50;
      const yOffset = transform.y - 50;
      return (
        <img
          src={displayUrl}
          alt="Generated artwork"
          className="absolute inset-0 w-full h-full object-cover"
          style={{
            pointerEvents: "none",
            borderRadius: printShape === "circle" ? "50%" : undefined,
            transform: `scale(${scaleVal}) translate(${xOffset}%, ${yOffset}%)`,
            transformOrigin: "center center",
          }}
          draggable={false}
          data-testid="img-generated"
          onLoad={() => console.log("[ProductMockup] Image loaded successfully")}
          onError={(e) => console.error("[ProductMockup] Image failed to load:", e)}
        />
      );
    }

    if (blankImageUrl) {
      if (designerType === "mug") {
        return (
          <img
            src={blankImageUrl}
            alt="Product blank"
            className="absolute inset-0 w-full h-full object-contain"
            style={{ pointerEvents: "none", opacity: 0.92 }}
            draggable={false}
            data-testid="img-blank"
          />
        );
      }

      const blankScale = isLandscape ? "scale(1.1)" : undefined;
      return (
        <img
          src={blankImageUrl}
          alt="Product blank"
          className="absolute inset-0 w-full h-full object-cover"
          style={{
            pointerEvents: "none",
            opacity: 0.92,
            transform: blankScale,
            transformOrigin: "center center",
          }}
          draggable={false}
          data-testid="img-blank"
        />
      );
    }

    return (
      <div className="text-center text-muted-foreground p-4">
        <Sparkles className="h-8 w-8 mx-auto mb-2 opacity-50" />
        <p className="text-xs">Your artwork will appear here</p>
      </div>
    );
  };

  const renderFramedPrint = () => {
    const showFrameOverlay = !mockupUrl && !!imageUrl;

    if (!showFrameOverlay) {
      return (
        <div className="absolute inset-0 flex items-center justify-center overflow-hidden rounded-md">
          {renderImageContent()}
        </div>
      );
    }

    const getFrameInsets = () => {
      if (!selectedSize) return { outer: "0.75rem", inner: "1rem" };
      const sizeId = selectedSize.id;
      if (sizeId === "11x14") return { outer: "0.5rem", inner: "1.5rem" };
      if (["12x16", "16x16"].includes(sizeId)) return { outer: "0.625rem", inner: "1.25rem" };
      return { outer: "0.75rem", inner: "1rem" };
    };

    const frameInsets = getFrameInsets();

    return (
      <>
        <div
          className="absolute rounded-sm flex items-center justify-center"
          style={{
            backgroundColor: selectedFrameColor?.hex || "#1a1a1a",
            pointerEvents: "none",
            inset: frameInsets.outer,
          }}
        >
          <div
            className="absolute bg-white dark:bg-gray-200 rounded-sm flex items-center justify-center overflow-hidden"
            style={{ pointerEvents: "none", inset: frameInsets.inner }}
          >
            {renderImageContent()}
          </div>
        </div>
      </>
    );
  };

  const renderPillow = () => {
    const productStyles = getProductStyles();

    return (
      <div
        className="absolute inset-4 flex items-center justify-center overflow-hidden bg-gray-100 dark:bg-gray-800"
        style={{ ...productStyles, pointerEvents: "none" }}
      >
        {printShape === "circle" && (
          <div
            className="absolute inset-0 rounded-full overflow-hidden"
            style={{ clipPath: "circle(50% at 50% 50%)" }}
          >
            {renderImageContent()}
          </div>
        )}
        {printShape !== "circle" && renderImageContent()}
        {showSafeZone && canvasConfig && (
          <SafeZoneMask shape={printShape} canvasConfig={canvasConfig} showMask={true} />
        )}
      </div>
    );
  };

  const renderMug = () => {
    return (
      <div className="absolute inset-0 flex items-center justify-center overflow-hidden rounded-md">
        {renderImageContent()}
        {showSafeZone && canvasConfig && (
          <SafeZoneMask shape={printShape} canvasConfig={canvasConfig} showMask={true} />
        )}
      </div>
    );
  };

  const renderGeneric = () => {
    return (
      <div
        className="absolute inset-4 flex items-center justify-center overflow-hidden bg-muted rounded-md"
        style={{ pointerEvents: "none" }}
      >
        {renderImageContent()}
        {showSafeZone && canvasConfig && (
          <SafeZoneMask shape={printShape} canvasConfig={canvasConfig} showMask={true} />
        )}
      </div>
    );
  };

  const renderProductMockup = () => {
    switch (designerType) {
      case "framed-print":
        return renderFramedPrint();
      case "pillow":
        return renderPillow();
      case "mug":
        return renderMug();
      default:
        return renderGeneric();
    }
  };

  const isDragActive = !!displayUrl && enableDrag && !mockupUrl;

  return (
    <div
      className={`relative bg-muted rounded-md w-full h-full ${
        isDragActive ? "cursor-move select-none" : ""
      }`}
      style={{ touchAction: isDragActive ? "none" : "pan-y" }}
      {...(isDragActive
        ? {
            onMouseDown: handleMouseDown,
            onMouseMove: handleMouseMove,
            onMouseUp: handleMouseUp,
            onMouseLeave: handleMouseUp,
          }
        : {})}
      data-testid="product-mockup"
    >
      {renderProductMockup()}
    </div>
  );
}
