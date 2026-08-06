import { RecordPageSkeleton } from "@/components/ui/page-skeleton";

/** Releases open from a link, not a list — one column, three manifest sections. */
export default function ReleaseDetailLoading() {
  return <RecordPageSkeleton sections={3} />;
}
