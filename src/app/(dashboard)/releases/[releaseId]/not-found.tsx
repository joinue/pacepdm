import Link from "next/link";
import { FileQuestion } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { PageContainer } from "@/components/ui/page-container";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * `page.tsx` calls `notFound()` when the id resolves to nothing. Without this
 * file that landed on Next's bare 404, outside the dashboard shell — so a
 * mistyped or stale release link dumped the user out of the app entirely.
 */
export default function ReleaseNotFound() {
  return (
    <PageContainer>
      <EmptyState
        icon={FileQuestion}
        title="Release not found"
        description="This release does not exist, or it belongs to another workspace."
        action={
          // `buttonVariants` on the Link rather than a Button wrapping it —
          // this Button primitive has no `asChild`, and nesting an <a> inside
          // a <button> is invalid markup. Same pattern as the share viewer.
          // lint-conventions-allow: list-route-navigation — the record was
          // not found, so there is no record to link to; the index is the
          // only sensible destination.
          <Link href="/ecos" className={buttonVariants({ variant: "outline", size: "sm" })}>
            Back to change orders
          </Link>
        }
      />
    </PageContainer>
  );
}
