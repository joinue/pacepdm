"use client";

// In-browser CAD viewer.
//
// Handles two families of neutral CAD files:
//   - STL / OBJ  → parsed with three.js's built-in loaders (no WASM)
//   - STEP / STP / IGES / IGS → parsed with occt-import-js, a WASM port
//     of OpenCascade. The module is ~5 MB and is dynamic-imported so
//     the main app bundle doesn't pay for it. The .wasm binary is
//     copied to public/occt/ by scripts/copy-occt-wasm.mjs at install
//     time; the viewer's `locateFile` hook points occt at that URL.
//
// Rendering: a minimal three.js scene with ambient + two directional
// lights and OrbitControls. The camera auto-fits to the model's
// bounding box so engineers don't have to hunt for their geometry.
// Everything is torn down in the cleanup effect to keep WebGL contexts
// from leaking when the user navigates between files in the vault.
//
// Deliberately NOT a professional CAD viewer — no assembly tree,
// measuring, sectioning, or materials beyond a single grey phong.
// It's a "can I see what's inside the file?" answer, not a CAM tool.

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Loader2, AlertTriangle } from "lucide-react";


// Loose typing for occt-import-js's dynamic module — the package
// ships no .d.ts, so we keep the surface we use to a minimum and
// describe it inline.
type OcctMesh = {
  attributes: {
    position: { array: number[] };
    normal?: { array: number[] };
  };
  index: { array: number[] };
};
type OcctReadResult = {
  success: boolean;
  meshes: OcctMesh[];
};
type OcctModule = {
  ReadStepFile?: (input: Uint8Array, params: unknown) => OcctReadResult;
  ReadIgesFile?: (input: Uint8Array, params: unknown) => OcctReadResult;
};

interface CadViewerProps {
  url: string;
  fileType: string;
  className?: string;
  /**
   * When set, enables opportunistic thumbnail capture after the first
   * successful render. The captured PNG is POSTed to
   * /api/files/[fileId]/thumbnail/set so the vault list picks it up
   * next time someone opens the folder. Pass the file id through so
   * the viewer knows where to send it, and pair with `autoCaptureThumbnail`
   * so the capture only fires for files that don't already have one.
   */
  fileId?: string;
  autoCaptureThumbnail?: boolean;
  /** Called after the first successful render (whether or not a thumbnail was captured). */
  onRendered?: () => void;
  /** Called after a successful thumbnail capture+upload, so the parent can refresh. */
  onThumbnailCaptured?: () => void;
}

