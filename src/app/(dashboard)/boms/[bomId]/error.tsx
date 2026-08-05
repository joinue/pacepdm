"use client";

import { RouteError } from "@/components/ui/route-error";

export default function BomDetailError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <RouteError
      error={error}
      retry={retry}
      title="Couldn't load this BOM"
      description="The BOM could not be fetched. It may have been deleted, or the request failed."
    />
  );
}
