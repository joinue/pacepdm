import { PageContainer } from "@/components/ui/page-container";
import { PageHeaderSkeleton, FormSkeleton } from "@/components/ui/page-skeleton";

export default function AdminSsoLoading() {
  return (
    <PageContainer width="medium">
      <PageHeaderSkeleton />
      <FormSkeleton fields={4} />
    </PageContainer>
  );
}
