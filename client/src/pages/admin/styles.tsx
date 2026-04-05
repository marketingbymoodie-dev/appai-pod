import { useState, useMemo, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Palette, Plus, Trash2, Edit2, Frame, Shirt, RefreshCw, ImagePlus, X } from "lucide-react";
import AdminLayout from "@/components/admin-layout";
import type { StylePresetDB } from "@shared/schema";

type FilterCategory = "show-all" | "all" | "decor" | "apparel";

interface SubStyleChoice {
  id: string;
  name: string;
  promptFragment: string;
  baseImageUrl?: string;
}

interface StyleOptions {
  label: string;
  required: boolean;
  choices: SubStyleChoice[];
}

// ── Upload helper ─────────────────────────────────────────────────────────────
// Uses POST /api/uploads/upload with JSON { dataUrl, name } body.
// The server uses express.json() globally so raw binary bodies don't work —
// we must convert to base64 data URL first.
// Returns the public path, e.g. "/objects/uploads/uuid.png"
async function uploadFile(file: File): Promise<string> {
  // Convert file to base64 data URL
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
  const res = await fetch("/api/uploads/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataUrl, name: file.name }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Upload failed (${res.status}): ${err}`);
  }
  const data = await res.json();
  // Response: { objectPath: "/objects/uploads/uuid.png" }
  return data.objectPath as string;
}

