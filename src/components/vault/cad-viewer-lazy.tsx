"use client";

import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";

/**
 * Lazy entry point for the CAD viewer. Import this, not `./cad-viewer`.
 *
 * `cad-viewer` statically imports all of three.js (~150 KB gzipped) and is
 * reachable from the file detail panel, which the vault browser renders
 * eagerly. Importing it directly pulled the entire WebGL renderer into the
 * vault page bundle, so every user downloaded it on first load whether or
 * not they ever opened a STEP file. Splitting it out defers that cost to the
 * first CAD preview.
 *
 * `ssr: false` because the viewer needs a real canvas and WebGL context —
 * there is nothing meaningful to prerender on the server.
 */
export const CadViewer = dynamic(() => import("./cad-viewer").then((m) => m.CadViewer), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center w-full min-h-64 text-muted-foreground">
      <Loader2 className="w-5 h-5 animate-spin" />
      <span className="ml-2 text-sm">Loading 3D viewer…</span>
    </div>
  ),
});
