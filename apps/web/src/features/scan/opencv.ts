// Readies an OpenCV.js runtime. The Emscripten module object is also a thenable whose `then` never settles, so `await`ing it or `import`ing it hangs (the namespace re-exports `then`). Callers load the script themselves and pass the module object here.

export type OpenCv = typeof import("@techstark/opencv-js");

type LoadingModule = Partial<OpenCv> & {
  onRuntimeInitialized?: () => void;
  then?: unknown;
};

/** Resolves once the WASM runtime is up, with `then` removed so the module can pass through promises. */
export function whenOpenCvReady(module: unknown): Promise<OpenCv> {
  const cv = module as LoadingModule;
  return new Promise((resolve) => {
    const finish = (): void => {
      delete cv.then;
      resolve(cv as OpenCv);
    };
    if (typeof cv.Mat === "function") finish();
    else cv.onRuntimeInitialized = finish;
  });
}
