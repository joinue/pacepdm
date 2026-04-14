// Minimum ambient declaration for the occt-import-js package, which
// ships only a plain .js Emscripten module with no types. We keep the
// surface tiny and loose on purpose: the CAD viewer (src/components/
// vault/cad-viewer.tsx) does its own runtime shape-checking before
// reading fields off the returned meshes.
//
// Expand this as we start using more of the API (e.g. IFC or BREP
// reading) rather than pulling in an untrusted @types stub.

declare module "occt-import-js" {
  interface OcctFactoryOptions {
    locateFile?: (path: string) => string;
  }
  const factory: (opts?: OcctFactoryOptions) => Promise<unknown>;
  export default factory;
}
