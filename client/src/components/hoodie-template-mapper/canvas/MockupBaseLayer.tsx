import { useEffect, useRef } from "react";
import { Image as KonvaImage, Layer, Transformer } from "react-konva";
import Konva from "konva";
import type { MockupAsset } from "@shared/hoodieTemplate";

/**
 * Base garment mockup layer — draggable/resizable when unlocked so admins can
 * align a new blank photo against existing panel masks (e.g. pullover vs zip).
 */
type Props = {
  mockup: MockupAsset;
  image: HTMLImageElement;
  panLocked?: boolean;
  onChange: (patch: { x: number; y: number; scale: number }) => void;
};

const HANDLE_FILL = "#38bdf8";
const HANDLE_STROKE = "#0f172a";

export default function MockupBaseLayer({ mockup, image, panLocked = false, onChange }: Props) {
  const locked = mockup.transformLocked === true;
  const interactive = !locked && !panLocked;
  const imageRef = useRef<Konva.Image | null>(null);
  const transformerRef = useRef<Konva.Transformer | null>(null);

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

  const x = mockup.x ?? 0;
  const y = mockup.y ?? 0;
  const scale = mockup.scale ?? 1;

  return (
    <Layer listening={interactive}>
      <KonvaImage
        ref={imageRef as any}
        image={image}
        x={x}
        y={y}
        width={mockup.width * scale}
        height={mockup.height * scale}
        draggable={interactive}
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
          const newScaleX = node.scaleX();
          const newScaleY = node.scaleY();
          const newScale = scale * ((newScaleX + newScaleY) / 2);
          node.scaleX(1);
          node.scaleY(1);
          node.width(mockup.width * newScale);
          node.height(mockup.height * newScale);
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
          boundBoxFunc={(oldBox, newBox) => {
            if (newBox.width < 20 || newBox.height < 20) return oldBox;
            return newBox;
          }}
        />
      )}
    </Layer>
  );
}
