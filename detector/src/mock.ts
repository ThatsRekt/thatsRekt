// Local mock detector — fires a single fake detection directly into the
// running local relay's /detect endpoint. NO Otomato, NO ngrok needed.
//
// This is the dev-loop tool: bring up the local stack (anvil + indexer
// + relay), then run `npm run mock` to simulate "Otomato just detected
// a hack of <protocol>". Watch the post land on chain + render in the
// frontend.
//
// Production uses the real Otomato workflow over ngrok. The mock and
// the real workflow speak the SAME `/detect` contract — body is the
// raw tweet text, metadata is in headers — so anything that works
// against the mock works against prod.
//
// Usage:
//
//   npm run mock                                # default: Aave, sample tweet
//   npm run mock -- --protocol Lido             # custom protocol
//   npm run mock -- --tweet "stETH depeg event" # custom body
//   npm run mock -- --images https://a.com/1.jpg,https://a.com/2.jpg
//   npm run mock -- --account peckshield --idem-key my-test-1
//   npm run mock -- --relay http://127.0.0.1:8080 --token <token>
//
// Defaults pull from /tmp/thatsrekt-relay.token (written by
// ops/scripts/start-relay.sh) so usually no token flag is needed.

import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

interface MockArgs {
  protocol: string;
  tweet: string;
  account: string;
  chain: string;
  idemKey: string;
  images: string[];
  relayURL: string;
  token: string;
}

const DEFAULT_TOKEN_FILE = '/tmp/thatsrekt-relay.token';
const DEFAULT_RELAY_URL = 'http://127.0.0.1:8080';

const SAMPLE_TWEETS: Record<string, string> = {
  Aave:
    'BREAKING: Aave V3 pool drained via flashloan exploit. ~$12M moved to attacker contract. Funds frozen, post-mortem incoming.',
  Lido:
    'stETH depeg event reported across multiple AMMs. Curve pool imbalance growing. Investigating root cause.',
  Ethena:
    'sUSDe oracle manipulation suspected. USDe peg pressure across CEX pairs. Funds at risk if not stabilized.',
  Maple:
    'syrupUSDC vault reports custodian-side incident. Withdrawals paused pending review.',
  Treehouse:
    'tETH redemption queue halted after vault accounting discrepancy. Investigating.',
};

function parseArgs(argv: string[]): MockArgs {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (typeof token !== 'string' || !token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (typeof next === 'string' && !next.startsWith('--')) {
      args.set(key, next);
      i++;
    } else {
      args.set(key, 'true');
    }
  }

  const protocol = args.get('protocol') ?? 'Aave';
  const tweet =
    args.get('tweet') ?? SAMPLE_TWEETS[protocol] ?? SAMPLE_TWEETS['Aave']!;
  const account = args.get('account') ?? 'BlockSecTeam';
  const chain = args.get('chain') ?? 'anvil-eth';
  const idemKey = args.get('idem-key') ?? `mock-${randomUUID()}`;
  const imagesArg = args.get('images');
  const images = imagesArg
    ? imagesArg
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : [];
  const relayURL = args.get('relay') ?? DEFAULT_RELAY_URL;

  let token = args.get('token') ?? process.env.WEBHOOK_TOKEN ?? '';
  if (!token) {
    if (existsSync(DEFAULT_TOKEN_FILE)) {
      token = readFileSync(DEFAULT_TOKEN_FILE, 'utf-8').trim();
    }
  }
  if (!token) {
    console.error(
      `ERROR: no token. Set --token <token>, WEBHOOK_TOKEN env, or run \`make relay-up\` first (writes ${DEFAULT_TOKEN_FILE}).`,
    );
    process.exit(1);
  }

  return { protocol, tweet, account, chain, idemKey, images, relayURL, token };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const headers: Record<string, string> = {
    Authorization: `Bearer ${args.token}`,
    'Content-Type': 'text/plain',
    'X-Idempotency-Key': args.idemKey,
    'X-Tweet-URL': `https://x.com/${args.account}/status/${args.idemKey}`,
    'X-Tweet-Account': args.account,
    // Backdate by 60s. Anvil's block.timestamp lags wall-clock when
    // forked from a recent block (block-time=2s, but real time keeps
    // advancing); the contract reverts InvalidAttackedAt if attackedAt
    // > block.timestamp. Real tweets are always slightly in the past
    // anyway, so this also mirrors prod behavior.
    'X-Tweet-Timestamp': new Date(Date.now() - 60_000).toISOString(),
    'X-Chain': args.chain,
    'X-Protocol': args.protocol,
  };
  if (args.images.length > 0) {
    headers['X-Tweet-Images'] = JSON.stringify(args.images);
  }

  const url = `${args.relayURL.replace(/\/$/, '')}/detect`;

  console.log(`POST ${url}`);
  console.log(`  protocol  = ${args.protocol}`);
  console.log(`  account   = ${args.account}`);
  console.log(`  chain     = ${args.chain}`);
  console.log(`  idem-key  = ${args.idemKey}`);
  if (args.images.length > 0) {
    console.log(`  images    = ${args.images.join(', ')}`);
  }
  console.log(`  body      = ${args.tweet}`);
  console.log('');

  const started = Date.now();
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers,
      body: args.tweet,
    });
  } catch (err: unknown) {
    console.error(`fetch failed: ${(err as Error).message}`);
    console.error(`  is the relay running? \`make relay-up\` from ops/`);
    process.exit(1);
  }

  const elapsedMs = Date.now() - started;
  const text = await resp.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* leave as text */
  }

  const ok = resp.status >= 200 && resp.status < 300;
  console.log(`HTTP ${resp.status} ${resp.statusText}  (${elapsedMs}ms)`);
  console.log(JSON.stringify(body, null, 2));

  if (!ok) {
    process.exit(2);
  }

  // Surface the post id + tx hash if present — saves the operator a
  // round trip to the receipt.
  if (body && typeof body === 'object' && 'results' in body) {
    const results = (body as { results?: Array<{ chain: string; status: string; tx_hash?: string; post_id?: string }> }).results ?? [];
    for (const r of results) {
      if (r.tx_hash || r.post_id) {
        console.log('');
        console.log(`✓ submitted on ${r.chain}: post_id=${r.post_id ?? '?'} tx=${r.tx_hash ?? '?'}`);
      }
    }
  }
}

main().catch((err: unknown) => {
  console.error('mock failed:', err);
  process.exit(1);
});
