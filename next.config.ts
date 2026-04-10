import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Packages listed here are treated as CommonJS externals — Next.js does
  // NOT bundle them, and Node.js resolves them at runtime. Required for
  // anything that pulls in platform-specific native bindings:
  //   - @napi-rs/canvas loads ./skia.<os>-<arch>.node via optional deps
  //     (@napi-rs/canvas-win32-x64-msvc etc.), which turbopack can't
  //     resolve. Bundling it breaks PDF thumbnail generation.
  //   - pdfjs-dist ships a ~15 MB legacy build and imports @napi-rs/canvas
  //     transitively in our code path; keeping it external avoids pulling
  //     the native binding into the server bundle via that path too.
  serverExternalPackages: ["@napi-rs/canvas", "pdfjs-dist", "sharp"],
};

export default nextConfig;
