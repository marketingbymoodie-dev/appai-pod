import { useState, useCallback, useEffect, useRef } from "react";
import type { ImageTransform, DesignerState, ProductDesignerConfig } from "./types";

const DEFAULT_TRANSFORM: ImageTransform = { scale: 100, x: 50, y: 50 };

export function useDesignerState(config: ProductDesignerConfig | null) {
  const [prompt, setPrompt] = useState("");
  const [selectedPreset, setSelectedPreset] = useState("none");
  const [selectedSize, setSelectedSize] = useState("");
  const [selectedFrameColor, setSelectedFrameColor] = useState("");
  const [referenceImage, setReferenceImage] = useState<File | null>(null);
  const [referencePreview, setReferencePreview] = useState<string | null>(null);
  const [generatedImageUrl, setGeneratedImageUrl] = useState<string | null>(null);
  const [generatedDesignId, setGeneratedDesignId] = useState<string | null>(null);
  const [transform, setTransform] = useState<ImageTransform>(DEFAULT_TRANSFORM);
  const [isGenerating, setIsGenerating] = useState(false);

  const prevConfigId = useRef<number | null>(null);

  useEffect(() => {
    if (config && config.id !== prevConfigId.current) {
      prevConfigId.current = config.id;
      
      if (config.sizes.length > 0 && !selectedSize) {
        setSelectedSize(config.sizes[0].id);
      }
      if (config.frameColors.length > 0 && !selectedFrameColor) {
        setSelectedFrameColor(config.frameColors[0].id);
      }
    }
  }, [config, selectedSize, selectedFrameColor]);

  const handleReferenceChange = useCallback((file: File | null) => {
    setReferenceImage(file);
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => setReferencePreview(reader.result as string);
      reader.readAsDataURL(file);
    } else {
      setReferencePreview(null);
    }
  }, []);

  const handleGenerationSuccess = useCallback((imageUrl: string, designId: string) => {
    setGeneratedImageUrl(imageUrl);
    setGeneratedDesignId(designId);
    setTransform(DEFAULT_TRANSFORM);
    setIsGenerating(false);
  }, []);

  const resetDesign = useCallback(() => {
    setPrompt("");
    setGeneratedImageUrl(null);
    setGeneratedDesignId(null);
    setTransform(DEFAULT_TRANSFORM);
    setReferenceImage(null);
    setReferencePreview(null);
  }, []);

  const state: DesignerState = {
    prompt,
    selectedPreset,
    selectedSize,
    selectedFrameColor,
    referenceImage,
    referencePreview,
    generatedImageUrl,
    generatedDesignId,
    transform,
    isGenerating,
  };

  return {
    state,
    setPrompt,
    setSelectedPreset,
    setSelectedSize,
    setSelectedFrameColor,
    setTransform,
    setIsGenerating,
    handleReferenceChange,
    handleGenerationSuccess,
    resetDesign,
  };
}
