import { AlertCircle, Inbox, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

export function LoadingState({
  label = "Loading workspace",
}: {
  label?: string;
}) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-slate-200 bg-slate-50/50 p-8 text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900/30 dark:text-slate-400">
      <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden="true" />
      <p>{label}</p>
    </div>
  );
}

export function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="flex min-h-56 flex-col items-center justify-center rounded-lg border border-dashed border-slate-200 bg-slate-50/50 p-8 text-center dark:border-slate-800 dark:bg-slate-900/30">
      <Inbox className="h-6 w-6 text-slate-400" aria-hidden="true" />
      <h2 className="mt-3 text-sm font-medium text-slate-900 dark:text-slate-100">
        {title}
      </h2>
      <p className="mt-1 max-w-sm text-sm leading-6 text-slate-500 dark:text-slate-400">
        {description}
      </p>
    </div>
  );
}

export function ErrorState({
  title = "Something went wrong",
  description,
  onRetry,
}: {
  title?: string;
  description: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex min-h-56 flex-col items-center justify-center rounded-lg border border-red-200 bg-red-50/50 p-8 text-center dark:border-red-950 dark:bg-red-950/20">
      <AlertCircle
        className="h-6 w-6 text-red-600 dark:text-red-400"
        aria-hidden="true"
      />
      <h2 className="mt-3 text-sm font-medium text-slate-900 dark:text-slate-100">
        {title}
      </h2>
      <p className="mt-1 max-w-sm text-sm leading-6 text-slate-500 dark:text-slate-400">
        {description}
      </p>
      {onRetry ? (
        <Button className="mt-4" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}
