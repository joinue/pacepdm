import { Skeleton } from "@/components/ui/skeleton";
import { TableSkeleton } from "@/components/ui/page-skeleton";

/**
 * The vault browser's real chrome: the breadcrumb heading (the vault icon and
 * the folder name) with its action buttons, the search and filter row, then
 * the file table. Spaced like `VaultBrowser` (`space-y-4`), not like a
 * `PageContainer`, so nothing moves when the page lands.
 */
export default function VaultLoading() {
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Skeleton className="size-6 rounded" />
          <Skeleton className="h-8 w-40" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-8 w-24" />
        </div>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Skeleton className="h-9 flex-1" />
        <Skeleton className="h-9 w-full sm:w-40" />
      </div>
      <TableSkeleton rows={10} columns={6} />
    </div>
  );
}
