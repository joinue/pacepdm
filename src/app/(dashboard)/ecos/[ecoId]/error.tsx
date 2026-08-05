"use client";

import { RouteError } from "@/components/ui/route-error";

export default function EcoDetailError({
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
      title="Couldn't load this change order"
      description="The ECO could not be fetched. It may have been deleted, or the request failed."
    />
  );
}
