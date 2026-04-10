import { BomsView } from "../boms-view";

/**
 * /boms/[bomId] — BOM detail page. Renders the same list+detail view as
 * `/boms`, but with the route parameter as the initially-selected BOM.
 * `params` is a Promise in Next 16 App Router, so we await before passing
 * the id down to the client view.
 */
export default async function BomDetailPage({
  params,
}: {
  params: Promise<{ bomId: string }>;
}) {
  const { bomId } = await params;
  return <BomsView selectedBomId={bomId} />;
}
