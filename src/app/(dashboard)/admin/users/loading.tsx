import { ListPageSkeleton } from "@/components/ui/page-skeleton";

export default function AdminUsersLoading() {
  return <ListPageSkeleton rows={8} columns={5} toolbar={false} />;
}
