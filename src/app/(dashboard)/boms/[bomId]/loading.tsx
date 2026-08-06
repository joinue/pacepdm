import { MasterDetailSkeleton } from "@/components/ui/page-skeleton";

/** BOM tree on the left, the selected BOM's items table on the right. */
export default function BomDetailLoading() {
  return <MasterDetailSkeleton listWidth="narrow" detailColumns={6} />;
}
