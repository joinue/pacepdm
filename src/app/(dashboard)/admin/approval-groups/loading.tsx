import { PageContainer } from "@/components/ui/page-container";
import { PageHeaderSkeleton, ListRowsSkeleton } from "@/components/ui/page-skeleton";

export default function AdminApprovalGroupsLoading() {
  return (
    <PageContainer>
      <PageHeaderSkeleton actions />
      <ListRowsSkeleton rows={5} />
    </PageContainer>
  );
}
