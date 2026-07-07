import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useHoodieMapperStore } from "./store";

/** Global confirm-before-delete for mask layers (driven by store prompt state). */
export default function DeleteLayerConfirmDialog() {
  const prompt = useHoodieMapperStore((s) => s.layerDeletePrompt);
  const actions = useHoodieMapperStore((s) => s.actions);

  return (
    <AlertDialog
      open={prompt != null}
      onOpenChange={(open) => {
        if (!open) actions.cancelRemoveLayer();
      }}
    >
      <AlertDialogContent className="bg-slate-900 text-slate-100">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete layer?</AlertDialogTitle>
          <AlertDialogDescription className="text-slate-400">
            {prompt
              ? `Delete "${prompt.name}"? Its mask path and mesh will be removed. You can undo with Ctrl+Z after confirming.`
              : ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="border-slate-700 bg-slate-950 text-slate-200 hover:bg-slate-800">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            className="bg-red-600 text-white hover:bg-red-500"
            onClick={() => actions.confirmRemoveLayer()}
            data-testid="confirm-delete-layer"
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
