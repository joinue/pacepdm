import { EcosView } from "../ecos-view";

/**
 * /ecos/[ecoId] — ECO detail page. Same list+detail view as `/ecos`,
 * with the route parameter as the initially-selected ECO. `params` is a
 * Promise in Next 16 App Router, so we await it before passing down.
 */
export default async function EcoDetailPage({
  params,
}: {
  params: Promise<{ ecoId: string }>;
}) {
  const { ecoId } = await params;
  return <EcosView selectedEcoId={ecoId} />;
}
