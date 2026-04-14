import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    // Static asset bypass — middleware never runs for these, so they serve
    // without touching auth. `.wasm` is excluded because the CAD viewer's
    // OCCT module is served from /occt/*.wasm and unauthenticated share
    // viewers would otherwise get the /login HTML redirect instead of the
    // binary, which the browser then tries to compile as WebAssembly.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|webmanifest|ico|wasm)$).*)",
  ],
};
