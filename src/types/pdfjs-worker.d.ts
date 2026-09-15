// pdfjs-dist ships types for its main build but none for the worker module.
// src/lib/thumbnail.ts imports it only to hand it to pdf.js through
// `globalThis.pdfjsWorker`, and never touches its API, so the surface stays
// opaque on purpose.

declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
