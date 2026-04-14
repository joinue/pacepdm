import type { Metadata } from "next";
import { ShareViewerClient } from "./share-viewer-client";

// Belt-and-suspenders noindex: the API responses already set
// X-Robots-Tag, but some crawlers only honor meta tags in the HTML doc.
// Shared content is never intended for search engines.
export const metadata: Metadata = {
  title: "Shared — PACE PDM",
  robots: { index: false, follow: false },
};

export default async function SharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <ShareViewerClient token={token} />;
}
