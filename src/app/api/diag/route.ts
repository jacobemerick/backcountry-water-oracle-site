import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";

/**
 * TEMPORARY probe. Answers one question that decides the architecture: can a
 * Next.js Node function on Vercel execute the vendored Python engine at all?
 *
 * Vercel's docs point Python-alongside-Next.js at Services rather than at
 * in-process execution, but they don't say whether a `python3` binary happens
 * to exist in the Node runtime image. Worth 60 seconds of empiricism before
 * committing to an architecture.
 *
 * DELETE once the answer is recorded in site issue #3.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 30;

function tryRun(cmd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean, out: string) => {
      if (done) return;
      done = true;
      resolve({ ok, out: out.trim().slice(0, 400) });
    };

    try {
      const child = spawn(cmd, args);
      const chunks: Buffer[] = [];
      child.stdout.on("data", (d) => chunks.push(d));
      child.stderr.on("data", (d) => chunks.push(d));
      child.on("error", (e) => finish(false, `spawn error: ${e.message}`));
      child.on("close", (code) =>
        finish(code === 0, `exit ${code}: ${Buffer.concat(chunks).toString("utf8")}`),
      );
      setTimeout(() => {
        child.kill("SIGKILL");
        finish(false, "timed out after 10s");
      }, 10_000);
    } catch (e) {
      finish(false, `threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
}

export async function GET() {
  const enginePath = join(process.cwd(), "engine", "forecast.py");

  let engineBundled: string;
  try {
    await access(enginePath, constants.R_OK);
    engineBundled = "yes";
  } catch (e) {
    engineBundled = `no (${e instanceof Error ? e.message : String(e)})`;
  }

  const [python3, python, engineRun] = await Promise.all([
    tryRun("python3", ["--version"]),
    tryRun("python", ["--version"]),
    tryRun("python3", [enginePath, "--help"]),
  ]);

  return Response.json(
    {
      runtime: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cwd: process.cwd(),
        vercelEnv: process.env.VERCEL_ENV ?? "local",
        region: process.env.VERCEL_REGION ?? null,
      },
      engineBundled,
      enginePath,
      python3,
      python,
      engineRun,
      verdict:
        python3.ok && engineRun.ok
          ? "Python engine is executable from the Node runtime."
          : "Python is NOT usable here — the engine needs its own service.",
    },
    { headers: { "cache-control": "no-store" } },
  );
}
