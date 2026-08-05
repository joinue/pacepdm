import { PageContainer } from "@/components/ui/page-container";
import { PageHeaderSkeleton, ListRowsSkeleton } from "@/components/ui/page-skeleton";

export default function EcosLoading() {
  return (
    <PageContainer>
      <PageHeaderSkeleton description={false} actions />
      <ListRowsSkeleton rows={8} />
    </PageContainer>
  );
}
