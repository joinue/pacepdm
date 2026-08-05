import { ListPageSkeleton } from "@/components/ui/page-skeleton";

export default function AdminMetadataLoading() {
  return <ListPageSkeleton rows={6} columns={4} toolbar={false} />;
}