export default function AdminStyles() {
  const { toast } = useToast();

  // ── Dialog state ──────────────────────────────────────────────────────────
  const [styleDialogOpen, setStyleDialogOpen] = useState(false);
  const [editingStyle, setEditingStyle] = useState<StylePresetDB | null>(null);

  // Main style fields
  const [styleName, setStyleName] = useState("");
  const [stylePrompt, setStylePrompt] = useState("");
  // Category stored as Set of "decor" | "apparel" — empty means "all"
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set());
  const [styleBaseImageUrl, setStyleBaseImageUrl] = useState<string>("");
  const [stylePromptPlaceholder, setStylePromptPlaceholder] = useState<string>("");
  const [isUploadingBaseImage, setIsUploadingBaseImage] = useState(false);

  // Sub-style options
  const [subStylesEnabled, setSubStylesEnabled] = useState(false);
  const [subStyleLabel, setSubStyleLabel] = useState("Style");
  const [subStyleRequired, setSubStyleRequired] = useState(true);
  const [subStyleChoices, setSubStyleChoices] = useState<SubStyleChoice[]>([]);
  const [uploadingChoiceIdx, setUploadingChoiceIdx] = useState<number | null>(null);

  // Filter
  const [filterCategory, setFilterCategory] = useState<FilterCategory>("show-all");

   // Textarea ref for auto-resize
  const promptTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Resize helper — sets height to fit content
  const resizeTextarea = () => {
    const el = promptTextareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  };

  // Auto-resize whenever the value changes
  useEffect(() => {
    resizeTextarea();
  }, [stylePrompt]);

  // When the dialog opens, wait for the animation to finish then resize
  useEffect(() => {
    if (!styleDialogOpen) return;
    // Radix Dialog animates in over ~150ms; wait for it to finish
    const t = setTimeout(() => resizeTextarea(), 200);
    return () => clearTimeout(t);
  }, [styleDialogOpen]);

  // ── Queries ───────────────────────────────────────────────────────────────
  const { data: styles, isLoading: stylesLoading } = useQuery<StylePresetDB[]>({
    queryKey: ["/api/admin/styles"],
  });

  // ── Mutations ─────────────────────────────────────────────────────────────
  const createStyleMutation = useMutation({
    mutationFn: async (data: any) => {
      const response = await apiRequest("POST", "/api/admin/styles", data);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/styles"] });
      setStyleDialogOpen(false);
      resetStyleForm();
      toast({ title: "Style created", description: "Your custom style is ready to use." });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to create style", description: error.message, variant: "destructive" });
    },
  });

  const updateStyleMutation = useMutation({
    mutationFn: async ({ id, ...data }: { id: number } & any) => {
      const response = await apiRequest("PATCH", `/api/admin/styles/${id}`, data);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/styles"] });
      setStyleDialogOpen(false);
      resetStyleForm();
      toast({ title: "Style updated" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update style", description: error.message, variant: "destructive" });
    },
  });

  const toggleActiveMutation = useMutation({
    mutationFn: async ({ id, isActive }: { id: number; isActive: boolean }) => {
      const response = await apiRequest("PATCH", `/api/admin/styles/${id}`, { isActive });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/styles"] });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update style", description: error.message, variant: "destructive" });
    },
  });

  const deleteStyleMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/admin/styles/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/styles"] });
      toast({ title: "Style deleted" });
    },
  });

  const reseedStylesMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/admin/styles/reseed");
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/styles"] });
      queryClient.invalidateQueries({ queryKey: ["/api/config"] });
      toast({
        title: "Styles updated",
        description: `Updated ${data.updated} styles, created ${data.created} new styles.`,
      });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to reseed styles", description: error.message, variant: "destructive" });
    },
  });

  // ── Helpers ───────────────────────────────────────────────────────────────
  const resetStyleForm = () => {
    setEditingStyle(null);
    setStyleName("");
    setStylePrompt("");
    setSelectedCategories(new Set());
    setStyleBaseImageUrl("");
    setStylePromptPlaceholder("");
    setSubStylesEnabled(false);
    setSubStyleLabel("Style");
    setSubStyleRequired(true);
    setSubStyleChoices([]);
  };

  // Convert Set<string> to the DB category string
  const categoriesToDbValue = (cats: Set<string>): string => {
    if (cats.has("decor") && cats.has("apparel")) return "all";
    if (cats.has("decor")) return "decor";
    if (cats.has("apparel")) return "apparel";
    return "all"; // default: show for all
  };

  // Convert DB category string to Set<string>
  const dbValueToCategories = (cat: string | null | undefined): Set<string> => {
    if (!cat || cat === "all") return new Set(["decor", "apparel"]);
    if (cat === "decor") return new Set(["decor"]);
    if (cat === "apparel") return new Set(["apparel"]);
    return new Set(["decor", "apparel"]);
  };

  const toggleCategory = (cat: string) => {
    setSelectedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) {
        next.delete(cat);
      } else {
        next.add(cat);
      }
      return next;
    });
  };

  const handleEditStyle = (style: StylePresetDB) => {
    setEditingStyle(style);
    setStyleName(style.name);
    setStylePrompt(style.promptPrefix || "");
    setSelectedCategories(dbValueToCategories(style.category));
    setStyleBaseImageUrl((style as any).baseImageUrl || "");
    setStylePromptPlaceholder((style as any).promptPlaceholder || "");

    const opts: StyleOptions | null = (style as any).options ?? null;
    if (opts && opts.choices && opts.choices.length > 0) {
      setSubStylesEnabled(true);
      setSubStyleLabel(opts.label || "Style");
      setSubStyleRequired(opts.required !== false);
      setSubStyleChoices(opts.choices.map((c: SubStyleChoice) => ({ ...c })));
    } else {
      setSubStylesEnabled(false);
      setSubStyleLabel("Style");
      setSubStyleRequired(true);
      setSubStyleChoices([]);
    }

    setStyleDialogOpen(true);
  };

  const handleBaseImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsUploadingBaseImage(true);
    try {
      const objectPath = await uploadFile(file);
      setStyleBaseImageUrl(objectPath);
    } catch (err) {
      toast({ title: "Upload failed", description: String(err), variant: "destructive" });
    } finally {
      setIsUploadingBaseImage(false);
      // Reset input so same file can be re-selected
      e.target.value = "";
    }
  };

  const handleChoiceImageUpload = async (idx: number, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingChoiceIdx(idx);
    try {
      const objectPath = await uploadFile(file);
      updateSubStyleChoice(idx, "baseImageUrl", objectPath);
    } catch (err) {
      toast({ title: "Upload failed", description: String(err), variant: "destructive" });
    } finally {
      setUploadingChoiceIdx(null);
      e.target.value = "";
    }
  };

  const handleSaveStyle = () => {
    const category = categoriesToDbValue(selectedCategories);

    const options: StyleOptions | null =
      subStylesEnabled && subStyleChoices.length > 0
        ? {
            label: subStyleLabel || "Style",
            required: subStyleRequired,
            choices: subStyleChoices.filter((c) => c.name.trim() !== ""),
          }
        : null;

    const payload = {
      name: styleName,
      promptPrefix: stylePrompt,
      category,
      baseImageUrl: styleBaseImageUrl || null,
      promptPlaceholder: stylePromptPlaceholder || null,
      options,
    };

    if (editingStyle) {
      updateStyleMutation.mutate({ id: editingStyle.id, ...payload });
    } else {
      createStyleMutation.mutate(payload);
    }
  };

  // Sub-style choice helpers
  const addSubStyleChoice = () => {
    setSubStyleChoices((prev) => [
      ...prev,
      { id: `choice-${Date.now()}`, name: "", promptFragment: "", baseImageUrl: "" },
    ]);
  };

  const updateSubStyleChoice = (idx: number, field: keyof SubStyleChoice, value: string) => {
    setSubStyleChoices((prev) =>
      prev.map((c, i) => (i === idx ? { ...c, [field]: value } : c))
    );
  };

  const removeSubStyleChoice = (idx: number) => {
    setSubStyleChoices((prev) => prev.filter((_, i) => i !== idx));
  };

  const getCategoryLabel = (category: string) => {
    switch (category) {
      case "decor": return "Decor";
      case "apparel": return "Apparel";
      default: return "Decor + Apparel";
    }
  };

  const getCategoryIcon = (category: string) => {
    switch (category) {
      case "decor": return <Frame className="h-3 w-3" />;
      case "apparel": return <Shirt className="h-3 w-3" />;
      default: return <Palette className="h-3 w-3" />;
    }
  };

  const filteredStyles = useMemo(() => {
    if (!styles) return [];
    if (filterCategory === "show-all") return styles;
    if (filterCategory === "decor") return styles.filter((s) => s.category === "decor" || s.category === "all");
    if (filterCategory === "apparel") return styles.filter((s) => s.category === "apparel" || s.category === "all");
    return styles.filter((s) => s.category === filterCategory);
  }, [styles, filterCategory]);

  return (
    <AdminLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold" data-testid="text-styles-title">Styles</h1>
            <p className="text-muted-foreground">Create custom art styles for your customers</p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <Button
              variant="outline"
              onClick={() => reseedStylesMutation.mutate()}
              disabled={reseedStylesMutation.isPending}
              data-testid="button-reseed-styles"
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${reseedStylesMutation.isPending ? "animate-spin" : ""}`} />
              Sync Default Styles
            </Button>
            <Button onClick={() => { resetStyleForm(); setStyleDialogOpen(true); }} data-testid="button-add-style">
              <Plus className="h-4 w-4 mr-2" />
              Add Style
            </Button>
          </div>
        </div>

        {/* Category filter tabs */}
        <Tabs value={filterCategory} onValueChange={(v) => setFilterCategory(v as FilterCategory)}>
          <TabsList data-testid="tabs-category-filter">
            <TabsTrigger value="show-all" data-testid="tab-show-all">
              <Palette className="h-4 w-4 mr-2" />
              Show All
            </TabsTrigger>
            <TabsTrigger value="decor" data-testid="tab-decor">
              <Frame className="h-4 w-4 mr-2" />
              Decor
            </TabsTrigger>
            <TabsTrigger value="apparel" data-testid="tab-apparel">
              <Shirt className="h-4 w-4 mr-2" />
              Apparel
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {/* Style cards */}
        {stylesLoading ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-32" />)}
          </div>
        ) : filteredStyles.length > 0 ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {filteredStyles.map((style) => {
              const opts: StyleOptions | null = (style as any).options ?? null;
              const hasSubStyles = opts && opts.choices && opts.choices.length > 0;
              return (
                <Card
                  key={style.id}
                  className={!style.isActive ? "opacity-60" : ""}
                  data-testid={`card-style-${style.id}`}
                >
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between gap-2">
                      <CardTitle className="text-base">{style.name}</CardTitle>
                      <div className="flex items-center gap-2 flex-wrap justify-end">
                        <Badge variant="outline" className="text-xs flex items-center gap-1">
                          {getCategoryIcon(style.category || "all")}
                          {getCategoryLabel(style.category || "all")}
                        </Badge>
                        {/* Active/Inactive toggle */}
                        <div className="flex items-center gap-1.5">
                          <Switch
                            checked={style.isActive}
                            onCheckedChange={(checked) =>
                              toggleActiveMutation.mutate({ id: style.id, isActive: checked })
                            }
                            data-testid={`toggle-active-${style.id}`}
                          />
                          <span className="text-xs text-muted-foreground">
                            {style.isActive ? "On" : "Off"}
                          </span>
                        </div>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground line-clamp-2 mb-2">
                      {style.promptPrefix || "No prompt prefix"}
                    </p>
                    {hasSubStyles && (
                      <p className="text-xs text-muted-foreground mb-3">
                        {opts!.choices.length} sub-style{opts!.choices.length !== 1 ? "s" : ""}:{" "}
                        {opts!.choices.map((c) => c.name).join(", ")}
                      </p>
                    )}
                    <div className="flex gap-2">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleEditStyle(style)}
                        data-testid={`button-edit-style-${style.id}`}
                      >
                        <Edit2 className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => {
                          if (confirm(`Delete "${style.name}"?`)) deleteStyleMutation.mutate(style.id);
                        }}
                        data-testid={`button-delete-style-${style.id}`}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        ) : (
          <Card>
            <CardContent className="py-12 text-center">
              <Palette className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="font-semibold mb-2">No styles yet</h3>
              <p className="text-muted-foreground mb-4">Create your first custom art style</p>
              <div className="flex gap-2 justify-center">
                <Button
                  variant="outline"
                  onClick={() => reseedStylesMutation.mutate()}
                  disabled={reseedStylesMutation.isPending}
                >
                  <RefreshCw className={`h-4 w-4 mr-2 ${reseedStylesMutation.isPending ? "animate-spin" : ""}`} />
                  Load Default Styles
                </Button>
                <Button onClick={() => { resetStyleForm(); setStyleDialogOpen(true); }}>
                  <Plus className="h-4 w-4 mr-2" />
                  Add Style
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── Edit / Create dialog ──────────────────────────────────────────── */}
        <Dialog open={styleDialogOpen} onOpenChange={setStyleDialogOpen}>
          <DialogContent className="max-w-lg max-h-[90vh] flex flex-col p-0 gap-0">
            {/* Fixed header */}
            <div className="px-6 pt-6 pb-4 border-b shrink-0">
              <DialogHeader>
                <DialogTitle>{editingStyle ? "Edit Style" : "Add New Style"}</DialogTitle>
              </DialogHeader>
            </div>

            {/* Scrollable body */}
            <div className="overflow-y-auto flex-1 px-6 py-4 space-y-4">

              {/* Style Name */}
              <div className="space-y-2">
                <Label htmlFor="style-name">Style Name</Label>
                <Input
                  id="style-name"
                  value={styleName}
                  onChange={(e) => setStyleName(e.target.value)}
                  placeholder="e.g., Watercolor, Pop Art"
                  data-testid="input-style-name"
                />
              </div>

              {/* Product Category — checkboxes so both can be selected */}
              <div className="space-y-2">
                <Label>Product Category</Label>
                <div className="flex gap-6">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <Checkbox
                      checked={selectedCategories.has("decor")}
                      onCheckedChange={() => toggleCategory("decor")}
                    />
                    <span className="text-sm flex items-center gap-1.5">
                      <Frame className="h-3.5 w-3.5" />
                      Decor
                    </span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <Checkbox
                      checked={selectedCategories.has("apparel")}
                      onCheckedChange={() => toggleCategory("apparel")}
                    />
                    <span className="text-sm flex items-center gap-1.5">
                      <Shirt className="h-3.5 w-3.5" />
                      Apparel
                    </span>
                  </label>
                </div>
                <p className="text-xs text-muted-foreground">
                  Select both to show this style for all product types. Decor uses full-bleed artwork; Apparel uses centered graphics.
                </p>
              </div>

              {/* Prompt Prefix — auto-resizing textarea */}
              <div className="space-y-2">
                <Label htmlFor="style-prompt">Prompt Prefix</Label>
                <textarea
                  id="style-prompt"
                  ref={promptTextareaRef}
                  value={stylePrompt}
                  onChange={(e) => setStylePrompt(e.target.value)}
                  placeholder="A beautiful watercolor painting of..."
                  rows={4}
                  style={{
                    width: "100%",
                    minHeight: "96px",
                    resize: "none",
                    overflow: "hidden",
                    padding: "8px 12px",
                    fontSize: "14px",
                    lineHeight: "1.5",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: "calc(var(--radius) - 2px)",
                    backgroundColor: "hsl(var(--background))",
                    color: "hsl(var(--foreground))",
                    outline: "none",
                    fontFamily: "inherit",
                    boxSizing: "border-box",
                  }}
                  onFocus={(e) => {
                    e.target.style.boxShadow = "0 0 0 2px hsl(var(--ring))";
                  }}
                  onBlur={(e) => {
                    e.target.style.boxShadow = "none";
                  }}
                  data-testid="input-style-prompt"
                />
                <p className="text-xs text-muted-foreground">
                  This text will be prepended to the customer's prompt
                </p>
              </div>

              {/* Prompt Placeholder */}
              <div className="space-y-2">
                <Label htmlFor="style-placeholder">
                  Prompt Box Placeholder Text{" "}
                  <span className="text-muted-foreground font-normal">(optional)</span>
                </Label>
                <Input
                  id="style-placeholder"
                  value={stylePromptPlaceholder}
                  onChange={(e) => setStylePromptPlaceholder(e.target.value)}
                  placeholder="e.g. Describe your pet (name, breed, colours)…"
                  data-testid="input-style-placeholder"
                />
                <p className="text-xs text-muted-foreground">
                  Hint text shown inside the customer's prompt box when this style is selected
                </p>
              </div>

              {/* Base Reference Image */}
              <div className="space-y-2">
                <Label>
                  Base Reference Image{" "}
                  <span className="text-muted-foreground font-normal">(optional)</span>
                </Label>
                <div className="flex items-center gap-3">
                  {styleBaseImageUrl ? (
                    <div className="relative shrink-0">
                      <img
                        src={styleBaseImageUrl}
                        alt="Base"
                        className="w-12 h-12 rounded object-cover border"
                      />
                      <button
                        type="button"
                        onClick={() => setStyleBaseImageUrl("")}
                        className="absolute -top-1 -right-1 w-4 h-4 bg-destructive text-destructive-foreground rounded-full text-xs flex items-center justify-center"
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </div>
                  ) : (
                    <div className="w-12 h-12 rounded border border-dashed flex items-center justify-center bg-muted/50 shrink-0">
                      <ImagePlus className="h-5 w-5 text-muted-foreground" />
                    </div>
                  )}
                  <div className="flex-1">
                    <Input
                      type="file"
                      accept="image/*"
                      onChange={handleBaseImageUpload}
                      disabled={isUploadingBaseImage}
                      className="text-xs"
                    />
                    {isUploadingBaseImage && (
                      <p className="text-xs text-muted-foreground mt-1">Uploading...</p>
                    )}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  AI will use this image as a visual foundation alongside the customer's prompt and reference image
                </p>
              </div>

              {/* ── Sub-styles section ──────────────────────────────────────── */}
              <div className="border rounded-md p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">Sub-Style Options</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Let customers pick a variation (e.g. King, Queen, Ramen Bowl)
                    </p>
                  </div>
                  <Switch
                    checked={subStylesEnabled}
                    onCheckedChange={setSubStylesEnabled}
                    data-testid="toggle-substyles"
                  />
                </div>

                {subStylesEnabled && (
                  <div className="space-y-3 pt-3 border-t">
                    {/* Label + required */}
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs">Section Label</Label>
                        <Input
                          value={subStyleLabel}
                          onChange={(e) => setSubStyleLabel(e.target.value)}
                          placeholder="e.g. Portrait Style"
                          className="h-8 text-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Selection Required?</Label>
                        <div className="flex items-center gap-2 h-8">
                          <Switch
                            checked={subStyleRequired}
                            onCheckedChange={setSubStyleRequired}
                          />
                          <span className="text-xs text-muted-foreground">
                            {subStyleRequired ? "Yes" : "No"}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Choice list */}
                    <div className="space-y-2">
                      <Label className="text-xs">Choices</Label>
                      {subStyleChoices.length === 0 && (
                        <p className="text-xs text-muted-foreground italic">
                          No choices yet — add one below
                        </p>
                      )}
                      {subStyleChoices.map((choice, idx) => (
                        <div
                          key={choice.id}
                          className="border rounded-md p-3 space-y-2 bg-muted/30"
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-medium text-muted-foreground">
                              {choice.name ? choice.name : `Choice ${idx + 1}`}
                            </span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              onClick={() => removeSubStyleChoice(idx)}
                            >
                              <Trash2 className="h-3 w-3 text-destructive" />
                            </Button>
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <div className="space-y-1">
                              <Label className="text-xs">Display Name</Label>
                              <Input
                                value={choice.name}
                                onChange={(e) =>
                                  updateSubStyleChoice(idx, "name", e.target.value)
                                }
                                placeholder="e.g. King"
                                className="h-8 text-sm"
                              />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">Button ID (no spaces)</Label>
                              <Input
                                value={choice.id}
                                onChange={(e) =>
                                  updateSubStyleChoice(
                                    idx,
                                    "id",
                                    e.target.value.toLowerCase().replace(/\s+/g, "-")
                                  )
                                }
                                placeholder="e.g. king"
                                className="h-8 text-sm"
                              />
                            </div>
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">
                              Prompt Fragment (added to AI prompt when selected)
                            </Label>
                            <Textarea
                              value={choice.promptFragment}
                              onChange={(e) =>
                                updateSubStyleChoice(idx, "promptFragment", e.target.value)
                              }
                              placeholder="e.g. dressed as a majestic king with crown and royal robes"
                              rows={2}
                              className="text-sm resize-none"
                            />
                          </div>
                          {/* Per-choice reference image */}
                          <div className="space-y-1">
                            <Label className="text-xs">
                              Style Reference Image{" "}
                              <span className="text-muted-foreground font-normal">(optional)</span>
                            </Label>
                            <div className="flex items-center gap-2">
                              {choice.baseImageUrl ? (
                                <div className="relative shrink-0">
                                  <img
                                    src={choice.baseImageUrl}
                                    alt={choice.name}
                                    className="w-10 h-10 rounded object-cover border"
                                  />
                                  <button
                                    type="button"
                                    onClick={() => updateSubStyleChoice(idx, "baseImageUrl", "")}
                                    className="absolute -top-1 -right-1 w-4 h-4 bg-destructive text-destructive-foreground rounded-full text-xs flex items-center justify-center"
                                  >
                                    <X className="h-2.5 w-2.5" />
                                  </button>
                                </div>
                              ) : (
                                <div className="w-10 h-10 rounded border border-dashed flex items-center justify-center bg-muted/50 shrink-0">
                                  <ImagePlus className="h-4 w-4 text-muted-foreground" />
                                </div>
                              )}
                              <div className="flex-1">
                                <Input
                                  type="file"
                                  accept="image/*"
                                  onChange={(e) => handleChoiceImageUpload(idx, e)}
                                  disabled={uploadingChoiceIdx === idx}
                                  className="text-xs h-8"
                                />
                                {uploadingChoiceIdx === idx && (
                                  <p className="text-xs text-muted-foreground mt-0.5">Uploading...</p>
                                )}
                              </div>
                            </div>
                            <p className="text-xs text-muted-foreground">
                              AI uses this as a visual reference when this sub-style is selected
                            </p>
                          </div>
                        </div>
                      ))}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="w-full"
                        onClick={addSubStyleChoice}
                      >
                        <Plus className="h-3.5 w-3.5 mr-1.5" />
                        Add Choice
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Fixed footer */}
            <div className="px-6 py-4 border-t shrink-0 flex justify-end gap-2 bg-background">
              <Button variant="outline" onClick={() => setStyleDialogOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleSaveStyle}
                disabled={
                  !styleName ||
                  createStyleMutation.isPending ||
                  updateStyleMutation.isPending
                }
                data-testid="button-save-style"
              >
                {editingStyle ? "Update" : "Create"} Style
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </AdminLayout>
  );
}
