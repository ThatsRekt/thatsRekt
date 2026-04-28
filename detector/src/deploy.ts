// `npm run deploy` entrypoint.
//
// Loads .env + tracking.json, builds the Otomato workflow, ships it to
// Otomato, writes the resulting workflow id to workflow-ids.local.json
// (gitignored — the id is environment-specific and shouldn't pollute
// shared config).
//
// Idempotency note: Otomato's `workflow.create()` creates a NEW
// workflow each time. The previous workflow with the same name is NOT
// stopped or replaced. To actually replace, use `npm run redeploy`
// which loads the existing id, stops it, and then deploys fresh.

import dotenv from 'dotenv';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiServices } from 'otomato-sdk';

import { loadDetectorConfig } from './config.js';
import { buildWorkflow, WORKFLOW_NAME } from './workflow.js';

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
const idsFile = resolve(projectRoot, 'workflow-ids.local.json');

dotenv.config({ path: resolve(projectRoot, '.env') });

async function main(): Promise<void> {
  const cfg = loadDetectorConfig();

  apiServices.setUrl(cfg.env.OTOMATO_API_URL);
  apiServices.setAuth(cfg.env.OTOMATO_API_KEY);

  const branchCount = cfg.tracking.protocols.length;
  const triggerCount = cfg.tracking.monitoredAccounts.length;
  const recipientCount = cfg.tracking.alertEmails.length;
  const totalNodes =
    triggerCount + 1 /* split */ + branchCount * (3 + recipientCount);

  console.log(
    `\nBuilding "${WORKFLOW_NAME}":\n` +
      `  ${triggerCount} X triggers\n` +
      `  ${branchCount} protocol branches\n` +
      `  ${recipientCount} email recipients per branch\n` +
      `  → ${totalNodes} total nodes\n` +
      `  webhook: ${cfg.env.WEBHOOK_BASE_URL}/detect (chain=${cfg.env.WEBHOOK_CHAIN})\n`,
  );

  const workflow = buildWorkflow(cfg);

  const result = await workflow.create();
  if (!result.success) {
    console.error('workflow.create failed:', result.error);
    process.exit(1);
  }

  const id = workflow.id;
  if (typeof id !== 'string' || id.length === 0) {
    console.error('workflow.create returned without an id');
    process.exit(1);
  }

  console.log(`Workflow created — id: ${id}`);
  console.log(`State: ${workflow.getState() ?? 'unknown'}`);

  await workflow.run();
  console.log(`State after run: ${workflow.getState() ?? 'unknown'}`);

  // Persist id locally for `npm run check` and `npm run redeploy`.
  // We append-or-replace by name so a re-run cleanly updates the file.
  writeFileSync(
    idsFile,
    JSON.stringify({ [WORKFLOW_NAME]: id }, null, 2) + '\n',
    'utf-8',
  );
  console.log(`Workflow id saved to ${idsFile}`);
}

main().catch((err: unknown) => {
  console.error('deploy failed:', err);
  process.exit(1);
});
