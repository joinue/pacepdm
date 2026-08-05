import { PageContainer } from "@/components/ui/page-container";
import { PageHeaderSkeleton, ListRowsSkeleton } from "@/components/ui/page-skeleton";

export default function NotificationsLoading() {
  return (
    <PageContainer width="narrow">
      <PageHeaderSkeleton actions />
      <ListRowsSkeleton rows={8} />
    </PageContainer>
  );
}
