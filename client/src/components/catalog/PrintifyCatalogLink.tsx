import { ExternalLink } from "lucide-react";
import { printifyCatalogProductUrl } from "@shared/printifyCatalogUrl";
import { cn } from "@/lib/utils";

type Props = {
  blueprintId: number;
  title: string;
  providerTitle?: string | null;
  className?: string;
  compact?: boolean;
};

export default function PrintifyCatalogLink({
  blueprintId,
  title,
  providerTitle,
  className,
  compact,
}: Props) {
  const href = printifyCatalogProductUrl({
    blueprintId,
    productTitle: title,
    providerTitle,
  });

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title="Open on Printify (supplier details, specs, providers)"
      className={cn(
        "inline-flex items-center gap-1 text-xs text-primary hover:underline",
        className,
      )}
      onClick={(e) => e.stopPropagation()}
    >
      <ExternalLink className="h-3 w-3 shrink-0" />
      {!compact && "Printify"}
    </a>
  );
}
