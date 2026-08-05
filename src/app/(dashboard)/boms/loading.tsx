import { PageContainer } from "@/components/ui/page-container";
import { PageHeaderSkeleton, ListRowsSkeleton } from "@/components/ui/page-skeleton";

/** BOMs render as a grouped list, not a table — no toolbar row. */
export default function BomsLoading() {
  return (
    <PageContainer>
      <PageHeaderSkeleton description={false} actions />
      <ListRowsSkeleton rows={8} />
    </PageContainer>
  );
}
