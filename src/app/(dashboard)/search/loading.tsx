import { PageContainer } from "@/components/ui/page-container";
import {
  PageHeaderSkeleton,
  ToolbarSkeleton,
  ListRowsSkeleton,
} from "@/components/ui/page-skeleton";

export default function SearchLoading() {
  return (
    <PageContainer>
      <PageHeaderSkeleton actions={false} />
      <ToolbarSkeleton />
      <ListRowsSkeleton rows={6} />
    </PageContainer>
  );
}
