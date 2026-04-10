import { useRef, useCallback } from "react";
import { Sparkles } from "lucide-react";
import { useState, useEffect } from "react";
import type { PrintSize, FrameColor, ImageTransform, PrintShape, DesignerType } from "./types";
import { SafeZoneMask } from "./SafeZoneMask";

interface ProductMockupProps {
  imageUrl?: string | null;
  /** Composite mockup URL (e.g. Printify). When provided in storefront mode,
   *  this is shown instead of the raw artwork overlaid on a blank. */
  mockupUrl?: string | null;
  isLoading?: boolean;
  /** Which phase of loading is active, used for stage-specific spinner text. */
  loadingStage?: "generating" | "mockups" | "pattern" | null;
  /** Whether this is an AOP product — changes loading messages during generation */
  isAop?: boolean;
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
   CSS keyframes injected once into the document head
   ───────────────────────────────────────────────────────────────────────────── */
const STYLES = `
@keyframes appai-bg-spin {
  from { transform: rotate(0deg) scale(1.45); }
  to   { transform: rotate(360deg) scale(1.45); }
}
@keyframes appai-glow-drift {
  0%   { transform: translate(-18%, -12%) scale(1.1); }
  100% { transform: translate(18%, 12%) scale(0.92); }
}
@keyframes appai-shimmer-sweep {
  0%   { background-position: 220% 0; }
  100% { background-position: -220% 0; }
}
@keyframes appai-text-pulse {
  0%, 100% { opacity: 0.5; }
  50%       { opacity: 1; }
}
@keyframes appai-skeleton {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
`;

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected || typeof document === "undefined") return;
  const el = document.createElement("style");
  el.textContent = STYLES;
  document.head.appendChild(el);
  stylesInjected = true;
}

/* ─────────────────────────────────────────────────────────────────────────────
   GeneratingLoader — light base, dark rotating conic gradient + dark shimmer
   ───────────────────────────────────────────────────────────────────────────── */
const GENERATING_MESSAGES = [
  { line1: "Generating", line2: "Artwork" },
  { line1: "May take up", line2: "to 20 seconds..." },
  { line1: "Generating", line2: "Artwork" },
  { line1: "Almost", line2: "there..." },
];

function GeneratingLoader({ isAop = false }: { isAop?: boolean }) {
  ensureStyles();
  const messages = isAop
    ? [
        { line1: "Generating", line2: "Artwork" },
        { line1: "May take up", line2: "to 20 seconds..." },
        { line1: "Generating", line2: "Artwork" },
        { line1: "Rendering", line2: "Pattern Styles..." },
      ]
    : GENERATING_MESSAGES;
  const [msgIdx, setMsgIdx] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setMsgIdx(i => (i + 1) % messages.length), 5000);
    return () => clearInterval(t);
  }, [messages.length]);
  const msg = messages[msgIdx];
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: "#e0e0e0" }}>
      {/* Rotating light conic gradient */}
      <div style={{
        position: "absolute", inset: 0,
        background: "conic-gradient(from 0deg at 38% 42%, #d8d8d8 0deg, #e8e8e8 55deg, #f0f0f0 95deg, #dcdcdc 155deg, #d0d0d0 195deg, #e4e4e4 255deg, #d4d4d4 300deg, #d8d8d8 360deg)",
        animation: "appai-bg-spin 9s linear infinite",
        transformOrigin: "center",
      }} />
      {/* Drifting dark radial centre */}
      <div style={{
        position: "absolute", inset: 0,
        background: "radial-gradient(ellipse 65% 55% at 50% 50%, rgba(0,0,0,0.06) 0%, transparent 70%)",
        animation: "appai-glow-drift 5.5s ease-in-out infinite alternate",
      }} />
      {/* Dark diagonal shimmer sweep */}
      <div style={{
        position: "absolute", inset: 0,
        background: "linear-gradient(108deg, transparent 28%, rgba(0,0,0,0.04) 46%, rgba(0,0,0,0.09) 50%, rgba(0,0,0,0.04) 54%, transparent 72%)",
        backgroundSize: "200% 100%",
        animation: "appai-shimmer-sweep 3.4s ease-in-out infinite",
      }} />
      {/* Soft light vignette at edges */}
      <div style={{
        position: "absolute", inset: 0,
        background: "radial-gradient(ellipse at center, transparent 42%, rgba(255,255,255,0.35) 100%)",
        pointerEvents: "none",
      }} />
      {/* Large centred dark pulsing text */}
      <div style={{
        position: "absolute", inset: 0,
        display: "flex", alignItems: "center", justifyContent: "center",
        pointerEvents: "none",
      }}>
        <span style={{
          fontSize: "22px", fontWeight: 700,
          color: "rgba(0,0,0,0.75)",
          textAlign: "center", lineHeight: 1.25,
          letterSpacing: "-0.01em",
          textShadow: "0 1px 8px rgba(255,255,255,0.5)",
          animation: "appai-text-pulse 2.6s ease-in-out infinite",
          transition: "opacity 0.4s ease",
        }}>
          {msg.line1}<br />{msg.line2}
        </span>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   PatternLoader — shown while Apply Pattern is generating the final high-res output
   ───────────────────────────────────────────────────────────────────────────── */
