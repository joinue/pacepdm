import { redirect } from "next/navigation";
import { EcosView } from "./ecos-view";

/**
 * /ecos — ECO list page, no selection. The actual view lives in
 * `EcosView`, which is shared with the `[ecoId]/page.tsx` dynamic route.
 * Clicking an ECO in the sidebar navigates to `/ecos/[id]` so each ECO
 * has its own shareable URL.
 *
 * `?ecoId=<id>` is an older link shape. Search, where-used, the file panel's
 * "Released by" link and the BOM revision history all linked with it while
 * this page ignored it, so each opened the list instead of the ECO. Every link
 * now goes to `/ecos/<id>`; one already stored or bookmarked is sent there.
 */
export default async function EcosListPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { ecoId } = await searchParams;
  if (typeof ecoId === "string" && ecoId) {
    redirect(`/ecos/${encodeURIComponent(ecoId)}`);
  }
  return <EcosView selectedEcoId={null} />;
}
