import { ReleasesView } from "./releases-view";

/**
 * /releases — the release list.
 *
 * Releases were previously reachable only from the ECO that produced
 * them, which made the packaged output of a change order findable only
 * by whoever remembered the ECO number. This is the entry point for
 * everyone who does not: sourcing, mainly.
 */
export default function ReleasesListPage() {
  return <ReleasesView />;
}
