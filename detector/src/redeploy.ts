// `npm run redeploy` — stop the previously-deployed workflow (looked up
// from workflow-ids.local.json) and run deploy.ts.
//
// This is the closest thing Otomato gives us to "update in place" — the
// platform doesn't expose a delta-update API, so the only way to change
// a deployed workflow is stop-then-deploy.

import dotenv from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Workflow, apiServices } from 'otomato-sdk';

import { loadEnv } from './config.js';
import { WORKFLOW_NAME } from './workflow.js';

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
const idsFile = resolve(projectRoot, 'workflow-ids.local.json');

dotenv.config({ path: resolve(projectRoot, '.env') });

async function main(): Promise<void> {
  const env = loadEnv();
  apiServices.setUrl(env.OTOMATO_API_URL);
  apiServices.setAuth(env.OTOMATO_API_KEY);

  // ── Stop the existing workflow if we have one on file ───────────
  if (existsSync(idsFile)) {
    const ids: Record<string, string> = JSON.parse(
      readFileSync(idsFile, 'utf-8'),
    ) as Record<string, string>;
    const oldId = ids[WORKFLOW_NAME];
    if (typeof oldId === 'string' && oldId.length > 0) {
      console.log(`Stopping previous workflow ${oldId}...`);
      try {
        const wf = new Workflow(WORKFLOW_NAME, [], []);
        await wf.load(oldId);
        // Otomato exposes pause/stop semantics via wf.delete or similar
        // depending on version. If not, log and proceed — a stale
        // workflow in Otomato just means the operator has to clean up
        // the dashboard manually; deploy still succeeds.
        const w = wf as unknown as { delete?: () => Promise<unknown> };
        if (typeof w.delete === 'function') {
          await w.delete();
          console.log(`  deleted via SDK`);
        } else {
          console.log(`  SDK has no delete — please stop ${oldId} from app.otomato.xyz manually`);
        }
      } catch (err) {
        console.warn(`  failed to stop previous workflow: ${(err as Error).message}`);
        console.warn(`  continuing — please verify in app.otomato.xyz`);
      }
    }
  } else {
    console.log('No previous workflow on file. Proceeding with fresh deploy.');
  }

  // ── Spawn deploy.ts as the second half. We re-exec rather than
  //    importing because deploy.ts has top-level await and we want a
  //    clean process boundary so dotenv side-effects don't leak.
  console.log('\nHanding off to deploy.ts...\n');
  const { spawnSync } = await import('node:child_process');
  const deployScript = resolve(projectRoot, 'src/deploy.ts');
  const result = spawnSync('npx', ['tsx', deployScript], {
    stdio: 'inherit',
    cwd: projectRoot,
  });
  process.exit(result.status ?? 1);
}

main().catch((err: unknown) => {
  console.error('redeploy failed:', err);
  process.exit(1);
});
