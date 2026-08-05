"use client";

import { RouteError } from "@/components/ui/route-error";

export default function VaultError({
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
      title="Couldn't load the vault"
      description="The file list could not be fetched. Your files are not affected."
    />
  );
}
