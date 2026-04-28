// Detector configuration: load + validate `tracking.json` and the env
// variables that point the workflow at the relay.
//
// Layout philosophy:
//   - tracking.json owns the editorial config (which X accounts to
//     monitor, which protocols to detect for). It changes when the team
//     adds/removes coverage.
//   - .env owns the deployment-time secrets and the webhook target.
//     These rotate independently of the editorial config.
//   - This module is the only place that reads either source — every
//     other module takes a fully validated DetectorConfig and assumes
//     it's correct.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..');

// ─── Schemas ────────────────────────────────────────────────────────

export const MonitoredAccountSchema = z.object({
  username: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9_]+$/, 'X usernames are alphanumeric + underscore'),
  includeRetweets: z.boolean(),
});

export const ProtocolSchema = z.object({
  name: z.string().min(1).max(50),
  twitterHandle: z.string().regex(/^[A-Za-z0-9_]+$/).optional(),
  // Keywords are matched as exact tokens by the AI prompt. Empty strings
  // would break that contract; reject them at config load.
  keywords: z.array(z.string().min(1)).min(1).max(20),
  website: z.string().url().optional(),
});

export const TrackingFileSchema = z.object({
  // Multiple recipients are sent via N SEND_EMAIL actions per branch
  // (Otomato's `to` is a single address). Keep this list small —
  // each entry adds one node × number-of-protocols branches.
  alertEmails: z.array(z.string().email()).min(1).max(10),
  monitoredAccounts: z.array(MonitoredAccountSchema).min(1).max(20),
  protocols: z.array(ProtocolSchema).min(1).max(50),
});

export type MonitoredAccount = z.infer<typeof MonitoredAccountSchema>;
export type Protocol = z.infer<typeof ProtocolSchema>;
export type TrackingFile = z.infer<typeof TrackingFileSchema>;

// EnvSchema is what we expect from process.env after dotenv has run.
// We split it from TrackingFile because env carries deployment-time
// secrets (API key, webhook token) that should NEVER appear in
// tracking.json. The same tracking.json deploys against dev/prod by
// pointing at different env files.
export const EnvSchema = z.object({
  OTOMATO_API_KEY: z.string().min(1, 'OTOMATO_API_KEY is required'),
  OTOMATO_API_URL: z.string().url().default('https://api.otomato.xyz/api'),
  WEBHOOK_BASE_URL: z
    .string()
    .url('WEBHOOK_BASE_URL must be a full URL (e.g. https://abcd.ngrok-free.app)')
    .refine((u) => !u.endsWith('/'), 'WEBHOOK_BASE_URL must not end with a trailing slash'),
  WEBHOOK_TOKEN: z.string().min(8, 'WEBHOOK_TOKEN is too short — pick a real secret'),
  WEBHOOK_CHAIN: z.string().min(1).default('anvil-eth'),
});

export type Env = z.infer<typeof EnvSchema>;

// DetectorConfig is the merged, validated, ready-to-consume config that
// the rest of the codebase actually uses. This is the type that
// buildWorkflow() takes.
export interface DetectorConfig {
  readonly tracking: TrackingFile;
  readonly env: Env;
}

// ─── Loaders ────────────────────────────────────────────────────────

/**
 * Load and validate `tracking.json` from the detector package root.
 *
 * Throws (with a Zod issue list) on schema mismatch. We do NOT mask the
 * error — a bad config is the operator's problem to see clearly.
 */
export function loadTrackingFile(path?: string): TrackingFile {
  const target = path ?? resolve(projectRoot, 'tracking.json');
  const raw = readFileSync(target, 'utf-8');
  const parsed: unknown = JSON.parse(raw);
  return TrackingFileSchema.parse(parsed);
}

/**
 * Load and validate environment variables from process.env.
 *
 * dotenv has already run by the time this is called (see
 * src/deploy.ts), so we only need to validate the resulting shape.
 */
export function loadEnv(env: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(env);
}

/**
 * The single load+validate entrypoint used by deploy/check/redeploy.
 * Pulls tracking.json + env, validates each, returns the merged
 * DetectorConfig.
 */
export function loadDetectorConfig(): DetectorConfig {
  return {
    tracking: loadTrackingFile(),
    env: loadEnv(),
  };
}
