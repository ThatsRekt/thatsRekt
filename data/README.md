# Historic incident dataset

Curated catalog of major DeFi hacks intended for seeding the production
thatsRekt registry on launch day. The on-chain feed should not be empty
when the first user lands — this dataset is the backstop.

**Status:** Dataset only. No seeding script wired yet (deferred — see
`tasks/historic-data-seed.md`).

## Coverage

- **31 incidents**, ~$5.1B catalogued
- **EVM-focused.** One Solana entry (Mango Markets) is included as
  informational and flagged in its `note` to be filtered at seed time.
- **Time range:** 2016 (The DAO) through Oct 2024 (Radiant).
- **Categories represented:** smart-contract bugs, oracle manipulation,
  flashloan exploits, governance attacks, bridge compromises, key
  theft, rogue insiders, MPC compromise, frontend injection.

## Schema

```jsonc
{
  "id":          "ronin-bridge-2022-mar",      // stable slug for refs
  "protocol":    "Ronin Bridge",                // human-readable
  "chain":       "ethereum",                    // chain slug; matches thatsRekt deployments
  "attackedAt":  "2022-03-23T12:00:00Z",        // ISO 8601 UTC
  "title":       "Ronin Bridge — $625M Lazarus Group validator-key compromise",  // ≤200 bytes (contract cap)
  "attackers":   ["0x098b716b8a..."],           // 0x-prefixed; empty if not confirmed
  "victims":     ["0x8407dc5773..."],           // protocol contract address(es); empty if N/A
  "note":        "...",                         // free-form context
  "sourceUrl":   "https://rekt.news/...",       // primary citation
  "amountUsd":   625000000                      // approximate USD at time of incident
}
```

## Conventions

- **Addresses are lowercased** to match the indexer's `Address.id`
  normalization.
- **`attackers` may be empty** for incidents where the address isn't
  publicly confirmed or where many opportunists drained (Nomad).
  Empty-attackers posts still surface the title, which is the value
  proposition for users browsing.
- **`title` is capped at 200 bytes** (the contract's
  `MAX_TITLE_LENGTH`). Format: `"Protocol — short description"`.
- **`chain` records the truth** of where the incident happened. The
  seeding script will decide which thatsRekt deployment to actually
  post on (likely all on Ethereum mainnet, regardless of original
  chain, since that's where users will look first — but this is a
  seed-script decision, not a dataset decision).

## What's deliberately NOT here

- Exchange hacks (Mt. Gox, FTX, KuCoin, WazirX, DMM Bitcoin) — those
  are CeFi, not on-chain DeFi. Out of scope.
- Stablecoin de-pegs that aren't exploits (UST, USDC March 2023, sUSD
  edge cases) — collapses without a contract bug or key theft.
- Long-tail sub-$10M incidents — interesting historically but they'd
  drown the feed.
- Frontrunning / MEV "exploits" — gray-area, not really hacks.

## Field-by-field gaps to revisit

Going through later if we want to upgrade dataset quality:

- **Attacker addresses on bridge / multisig hacks** — many publicly
  documented, just not pasted in here yet (Harmony, Wintermute,
  Multichain). Add as we verify.
- **Victim addresses** — most entries empty; would benefit from the
  protocol's main vulnerable contract for each.
- **Amount precision** — round figures from rekt.news / DefiLlama;
  could refine with on-chain reconstruction.
- **Cross-chain breakouts** — entries like Multichain, Curve hit
  multiple chains. Currently one entry per incident; could split
  per-chain if we want chain-specific feeds.

## Next step

Build the seeding script: read this JSON, filter by `chain == "ethereum"`
(or whichever target), POST each entry through the relay's `/post`
endpoint (or via direct `cast` from a whitelisted EOA). Defer until
the operator decides:

1. Curator identity — single seed address or spread across several
   "founding curators" so the leaderboard isn't a one-line affair?
2. Chain mapping — seed everything to Ethereum mainnet, or split
   per chain matching the original incident location?
3. Live timing — post the seeds before launch, or batch on day 0?
