import { useEffect, useState } from "react";
import { isMapperAuthAssetUrl, loadMapperAssetImage } from "./mapperAssetImage";

export type MapperAssetImageState = {
  img: HTMLImageElement | null;
  /** Blob/object URL for <img src> previews; revoked on unmount. */
  previewUrl: string | null;
  loading: boolean;
  error: string | null;
};

const EMPTY: MapperAssetImageState = {
  img: null,
  previewUrl: null,
  loading: false,
  error: null,
};

export function useMapperAssetImage(src: string | null | undefined): MapperAssetImageState {
  const [state, setState] = useState<MapperAssetImageState>(EMPTY);

  useEffect(() => {
    if (!src) {
      setState(EMPTY);
      return;
    }

    let cancelled = false;
    let blobUrl: string | null = null;
    setState({ img: null, previewUrl: null, loading: true, error: null });

    (async () => {
      try {
        if (isMapperAuthAssetUrl(src)) {
          const res = await fetch(src, { credentials: "include", cache: "no-store" });
          if (!res.ok) throw new Error(`Failed to load asset (${res.status})`);
          const blob = await res.blob();
          blobUrl = URL.createObjectURL(blob);
          const img = await new Promise<HTMLImageElement>((resolve, reject) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = () => reject(new Error("Failed to decode image"));
            el.src = blobUrl!;
          });
          if (cancelled) return;
          setState({ img, previewUrl: blobUrl, loading: false, error: null });
          return;
        }

        const img = await loadMapperAssetImage(src);
        if (cancelled) return;
        setState({ img, previewUrl: src, loading: false, error: null });
      } catch (err: unknown) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ img: null, previewUrl: null, loading: false, error: message });
      }
    })();

    return () => {
      cancelled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [src]);

  return state;
}

export async function loadMapperAssetImageMap(
  urls: string[],
): Promise<Map<string, HTMLImageElement>> {
  const map = new Map<string, HTMLImageElement>();
  await Promise.all(
    urls.map(async (url) => {
      try {
        map.set(url, await loadMapperAssetImage(url));
      } catch {
        /* skip failed panels */
      }
    }),
  );
  return map;
}

export function MapperAssetThumbnail({
  src,
  alt,
  className,
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  const { previewUrl, loading, error } = useMapperAssetImage(src);

  if (loading) {
    return (
      <div className={`flex items-center justify-center bg-slate-900 text-[10px] text-slate-500 ${className ?? ""}`}>
        Loading…
      </div>
    );
  }
  if (error || !previewUrl) {
    return (
      <div className={`flex items-center justify-center bg-slate-900 px-2 text-center text-[10px] text-red-300 ${className ?? ""}`}>
        Could not load preview
      </div>
    );
  }
  return <img src={previewUrl} alt={alt} className={className} />;
}
