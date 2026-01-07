import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Palette, Plus, Trash2, Edit2 } from "lucide-react";
import AdminLayout from "@/components/admin-layout";
import type { StylePresetDB } from "@shared/schema";

export default function AdminStyles() {
  const { toast } = useToast();
  
  const [styleDialogOpen, setStyleDialogOpen] = useState(false);
  const [editingStyle, setEditingStyle] = useState<StylePresetDB | null>(null);
  const [styleName, setStyleName] = useState("");
  const [stylePrompt, setStylePrompt] = useState("");

  const { data: styles, isLoading: stylesLoading } = useQuery<StylePresetDB[]>({
    queryKey: ["/api/admin/styles"],
  });

  const createStyleMutation = useMutation({
    mutationFn: async (data: { name: string; promptPrefix: string }) => {
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
    mutationFn: async ({ id, ...data }: { id: number; name: string; promptPrefix: string }) => {
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

  const deleteStyleMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/admin/styles/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/styles"] });
      toast({ title: "Style deleted" });
    },
  });

  const resetStyleForm = () => {
    setEditingStyle(null);
    setStyleName("");
    setStylePrompt("");
  };

  const handleEditStyle = (style: StylePresetDB) => {
    setEditingStyle(style);
    setStyleName(style.name);
    setStylePrompt(style.promptPrefix);
    setStyleDialogOpen(true);
  };

  const handleSaveStyle = () => {
    if (editingStyle) {
      updateStyleMutation.mutate({ id: editingStyle.id, name: styleName, promptPrefix: stylePrompt });
    } else {
      createStyleMutation.mutate({ name: styleName, promptPrefix: stylePrompt });
    }
  };

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold" data-testid="text-styles-title">Styles</h1>
            <p className="text-muted-foreground">Create custom art styles for your customers</p>
          </div>
          <Button onClick={() => { resetStyleForm(); setStyleDialogOpen(true); }} data-testid="button-add-style">
            <Plus className="h-4 w-4 mr-2" />
            Add Style
          </Button>
        </div>

        {stylesLoading ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-32" />
            ))}
          </div>
        ) : styles && styles.length > 0 ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {styles.map((style) => (
              <Card key={style.id} data-testid={`card-style-${style.id}`}>
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-base">{style.name}</CardTitle>
                    <Badge variant={style.isActive ? "default" : "secondary"} className="text-xs">
                      {style.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground line-clamp-2 mb-4">
                    {style.promptPrefix || "No prompt prefix"}
                  </p>
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
                      onClick={() => deleteStyleMutation.mutate(style.id)}
                      data-testid={`button-delete-style-${style.id}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <Card>
            <CardContent className="py-12 text-center">
              <Palette className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="font-medium mb-2">No custom styles yet</h3>
              <p className="text-sm text-muted-foreground mb-4">
                Create custom art styles for your customers
              </p>
              <Button onClick={() => { resetStyleForm(); setStyleDialogOpen(true); }}>
                <Plus className="h-4 w-4 mr-2" />
                Add Style
              </Button>
            </CardContent>
          </Card>
        )}

        <Dialog open={styleDialogOpen} onOpenChange={setStyleDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editingStyle ? "Edit Style" : "Add New Style"}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
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
              <div className="space-y-2">
                <Label htmlFor="style-prompt">Prompt Prefix</Label>
                <Textarea
                  id="style-prompt"
                  value={stylePrompt}
                  onChange={(e) => setStylePrompt(e.target.value)}
                  placeholder="A beautiful watercolor painting of..."
                  rows={4}
                  data-testid="input-style-prompt"
                />
                <p className="text-xs text-muted-foreground">
                  This text will be prepended to the customer's prompt
                </p>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setStyleDialogOpen(false)}>
                  Cancel
                </Button>
                <Button 
                  onClick={handleSaveStyle}
                  disabled={!styleName || createStyleMutation.isPending || updateStyleMutation.isPending}
                  data-testid="button-save-style"
                >
                  {editingStyle ? "Update" : "Create"} Style
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </AdminLayout>
  );
}
