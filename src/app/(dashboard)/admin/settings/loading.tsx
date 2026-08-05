import { PageContainer } from "@/components/ui/page-container";
import { PageHeaderSkeleton, FormSkeleton } from "@/components/ui/page-skeleton";

export default function AdminSettingsLoading() {
  return (
    <PageContainer width="medium">
      <PageHeaderSkeleton />
      <FormSkeleton fields={5} />
    </PageContainer>
  );
}
