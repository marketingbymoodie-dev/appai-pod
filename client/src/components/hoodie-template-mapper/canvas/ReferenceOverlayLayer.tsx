import { useEffect, useRef } from "react";
import { Image as KonvaImage, Layer, Transformer } from "react-konva";
import Konva from "konva";
import type { ReferenceOverlayAsset } from "@shared/hoodieTemplate";

/**
 * Reference-overlay rendering layer.
 *
 * - Locked: passive Konva image, listening disabled, no transform handles.
 * - Unlocked: draggable, with a `Konva.Transformer` exposing the four corner
 *   anchors. `keepRatio={true}` forces proportional resize so the user
 *   can't accidentally squash the Printify mockup. Rotation is disabled
 *   (we want a clean orthogonal comparison; no need to rotate).
 *
 * Transform commits (drag end, resize end) call `onChange` with the new
 * `{ x, y, scale }` so the parent can persist into the template state.
 */

type Props = {
  overlay: ReferenceOverlayAsset;
  image: HTMLImageElement;
  /**
   * True while the user is holding Space to pan the canvas. When true,
   * the layer falls back to listening=false so pan drags pass through
   * even if they start on top of the overlay.
   */
  panLocked?: boolean;
  onChange: (patch: { x: number; y: number; scale: number }) => void;
};

const HANDLE_FILL = "#fbbf24";
const HANDLE_STROKE = "#0f172a";

export default function ReferenceOverlayLayer({ overlay, image, panLocked = false, onChange }: Props) {
  const interactive = !overlay.locked && !panLocked;
  const imageRef = useRef<Konva.Image | null>(null);
  const transformerRef = useRef<Konva.Transformer | null>(null);

  // Wire the transformer to the image whenever interactivity changes.
  useEffect(() => {
    const tr = transformerRef.current;
    const node = imageRef.current;
    if (!tr || !node) return;
    if (interactive) {
      tr.nodes([node]);
    } else {
      tr.nodes([]);
    }
    tr.getLayer()?.batchDraw();
  }, [interactive, image]);

  const x = overlay.x ?? 0;
  const y = overlay.y ?? 0;
  const scale = overlay.scale ?? 1;
  const renderOpacity = overlay.visible ? overlay.opacity : 0;

  return (
    <Layer listening={interactive}>
      <KonvaImage
        ref={imageRef as any}
        image={image}
        x={x}
        y={y}
        width={overlay.width * scale}
        height={overlay.height * scale}
        opacity={renderOpacity}
        draggable={interactive}
        // Slight cursor hint so users know they can grab the overlay.
        onMouseEnter={(e) => {
          if (!interactive) return;
          const stage = e.target.getStage();
          if (stage) stage.container().style.cursor = "move";
        }}
        onMouseLeave={(e) => {
          const stage = e.target.getStage();
          if (stage) stage.container().style.cursor = "default";
        }}
        onDragEnd={(e) => {
          onChange({ x: e.target.x(), y: e.target.y(), scale });
        }}
        onTransformEnd={(e) => {
          const node = e.target as Konva.Image;
          // Konva's Transformer applies scaleX/scaleY on the node. Convert
          // that into our uniform `scale` and reset the node's local scale
          // so successive transforms don't compound.
          const newScaleX = node.scaleX();
          const newScaleY = node.scaleY();
          const newScale = scale * ((newScaleX + newScaleY) / 2);
          node.scaleX(1);
          node.scaleY(1);
          // Apply the new width/height so the visual matches the schema
          // before the parent re-renders.
          node.width(overlay.width * newScale);
          node.height(overlay.height * newScale);
          onChange({ x: node.x(), y: node.y(), scale: newScale });
        }}
      />
      {interactive && (
        <Transformer
          ref={transformerRef as any}
          rotateEnabled={false}
          keepRatio
          enabledAnchors={["top-left", "top-right", "bottom-left", "bottom-right"]}
          anchorFill={HANDLE_FILL}
          anchorStroke={HANDLE_STROKE}
          anchorSize={9}
          borderStroke={HANDLE_FILL}
          borderDash={[6, 4]}
          // Don't allow handles to invert the image into negative scale,
          // which would mirror the Printify reference.
          boundBoxFunc={(oldBox, newBox) => {
            if (newBox.width < 20 || newBox.height < 20) return oldBox;
            return newBox;
          }}
        />
      )}
    </Layer>
  );
}
