import { useState, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Loader2, Zap, Clock, DollarSign, AlertTriangle, CheckCircle2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import type { Merchant } from "@shared/schema";

interface AiModel {
  id: string;
  name: string;
  provider: string;
  description: string;
  estimatedTime: string;
  costPerGen: number; // in credits or tokens
  isFast: boolean;
  replicateModel?: string;
}

const AI_MODELS: AiModel[] = [
  {
    id: "nano-banana",
    name: "Nano Banana (Current Default)",
    provider: "Replicate",
    description: "The model you've been using. Reliable, well-tested, and optimised for your store's style presets.",
    estimatedTime: "15-25s",
    costPerGen: 1,
    isFast: false,
    replicateModel: "replicate:5bdc2c7cd642ae33611d8c33f79615f98ff02509ab8db9d8ec1cc6c36d378fba",
  },
  {
    id: "sdxl-lightning",
    name: "SDXL Lightning (Fastest)",
    provider: "Replicate",
    description: "High quality images in just 3-5 seconds. Best for real-time pattern editing.",
    estimatedTime: "3-5s",
    costPerGen: 1,
    isFast: true,
    replicateModel: "replicate:lucataco/sdxl-lightning-4step:727e49a643e999d602a896c774a0658ffefea21465756a6ce24b7af4165eba9a",
  },
  {
    id: "flux-schnell",
    name: "Flux Schnell",
    provider: "Replicate",
    description: "Next-gen model with incredible detail and speed. Great balance of quality and cost.",
    estimatedTime: "4-6s",
    costPerGen: 1.5,
    isFast: true,
    replicateModel: "replicate:black-forest-labs/flux-schnell",
  },
  {
    id: "stable-diffusion-3",
    name: "Stable Diffusion 3",
    provider: "Replicate",
    description: "State-of-the-art quality with better text rendering. Slower but very high quality.",
    estimatedTime: "15-20s",
    costPerGen: 2,
    isFast: false,
    replicateModel: "replicate:stability-ai/stable-diffusion-3",
  },
  {
    id: "sdxl",
    name: "SDXL (Standard)",
    provider: "Replicate",
    description: "The industry standard for high-quality AI art. Reliable and well-tested.",
    estimatedTime: "15-25s",
    costPerGen: 1,
    isFast: false,
    replicateModel: "replicate:stability-ai/sdxl:7762fd0e0f370ed7a503f304e2a75a1ca53bc52447c5713b71e8fdc5704ff232",
  },
];

export default function AiModelSelector() {
  const { toast } = useToast();
  const [selectedModelId, setSelectedModelId] = useState<string>("nano-banana");
  const [activeModelId, setActiveModelId] = useState<string>("nano-banana");
  const [hasAgreed, setHasAgreed] = useState(false);
  const [isEditing, setIsEditing] = useState(false);

  const { data: merchant, isLoading: merchantLoading } = useQuery<Merchant>({
    queryKey: ["/api/merchant"],
  });

  useEffect(() => {
    if (merchant) {
      // Find the currently saved model
      const currentModel = AI_MODELS.find(m => m.replicateModel === merchant.selectedAiModel);
      const modelId = currentModel ? currentModel.id : "nano-banana";
      setSelectedModelId(modelId);
      setActiveModelId(modelId); // track what's actually saved
      setHasAgreed(merchant.hasAgreedToAiCosts || false);
    }
  }, [merchant]);

  const updateModelMutation = useMutation({
    mutationFn: async (data: { selectedAiModel: string; hasAgreedToAiCosts: boolean }) => {
      const response = await apiRequest("PUT", "/api/merchant", data);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/merchant"] });
      toast({ title: "AI Model Updated", description: "Your generation settings have been saved." });
      setIsEditing(false);
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update model", description: error.message, variant: "destructive" });
    },
  });

  const handleSave = () => {
    if (!hasAgreed) {
      toast({ 
        title: "Agreement Required", 
        description: "Please agree to the usage costs before saving.", 
        variant: "destructive" 
      });
      return;
    }

    const model = AI_MODELS.find(m => m.id === selectedModelId);
    if (model && model.replicateModel) {
      updateModelMutation.mutate({
        selectedAiModel: model.replicateModel,
        hasAgreedToAiCosts: true,
      });
    }
  };

  if (merchantLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-96 mt-2" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-40 w-full" />
        </CardContent>
      </Card>
    );
  }

  const selectedModel = AI_MODELS.find(m => m.id === selectedModelId) || AI_MODELS[0];

  return (
    <Card className="border-primary/20">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Zap className="h-5 w-5 text-yellow-500" />
          AI Generation Model
        </CardTitle>
        <CardDescription>
          Choose the AI model used for generating artwork. Faster models provide a better experience for AOP pattern editing.
          {merchant?.selectedAiModel && (
            <span className="ml-2 inline-flex items-center gap-1 bg-primary/10 text-primary text-[11px] font-semibold px-2 py-0.5 rounded-full">
              <CheckCircle2 className="h-3 w-3" />
              Currently using: {AI_MODELS.find(m => m.replicateModel === merchant.selectedAiModel)?.name ?? "Nano Banana (Current Default)"}
            </span>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <RadioGroup 
          value={selectedModelId} 
          onValueChange={(val) => {
            setSelectedModelId(val);
            setIsEditing(true);
          }}
          className="grid gap-4"
        >
          {AI_MODELS.map((model) => (
            <div key={model.id} className="relative">
              <RadioGroupItem
                value={model.id}
                id={model.id}
                className="peer sr-only"
              />
              <Label
                htmlFor={model.id}
                className="flex flex-col items-start justify-between rounded-md border-2 border-muted bg-popover p-4 hover:bg-accent hover:text-accent-foreground peer-data-[state=checked]:border-primary [&:has([data-state=checked])]:border-primary cursor-pointer"
              >
                <div className="flex w-full justify-between items-center mb-1">
                  <span className="font-bold text-base">{model.name}</span>
                  <div className="flex items-center gap-2">
                    {activeModelId === model.id && (
                      <span className="bg-primary/10 text-primary text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1">
                        <CheckCircle2 className="h-3 w-3" /> ACTIVE
                      </span>
                    )}
                    {model.isFast && (
                      <span className="bg-green-100 text-green-700 text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1">
                        <Zap className="h-3 w-3" /> FAST
                      </span>
                    )}
                  </div>
                </div>
                <p className="text-sm text-muted-foreground mb-3">{model.description}</p>
                <div className="flex gap-4 text-xs font-medium">
                  <div className="flex items-center gap-1 text-blue-600">
                    <Clock className="h-3 w-3" /> {model.estimatedTime}
                  </div>
                  <div className="flex items-center gap-1 text-orange-600">
                    <DollarSign className="h-3 w-3" /> {model.costPerGen} credits/gen
                  </div>
                </div>
              </Label>
              {selectedModelId === model.id && (
                <div className="absolute top-4 right-4">
                  <CheckCircle2 className="h-5 w-5 text-primary" />
                </div>
              )}
            </div>
          ))}
        </RadioGroup>

        <div className="bg-muted/30 p-4 rounded-lg border space-y-3">
          <h4 className="font-semibold text-sm flex items-center gap-2">
            <DollarSign className="h-4 w-4" /> Usage Calculator
          </h4>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div className="space-y-1">
              <p className="text-muted-foreground">Cost per 100 generations:</p>
              <p className="font-bold">{selectedModel.costPerGen * 100} Credits</p>
            </div>
            <div className="space-y-1">
              <p className="text-muted-foreground">Estimated wait time:</p>
              <p className="font-bold text-blue-600">{selectedModel.estimatedTime}</p>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground italic">
            * Costs are deducted from the merchant's credit balance. Faster models are recommended for All-Over Print products to ensure the pattern editor remains responsive.
          </p>
        </div>

        <Alert variant={selectedModel.isFast ? "default" : "warning"} className={selectedModel.isFast ? "bg-green-50 border-green-200" : "bg-yellow-50 border-yellow-200"}>
          {selectedModel.isFast ? <Zap className="h-4 w-4 text-green-600" /> : <AlertTriangle className="h-4 w-4 text-yellow-600" />}
          <AlertTitle className={selectedModel.isFast ? "text-green-800" : "text-yellow-800"}>
            {selectedModel.isFast ? "Recommended for AOP" : "Slow Generation Warning"}
          </AlertTitle>
          <AlertDescription className={selectedModel.isFast ? "text-green-700" : "text-yellow-700"}>
            {selectedModel.isFast 
              ? "This model is optimized for speed, making it perfect for the real-time pattern editor." 
              : "This model may take up to 25 seconds to generate. Users might experience delays in the pattern editor."}
          </AlertDescription>
        </Alert>

        <div className="flex items-start space-x-3 pt-2">
          <Checkbox 
            id="agree-costs" 
            checked={hasAgreed} 
            onCheckedChange={(checked) => {
              setHasAgreed(checked === true);
              setIsEditing(true);
            }}
          />
          <div className="grid gap-1.5 leading-none">
            <label
              htmlFor="agree-costs"
              className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
            >
              I agree to the usage costs for the selected model
            </label>
            <p className="text-xs text-muted-foreground">
              Changing models will affect the credit cost for every generation made by your customers.
            </p>
          </div>
        </div>
      </CardContent>
      <CardFooter className="flex justify-end border-t bg-muted/10 pt-6">
        <Button 
          onClick={handleSave} 
          disabled={!isEditing || updateModelMutation.isPending}
          className="gap-2"
        >
          {updateModelMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
          Save AI Settings
        </Button>
      </CardFooter>
    </Card>
  );
}
