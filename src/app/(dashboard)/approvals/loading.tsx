import { PageContainer } from "@/components/ui/page-container";
import { PageHeaderSkeleton, ListRowsSkeleton } from "@/components/ui/page-skeleton";

export default function ApprovalsLoading() {
  return (
    <PageContainer>
      <PageHeaderSkeleton />
      <ListRowsSkeleton rows={6} />
    </PageContainer>
  );
}