function PatternLoader() {
  ensureStyles();
  const messages = [
    { line1: "Rendering", line2: "Pattern..." },
    { line1: "Tiling your", line2: "design..." },
    { line1: "Almost", line2: "there..." },
  ];
  const [msgIdx, setMsgIdx] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setMsgIdx(i => (i + 1) % messages.length), 4000);
    return () => clearInterval(t);
  }, [messages.length]);
  const msg = messages[msgIdx];
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: "#d8e4f0" }}>
      <div style={{
        position: "absolute", inset: 0,
        background: "conic-gradient(from 0deg at 40% 45%, #c8d8e8 0deg, #dce8f4 60deg, #eaf2fa 100deg, #d4e4f0 160deg, #c4d4e4 200deg, #d8e8f4 260deg, #ccdce8 300deg, #c8d8e8 360deg)",
        animation: "appai-bg-spin 10s linear infinite",
        transformOrigin: "center",
      }} />
      <div style={{
        position: "absolute", inset: 0,
        background: "linear-gradient(108deg, transparent 28%, rgba(255,255,255,0.08) 46%, rgba(255,255,255,0.15) 50%, rgba(255,255,255,0.08) 54%, transparent 72%)",
        backgroundSize: "200% 100%",
        animation: "appai-shimmer-sweep 3.4s ease-in-out infinite",
      }} />
      <div style={{
        position: "absolute", inset: 0,
        display: "flex", alignItems: "center", justifyContent: "center",
        pointerEvents: "none",
      }}>
        <span style={{
          fontSize: "22px", fontWeight: 700,
          color: "rgba(0,0,0,0.7)",
          textAlign: "center", lineHeight: 1.25,
          letterSpacing: "-0.01em",
          textShadow: "0 1px 8px rgba(255,255,255,0.6)",
          animation: "appai-text-pulse 2.6s ease-in-out infinite",
        }}>
          {msg.line1}<br />{msg.line2}
        </span>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   MockupsLoader — artwork visible + semi-transparent overlay + pulsing text
   ───────────────────────────────────────────────────────────────────────────── */
