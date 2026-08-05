"use client";

import { useEffect } from "react";

/**
 * Last resort: a throw in the **root layout** itself, which happens before any
 * segment `error.tsx` can catch it. It replaces the whole document, so it has
 * to render its own `<html>` and `<body>` and cannot rely on the app's
 * providers, fonts, or token stylesheet being available — hence the inline
 * styles, which are deliberate rather than a token-lint oversight.
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error("[global error]", error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          display: "flex",
          minHeight: "100vh",
          alignItems: "center",
          justifyContent: "center",
          margin: 0,
          padding: "2rem",
        }}
      >
        <div style={{ maxWidth: "28rem", textAlign: "center" }}>
          <h1 style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: "0.5rem" }}>
            PACE PDM could not start
          </h1>
          <p style={{ fontSize: "0.875rem", opacity: 0.7, marginBottom: "1.5rem" }}>
            Something failed before the app could render. Reloading usually clears it.
          </p>
          <button
            onClick={retry}
            style={{
              fontSize: "0.875rem",
              padding: "0.5rem 1rem",
              borderRadius: "0.375rem",
              border: "1px solid currentColor",
              background: "transparent",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
          {error.digest && (
            <p style={{ fontSize: "0.75rem", opacity: 0.5, marginTop: "1rem" }}>
              Reference: <code>{error.digest}</code>
            </p>
          )}
        </div>
      </body>
    </html>
  );
}
