import http from "node:http";

const SOCKET_PATH = "/run/aurora-python/runner.sock";
const MAX_CODE_CHARS = 16_000;
// The runner caps its JSON envelope at 100 KB; escaped Unicode/control bytes expand here.
const MAX_RESPONSE_BYTES = 100_000;

export type PythonResult = { success: boolean; output: string };

/** Run bounded Python source through the local Unix-socket runner. */
export function runPython(
  code: string,
  signal?: AbortSignal,
): Promise<PythonResult> {
  if (code.length > MAX_CODE_CHARS) {
    return Promise.resolve({
      success: false,
      output: "Python code exceeds 16000 characters",
    });
  }
  if (signal?.aborted) return Promise.reject(abortError());

  const body = JSON.stringify({ code });
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      fn();
    };
    const abort = () => request.destroy(abortError());
    const request = http.request({
      socketPath: SOCKET_PATH,
      path: "/run",
      method: "POST",
      agent: false,
      timeout: 5_000,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        connection: "close",
      },
    });
    signal?.addEventListener("abort", abort, { once: true });

    request.once("timeout", () =>
      request.destroy(new Error("Python execution runtime timed out")),
    );
    request.once("error", (error: NodeJS.ErrnoException) => {
      settle(() => {
        if (signal?.aborted) return reject(abortError());
        if (["ENOENT", "ECONNREFUSED", "EACCES"].includes(error.code ?? "")) {
          return reject(
            new Error(
              "Python execution runtime is unavailable; start the compose python service.",
            ),
          );
        }
        reject(error);
      });
    });
    request.once("response", (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          response.destroy(new Error("Python runner response exceeded its limit"));
          return;
        }
        chunks.push(chunk);
      });
      response.once("error", (error) => settle(() => reject(error)));
      response.once("end", () =>
        settle(() => {
          try {
            const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (
              !result ||
              typeof result !== "object" ||
              typeof (result as PythonResult).success !== "boolean" ||
              typeof (result as PythonResult).output !== "string"
            ) {
              throw new Error("Invalid response from Python runner");
            }
            resolve(result as PythonResult);
          } catch (error) {
            reject(error);
          }
        }),
      );
    });
    request.end(body);
  });
}

/** Construct the common cancellation error returned to AI callers. */
function abortError(): Error {
  const error = new Error("Python execution cancelled");
  error.name = "AbortError";
  return error;
}
