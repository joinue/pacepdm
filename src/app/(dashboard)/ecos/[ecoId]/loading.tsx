import { MasterDetailSkeleton } from "@/components/ui/page-skeleton";

/** ECO list on the left, the selected ECO's tabbed detail on the right. */
export default function EcoDetailLoading() {
  return <MasterDetailSkeleton listWidth="wide" detailColumns={4} />;
}
