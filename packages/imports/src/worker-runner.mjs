/**
 * Adapter worker runner.
 *
 * Executed as a child process by `sandbox.js`. It reads one JSON job from stdin,
 * imports the adapter's `entry_point`, runs `extract`, and writes one JSON result
 * to stdout. It holds no credentials and no database handle: the parent gives it
 * a temporary file path and nothing else.
 */
import { readFile } from 'node:fs/promises';

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const job = JSON.parse(Buffer.concat(chunks).toString('utf8'));

  try {
    const module = await import(job.entryPoint);
    const adapter = module.default ?? module;
    const extract = adapter.extract ?? module.extract;
    if (typeof extract !== 'function') throw new Error('The adapter entry point exports no extract function.');

    const result = await extract({
      path: job.path,
      mediaType: job.mediaType,
      filename: job.filename ?? null,
      limits: job.limits ?? {},
    });

    process.stdout.write(JSON.stringify({ ok: true, result }));
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        ok: false,
        error: { name: error?.name ?? 'Error', message: error?.message ?? 'Adapter failed.', code: error?.code ?? null },
      }),
    );
  }
}

// A tiny helper adapters can use without importing node:fs themselves when they
// only need the bytes; kept here so the sandbox surface is one file.
export { readFile };

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(String(error?.stack ?? error));
    process.exit(1);
  },
);
