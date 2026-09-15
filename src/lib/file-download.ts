import { fetchJson } from "@/lib/api-client";

/**
 * Download a vault file, or one of its versions, under its real name.
 *
 * The route answers with a short-lived signed storage URL carrying
 * `Content-Disposition: attachment` and the file's name, so navigating to it
 * saves the file without leaving the page. The call sites this replaces opened
 * the URL in a new tab after an await — which Safari blocks as a popup — and
 * two of them never looked at the response status, so a 403 did nothing.
 *
 * Throws with the server's message; callers show it with `errorMessage`.
 */
export async function downloadVaultFile(fileId: string, version?: number): Promise<void> {
  const qs = version ? `?version=${version}` : "";
  const { url } = await fetchJson<{ url?: string }>(`/api/files/${fileId}/download${qs}`);
  if (!url) throw new Error("The server did not return a download link");
  window.location.assign(url);
}
