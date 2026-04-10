import { BomsView } from "./boms-view";

/**
 * /boms — BOM list page, no selection. The actual view lives in
 * `BomsView`, which is shared with the `[bomId]/page.tsx` dynamic route.
 * When the user picks a BOM from the sidebar, that component navigates
 * to `/boms/[id]` so each BOM has its own shareable URL.
 */
export default function BomsListPage() {
  return <BomsView selectedBomId={null} />;
}
