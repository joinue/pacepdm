import { redirect } from "next/navigation";
import { BomsView } from "./boms-view";

/**
 * /boms — BOM list page, no selection. The actual view lives in
 * `BomsView`, which is shared with the `[bomId]/page.tsx` dynamic route.
 * When the user picks a BOM from the sidebar, that component navigates
 * to `/boms/[id]` so each BOM has its own shareable URL.
 *
 * `?bomId=<id>` is an older link shape. Global search and the search page
 * linked with it while this page ignored it, so those links opened the list
 * instead of the BOM. Every link now goes to `/boms/<id>`; one already stored
 * or bookmarked is sent there.
 */
export default async function BomsListPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { bomId } = await searchParams;
  if (typeof bomId === "string" && bomId) {
    redirect(`/boms/${encodeURIComponent(bomId)}`);
  }
  return <BomsView selectedBomId={null} />;
}
