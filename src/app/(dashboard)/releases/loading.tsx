import { PageContainer } from "@/components/ui/page-container";
import { PageHeaderSkeleton, ListRowsSkeleton } from "@/components/ui/page-skeleton";

/** Releases render as a flat list with a search field in the header slot. */
export default function ReleasesLoading() {
  return (
    <PageContainer>
      <PageHeaderSkeleton actions />
      <ListRowsSkeleton rows={6} />
    </PageContainer>
  );
}