function MockupsLoader({ imageUrl, transform, printShape }: {
  imageUrl: string;
  transform: ImageTransform;
  printShape: PrintShape;
}) {
  ensureStyles();
  const scaleVal = transform.scale / 100;
  const xOffset = transform.x - 50;
  const yOffset = transform.y - 50;
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      {/* Artwork underneath */}
      <img
        src={imageUrl}
        alt="Generated artwork"
        style={{
          position: "absolute", inset: 0,
          width: "100%", height: "100%",
          objectFit: "cover",
          pointerEvents: "none",
          borderRadius: printShape === "circle" ? "50%" : undefined,
          transform: `scale(${scaleVal}) translate(${xOffset}%, ${yOffset}%)`,
          transformOrigin: "center center",
        }}
        draggable={false}
      />
      {/* Light semi-transparent overlay with dark shimmer */}
      <div style={{
        position: "absolute", inset: 0,
        background: "rgba(255,255,255,0.52)",
        backgroundImage: "linear-gradient(108deg, transparent 28%, rgba(0,0,0,0.03) 46%, rgba(0,0,0,0.07) 50%, rgba(0,0,0,0.03) 54%, transparent 72%)",
        backgroundSize: "200% 100%",
        animation: "appai-shimmer-sweep 3.4s ease-in-out infinite",
      }} />
      {/* Large centred dark pulsing text */}
      <div style={{
        position: "absolute", inset: 0,
        display: "flex", alignItems: "center", justifyContent: "center",
        pointerEvents: "none",
      }}>
        <span style={{
          fontSize: "22px", fontWeight: 700,
          color: "rgba(0,0,0,0.75)",
          textAlign: "center", lineHeight: 1.25,
          letterSpacing: "-0.01em",
          textShadow: "0 1px 8px rgba(255,255,255,0.6)",
          animation: "appai-text-pulse 2.6s ease-in-out infinite",
        }}>
          Creating<br />Mockups
        </span>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   SkeletonLoader — grey shimmer for saved design loading (no text, brief flash)
   ───────────────────────────────────────────────────────────────────────────── */
function SkeletonLoader() {
  ensureStyles();
  return (
    <div style={{
      position: "absolute", inset: 0,
      background: "linear-gradient(90deg, #e0e0e0 25%, #c8c8c8 50%, #e0e0e0 75%)",
      backgroundSize: "200% 100%",
      animation: "appai-skeleton 1.8s ease-in-out infinite",
    }} />
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
  isAop = false,
}: ProductMockupProps) {
  const displayUrl = mockupUrl ?? imageUrl;

  if (typeof window !== "undefined") {
    (window as any).__productMockupDebug = { designerType, imageUrl, isLoading };
  }
  console.log("[ProductMockup] RENDER designerType:", designerType, "imageUrl:", imageUrl, "isLoading:", isLoading);

  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement | null>(null);

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
    switch (designerType) {
      case "pillow":
        return { borderRadius: printShape === "circle" ? "50%" : "0.5rem", boxShadow: "0 4px 12px rgba(0,0,0,0.15)" };
      case "framed-print":
        return { borderRadius: "0.375rem" };
      case "mug":
        return { borderRadius: "0" };
      default:
        return { borderRadius: "0.375rem" };
    }
  };

  /* ── Image content renderer ─────────────────────────────────────────────── */
  const renderImageContent = () => {
    if (isLoading) {
      // Stage 1: artwork generation in progress
      if (loadingStage === "generating") {
        return <GeneratingLoader isAop={isAop} />;
      }
      // Stage 2: AOP pattern tiling in progress
      if (loadingStage === "pattern") {
        return <PatternLoader />;
      }
      // Stage 3: mockup generation — artwork visible with overlay
      if (loadingStage === "mockups" && imageUrl) {
        return <MockupsLoader imageUrl={imageUrl} transform={transform} printShape={printShape} />;
      }
      // Fallback: saved design or unknown loading state — skeleton shimmer
      return <SkeletonLoader />;
    }

    // Composite mockup (Printify) — full-bleed product photo
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
          className="absolute inset-0 w-full h-full object-contain"
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
          style={{ pointerEvents: "none", opacity: 0.92, transform: blankScale, transformOrigin: "center center" }}
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

  /* ── Product-type renderers ─────────────────────────────────────────────── */

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
          style={{ backgroundColor: selectedFrameColor?.hex || "#1a1a1a", pointerEvents: "none", inset: frameInsets.outer }}
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
          <div className="absolute inset-0 rounded-full overflow-hidden" style={{ clipPath: "circle(50% at 50% 50%)" }}>
            {renderImageContent()}
          </div>
        )}
        {printShape !== "circle" && renderImageContent()}
        {showSafeZone && canvasConfig && <SafeZoneMask shape={printShape} canvasConfig={canvasConfig} showMask={true} />}
      </div>
    );
  };

  const renderMug = () => (
    <div className="absolute inset-0 flex items-center justify-center overflow-hidden rounded-md">
      {renderImageContent()}
      {showSafeZone && canvasConfig && <SafeZoneMask shape={printShape} canvasConfig={canvasConfig} showMask={true} />}
    </div>
  );

  const renderGeneric = () => {
    // For loading states and when displaying artwork/mockups, use inset-0 so the
    // full container is used — avoids cropping tall portrait images (e.g. phone cases).
    // Only apply inset-4 padding when showing the blank placeholder state.
    const hasContent = isLoading || !!displayUrl || !!blankImageUrl;
    const insetClass = hasContent ? "absolute inset-0" : "absolute inset-4";
    return (
      <div
        className={`${insetClass} flex items-center justify-center overflow-hidden ${isLoading ? "bg-black" : "bg-transparent"} rounded-md`}
        style={{ pointerEvents: "none" }}
      >
        {renderImageContent()}
        {showSafeZone && canvasConfig && <SafeZoneMask shape={printShape} canvasConfig={canvasConfig} showMask={true} />}
      </div>
    );
  };

  const renderProductMockup = () => {
    switch (designerType) {
      case "framed-print": return renderFramedPrint();
      case "pillow":       return renderPillow();
      case "mug":          return renderMug();
      default:             return renderGeneric();
    }
  };

  const isDragActive = !!displayUrl && enableDrag && !mockupUrl;

  return (
    <div
      className={`relative rounded-md w-full h-full ${isDragActive ? "cursor-move select-none" : ""}`}
      style={{ touchAction: isDragActive ? "none" : "pan-y" }}
      {...(isDragActive ? {
        onMouseDown: handleMouseDown,
        onMouseMove: handleMouseMove,
        onMouseUp: handleMouseUp,
        onMouseLeave: handleMouseUp,
      } : {})}
      data-testid="product-mockup"
    >
      {renderProductMockup()}
    </div>
  );
}
