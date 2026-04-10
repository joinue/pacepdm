import { EcosView } from "./ecos-view";

/**
 * /ecos — ECO list page, no selection. The actual view lives in
 * `EcosView`, which is shared with the `[ecoId]/page.tsx` dynamic route.
 * Clicking an ECO in the sidebar navigates to `/ecos/[id]` so each ECO
 * has its own shareable URL.
 */
export default function EcosListPage() {
  return <EcosView selectedEcoId={null} />;
}
