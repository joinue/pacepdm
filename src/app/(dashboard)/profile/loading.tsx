import { PageContainer } from "@/components/ui/page-container";
import { PageHeaderSkeleton, FormSkeleton } from "@/components/ui/page-skeleton";

export default function ProfileLoading() {
  return (
    <PageContainer width="narrow">
      <PageHeaderSkeleton />
      <FormSkeleton fields={4} />
    </PageContainer>
  );
}
