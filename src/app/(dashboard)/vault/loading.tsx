import { PageContainer } from "@/components/ui/page-container";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeaderSkeleton, ToolbarSkeleton, TableSkeleton } from "@/components/ui/page-skeleton";

/** Breadcrumb + toolbar + file list — the vault browser's real chrome. */
export default function VaultLoading() {
  return (
    <PageContainer>
      <PageHeaderSkeleton actions />
      <Skeleton className="h-4 w-56" />
      <ToolbarSkeleton />
      <TableSkeleton rows={10} columns={5} />
    </PageContainer>
  );
}