export function CadViewer({
  url,
  fileType,
  className,
  fileId,
  autoCaptureThumbnail = false,
  onRendered,
  onThumbnailCaptured,
}: CadViewerProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    // Capture the ref into a const so the narrowing survives every
    // `await` in the async `run()` below — TS widens `mountRef.current`
    // back to nullable across async boundaries otherwise.
    const mount = mountRef.current;
    if (!mount) return;
    const mountEl: HTMLDivElement = mount;
    const ext = fileType.toLowerCase();

    // Flag to suppress setState when the effect has already cleaned up
    // — fetches and dynamic imports are async, so the component may
    // unmount before they resolve.
    let cancelled = false;

    // three.js handles we'll need to dispose in cleanup.
    let renderer: THREE.WebGLRenderer | null = null;
    let controls: OrbitControls | null = null;
    let scene: THREE.Scene | null = null;
    let frameId = 0;
    let resizeObserver: ResizeObserver | null = null;
    const disposables: { dispose: () => void }[] = [];

    async function run() {
      try {
        setStatus("loading");
        setErrorMessage(null);

        // Step 1: fetch the file. Signed URL from the preview endpoint.
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Failed to download file (${res.status})`);
        const buffer = await res.arrayBuffer();
        if (cancelled) return;

        // Step 2: parse into a three.js Object3D depending on format.
        let object: THREE.Object3D;
        if (ext === "stl") {
          object = parseStl(buffer);
        } else if (ext === "obj") {
          object = parseObj(buffer);
        } else if (["step", "stp", "iges", "igs"].includes(ext)) {
          object = await parseOcct(buffer, ext);
        } else {
          throw new Error(`Unsupported CAD format: .${ext}`);
        }
        if (cancelled) return;

        // Step 3: set up the scene and render. Done AFTER parsing so
        // failed parses don't leak a renderer that the UI never uses.
        const width = mountEl.clientWidth || 640;
        const height = mountEl.clientHeight || 480;
        scene = new THREE.Scene();
        scene.background = new THREE.Color(0xf5f5f5);

        // Lighting: ambient for base fill, two directionals for
        // shading that makes geometry readable from any angle.
        scene.add(new THREE.AmbientLight(0xffffff, 0.6));
        const key = new THREE.DirectionalLight(0xffffff, 0.8);
        key.position.set(5, 10, 7);
        scene.add(key);
        const fill = new THREE.DirectionalLight(0xffffff, 0.4);
        fill.position.set(-5, -2, -5);
        scene.add(fill);

        scene.add(object);

        // Compute a bounding box so the camera can be framed to the
        // model. This is what makes "opens a file and can see it"
        // actually work — without the fit step the model either
        // clips or disappears at default zoom.
        const bbox = new THREE.Box3().setFromObject(object);
        const size = bbox.getSize(new THREE.Vector3());
        const center = bbox.getCenter(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 1;

        const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, maxDim * 100);
        // Pull back by 2× the largest dimension so the whole bbox fits
        // in view with some padding. fov=45deg means the diagonal
        // subtends roughly half the viewport.
        camera.position.copy(center).add(new THREE.Vector3(maxDim, maxDim, maxDim * 1.8));
        camera.lookAt(center);
        camera.near = Math.max(maxDim * 0.01, 0.01);
        camera.far = maxDim * 100;
        camera.updateProjectionMatrix();

        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(width, height);
        mountEl.appendChild(renderer.domElement);

        controls = new OrbitControls(camera, renderer.domElement);
        controls.target.copy(center);
        controls.enableDamping = true;
        controls.dampingFactor = 0.1;
        controls.update();

        // Render one frame synchronously before starting the loop so
        // the opportunistic thumbnail capture below sees the
        // auto-framed isometric view instead of a blank black canvas.
        renderer.render(scene, camera);

        // Fire-and-forget thumbnail capture for CAD files that don't
        // already have a thumbnail. The user already paid the parse
        // cost to open the file; capturing a PNG of what they're
        // looking at is essentially free and means the vault list
        // shows the actual geometry next time anyone browses the
        // folder. Rendered at the live canvas size — the server's
        // sharp pipeline caps it at 400px anyway.
        if (autoCaptureThumbnail && fileId) {
          renderer.domElement.toBlob(
            (blob) => {
              if (!blob || cancelled) return;
              const form = new FormData();
              form.append("image", new File([blob], `${fileId}-thumbnail.png`, { type: "image/png" }));
              fetch(`/api/files/${fileId}/thumbnail/set`, {
                method: "POST",
                body: form,
              })
                .then((res) => {
                  if (!cancelled && res.ok) onThumbnailCaptured?.();
                })
                .catch((err) => {
                  // Non-fatal: the user can still see the model in
                  // the viewer, they just won't get a list thumbnail
                  // this round.
                  console.warn("[CadViewer] thumbnail auto-capture failed:", err);
                });
            },
            "image/png"
          );
        }

        onRendered?.();

        const loop = () => {
          if (cancelled) return;
          controls?.update();
          renderer?.render(scene!, camera);
          frameId = requestAnimationFrame(loop);
        };
        loop();

        // Keep the viewport sized to the container. ResizeObserver
        // handles detail-panel resizing without a window-wide listener.
        resizeObserver = new ResizeObserver(() => {
          if (!renderer) return;
          const w = mountEl.clientWidth || 640;
          const h = mountEl.clientHeight || 480;
          renderer.setSize(w, h);
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
        });
        resizeObserver.observe(mountEl);

        // Collect geometries/materials for dispose-on-unmount. We walk
        // the parsed object since the loaders don't hand us a flat
        // list.
        object.traverse((obj) => {
          const maybeMesh = obj as THREE.Mesh;
          if (maybeMesh.geometry) disposables.push(maybeMesh.geometry);
          const mat = maybeMesh.material;
          if (Array.isArray(mat)) for (const m of mat) disposables.push(m);
          else if (mat) disposables.push(mat);
        });

        if (!cancelled) setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        console.error("[CadViewer] failed to render:", err);
        setErrorMessage(err instanceof Error ? err.message : "Unknown error");
        setStatus("error");
      }
    }

    void run();

    return () => {
      cancelled = true;
      if (frameId) cancelAnimationFrame(frameId);
      if (resizeObserver) resizeObserver.disconnect();
      if (controls) controls.dispose();
      for (const d of disposables) {
        try {
          d.dispose();
        } catch {
          /* ignore dispose errors */
        }
      }
      if (renderer) {
        renderer.dispose();
        renderer.domElement.remove();
      }
      // Null out references so the GC can reclaim the scene graph.
      scene = null;
      renderer = null;
      controls = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fileId, autoCaptureThumbnail, onRendered, onThumbnailCaptured omitted: adding them would re-init the 3D scene on every render
  }, [url, fileType]);

  return (
    <div
      className={`relative rounded-lg border bg-background overflow-hidden ${className ?? ""}`}
      style={{ minHeight: 400 }}
    >
      <div ref={mountRef} className="absolute inset-0" />
      {status === "loading" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/80">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          <p className="text-xs text-muted-foreground">Loading 3D model…</p>
        </div>
      )}
      {status === "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/80 p-4 text-center">
          <AlertTriangle className="w-5 h-5 text-destructive" />
          <p className="text-sm font-medium">Couldn&apos;t render this model</p>
          <p className="text-xs text-muted-foreground max-w-sm">
            {errorMessage || "The file could be empty, corrupted, or a format variant the viewer doesn't recognize."}
          </p>
        </div>
      )}
      {status === "ready" && (
        // Tiny help hint in the corner so users know the mouse
        // controls before they start flailing.
        <div className="absolute bottom-2 right-2 text-[10px] text-muted-foreground/70 bg-background/80 rounded px-2 py-0.5 pointer-events-none">
          drag: rotate &middot; scroll: zoom &middot; right-drag: pan
        </div>
      )}
    </div>
  );
}

// ─── Parsers ─────────────────────────────────────────────────────────

function parseStl(buffer: ArrayBuffer): THREE.Object3D {
  const geometry = new STLLoader().parse(buffer);
  geometry.computeBoundingBox();
  geometry.computeVertexNormals();
  const material = new THREE.MeshPhongMaterial({
    color: 0x9aa0a6,
    specular: 0x222222,
    shininess: 30,
    flatShading: false,
  });
  return new THREE.Mesh(geometry, material);
}

function parseObj(buffer: ArrayBuffer): THREE.Object3D {
  const text = new TextDecoder().decode(buffer);
  const group = new OBJLoader().parse(text);
  // OBJ loader leaves meshes with whatever materials the file
  // referenced — often none in raw engineering dumps. Assign the same
  // neutral phong so rendering is consistent with the STL branch.
  const material = new THREE.MeshPhongMaterial({
    color: 0x9aa0a6,
    specular: 0x222222,
    shininess: 30,
    flatShading: false,
  });
  group.traverse((obj) => {
    const maybeMesh = obj as THREE.Mesh;
    if (maybeMesh.isMesh) maybeMesh.material = material;
  });
  return group;
}

async function parseOcct(buffer: ArrayBuffer, ext: string): Promise<THREE.Object3D> {
  // Dynamic import keeps the 5 MB WASM module out of the main client
  // bundle. Only fires when the user opens a STEP/IGES file.
  const occtImport = (await import("occt-import-js")).default;
  // occt-import-js is an Emscripten module; call the factory with a
  // locateFile override pointing at the public/ copy of the .wasm so
  // the browser can find it at a stable URL instead of Next.js's
  // hashed asset path.
  const occt = (await occtImport({
    locateFile: (path: string) => {
      if (path.endsWith(".wasm")) return "/occt/occt-import-js.wasm";
      return path;
    },
  })) as OcctModule;

  const input = new Uint8Array(buffer);
  const isStep = ext === "step" || ext === "stp";
  const result = isStep
    ? occt.ReadStepFile?.(input, null)
    : occt.ReadIgesFile?.(input, null);

  if (!result || !result.success) {
    throw new Error(
      `occt-import-js couldn't parse this ${ext.toUpperCase()} file — the model may use unsupported entities.`
    );
  }
  if (!result.meshes || result.meshes.length === 0) {
    throw new Error("File parsed, but contained no renderable meshes.");
  }

  // Each mesh from occt is already triangulated. Convert to
  // three.js BufferGeometry and group them together.
  const group = new THREE.Group();
  const material = new THREE.MeshPhongMaterial({
    color: 0x9aa0a6,
    specular: 0x222222,
    shininess: 30,
    flatShading: false,
    side: THREE.DoubleSide,
  });

  for (const mesh of result.meshes) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(mesh.attributes.position.array), 3)
    );
    if (mesh.attributes.normal?.array) {
      geometry.setAttribute(
        "normal",
        new THREE.BufferAttribute(new Float32Array(mesh.attributes.normal.array), 3)
      );
    } else {
      geometry.computeVertexNormals();
    }
    geometry.setIndex(
      new THREE.BufferAttribute(new Uint32Array(mesh.index.array), 1)
    );
    group.add(new THREE.Mesh(geometry, material));
  }
  return group;
}
