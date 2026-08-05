import { PageContainer } from "@/components/ui/page-container";
import { PageHeaderSkeleton, ListRowsSkeleton } from "@/components/ui/page-skeleton";

export default function AdminWorkflowsLoading() {
  return (
    <PageContainer>
      <PageHeaderSkeleton actions />
      <ListRowsSkeleton rows={5} />
    </PageContainer>
  );
}
