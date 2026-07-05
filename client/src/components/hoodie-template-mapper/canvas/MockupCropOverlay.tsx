import { useEffect, useRef } from "react";
import { Layer, Rect, Transformer } from "react-konva";
import Konva from "konva";
import type { CropRect } from "../lib/mockupCrop";

type Props = {
  mockupWidth: number;
  mockupHeight: number;
  rect: CropRect;
  zoom: number;
  onChange: (rect: CropRect) => void;
};

function clampRect(rect: CropRect, maxW: number, maxH: number): CropRect {
  const x = Math.max(0, Math.min(rect.x, maxW - 1));
  const y = Math.max(0, Math.min(rect.y, maxH - 1));
  const width = Math.max(20, Math.min(rect.width, maxW - x));
  const height = Math.max(20, Math.min(rect.height, maxH - y));
  return { x, y, width, height };
}

export default function MockupCropOverlay({ mockupWidth, mockupHeight, rect, zoom, onChange }: Props) {
  const rectRef = useRef<Konva.Rect | null>(null);
  const trRef = useRef<Konva.Transformer | null>(null);

  useEffect(() => {
    const tr = trRef.current;
    const node = rectRef.current;
    if (!tr || !node) return;
    tr.nodes([node]);
    tr.getLayer()?.batchDraw();
  }, [rect.x, rect.y, rect.width, rect.height]);

  const stroke = 2 / zoom;

  return (
    <Layer>
      {/* Dim outside crop region */}
      <Rect x={0} y={0} width={mockupWidth} height={rect.y} fill="rgba(15, 23, 42, 0.55)" listening={false} />
      <Rect
        x={0}
        y={rect.y + rect.height}
        width={mockupWidth}
        height={Math.max(0, mockupHeight - rect.y - rect.height)}
        fill="rgba(15, 23, 42, 0.55)"
        listening={false}
      />
      <Rect
        x={0}
        y={rect.y}
        width={rect.x}
        height={rect.height}
        fill="rgba(15, 23, 42, 0.55)"
        listening={false}
      />
      <Rect
        x={rect.x + rect.width}
        y={rect.y}
        width={Math.max(0, mockupWidth - rect.x - rect.width)}
        height={rect.height}
        fill="rgba(15, 23, 42, 0.55)"
        listening={false}
      />

      <Rect
        ref={rectRef as any}
        x={rect.x}
        y={rect.y}
        width={rect.width}
        height={rect.height}
        fill="rgba(56, 189, 248, 0.06)"
        stroke="#38bdf8"
        strokeWidth={stroke}
        draggable
        dragBoundFunc={(pos) => {
          const nx = Math.max(0, Math.min(pos.x, mockupWidth - rect.width));
          const ny = Math.max(0, Math.min(pos.y, mockupHeight - rect.height));
          return { x: nx, y: ny };
        }}
        onDragEnd={(e) => {
          const node = e.target as Konva.Rect;
          onChange(
            clampRect(
              { x: node.x(), y: node.y(), width: node.width(), height: node.height() },
              mockupWidth,
              mockupHeight,
            ),
          );
        }}
        onTransformEnd={(e) => {
          const node = e.target as Konva.Rect;
          const scaleX = node.scaleX();
          const scaleY = node.scaleY();
          node.scaleX(1);
          node.scaleY(1);
          onChange(
            clampRect(
              {
                x: node.x(),
                y: node.y(),
                width: Math.max(20, node.width() * scaleX),
                height: Math.max(20, node.height() * scaleY),
              },
              mockupWidth,
              mockupHeight,
            ),
          );
        }}
      />
      <Transformer
        ref={trRef as any}
        rotateEnabled={false}
        keepRatio={false}
        boundBoxFunc={(oldBox, newBox) => {
          if (newBox.width < 20 || newBox.height < 20) return oldBox;
          if (newBox.x < 0 || newBox.y < 0) return oldBox;
          if (newBox.x + newBox.width > mockupWidth) return oldBox;
          if (newBox.y + newBox.height > mockupHeight) return oldBox;
          return newBox;
        }}
        anchorStroke="#38bdf8"
        anchorFill="#0f172a"
        borderStroke="#38bdf8"
      />
    </Layer>
  );
}
