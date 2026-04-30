# Historic incident dataset

Curated catalog of major DeFi hacks intended for seeding the production
thatsRekt registry on launch day. The on-chain feed should not be empty
when the first user lands — this dataset is the backstop.

**Status:** Used by the frontend as the read-only "archive" feed
section (see `tasks/archive-frontend-design.md`). The original plan to
seed these on-chain (`tasks/historic-data-seed.md`) is dropped — old
attacks live as a frontend archive, not as on-chain registry entries.

The source of truth is `data/historic-incidents.json` — a sorted (by
`attackedAt` ASC) array of incident objects. **A copy lives at
`frontend/src/data/historic-incidents.json`** and is what the frontend
imports. Vite/`tsc` can't reach outside `frontend/src/`, so the
duplication is structural. **If you change this file, also update the
frontend copy** (the dataset is essentially frozen, so this rarely
comes up).

---

## Coverage at a glance

| | |
|---|---:|
| Total entries | **31** |
| Total damages catalogued | **~$5.08B** |
| Time range | 2016-06 (The DAO) → 2024-10 (Radiant) |
| Entries with confirmed attacker address | 20 / 31 |
| Entries with confirmed victim contract | 9 / 31 |
| Multi-chain incidents flagged | 5 / 31 |

### By primary chain

| chain | count |
|---|---:|
| `ethereum` | 26 |
| `arbitrum` | 2 |
| `bsc` | 1 |
| `blast` | 1 |
| `solana` | 1 *(informational, not for seed)* |

### By year

| year | count | $ damages |
|---|---:|---:|
| 2016 | 1 | $60M |
| 2017 | 2 | $330M |
| 2020 | 4 | $69M |
| 2021 | 5 | $962M |
| 2022 | 9 | $2.30B |
| 2023 | 5 | $749M |
| 2024 | 5 | $614M |

---

## Schema

Every entry has these fields. Required fields are shown in **bold**.

```jsonc
{
  "id":          "ronin-bridge-2022-mar",      // [required] stable slug for cross-references
  "protocol":    "Ronin Bridge",                // [required] human-readable
  "chain":       "ethereum",                    // [required] PRIMARY EVM chain slug — where thatsRekt would post the alert
  "attackedAt":  "2022-03-23T12:00:00Z",        // [required] ISO 8601 UTC
  "title":       "Ronin Bridge — $625M ...",    // [required] ≤200 bytes (matches contract MAX_TITLE_LENGTH)
  "attackers":   ["0x098b716b8a..."],           // [required] 0x-prefixed lowercased; may be empty if not confirmed
  "victims":     ["0x8407dc5773..."],           // [required] protocol contract addresses; may be empty if N/A
  "note":        "...",                         // [required] free-form context; includes provenance ("per rekt.news")
  "sourceUrl":   "https://rekt.news/...",       // [required] primary citation
  "amountUsd":   625000000,                     // [required] approximate USD at time of incident
  "chainsAffected": ["ethereum", "bsc"]         // [optional] for multi-chain incidents — chains beyond `chain`
}
```

### Conventions

- **Lowercased addresses** — matches the indexer's `Address.id` normalization.
- **Empty arrays are valid** — for incidents where attacker addresses aren't publicly confirmed (Wormhole guardian-side, Nomad free-for-all, etc.). Empty-attackers posts still surface the title, which is the value proposition for browsing users.
- **Title ≤ 200 bytes** — the contract's `MAX_TITLE_LENGTH`. Format: `"Protocol — short description"`. Numbers (USD) inline if they fit.
- **`chain` is the primary chain** for posting purposes, not necessarily the chain the protocol is "from". For bridges, this is the chain where the drained contract lives. For multi-chain incidents, this is the chain with the largest loss; secondary chains go into `chainsAffected[]`.
- **`note` carries provenance** for any non-trivial address claim, e.g. *"Attacker EOA 0xabc... per rekt.news."* — so a future reviewer can audit.

### Allowed `chain` slugs

EVM chains (any of these for primary `chain` and `chainsAffected[]`): `ethereum`, `bsc`, `polygon`, `arbitrum`, `optimism`, `base`, `blast`, `avalanche`, `fantom`, `harmony`, `moonbeam`, `ronin`.

Non-EVM (`solana`) is reserved for informational entries that explain a famous incident but won't be posted to thatsRekt. There is exactly one (Mango Markets); flagged in its `note`.

---

## What's deliberately NOT here

- **Exchange hacks** (Mt. Gox, FTX, KuCoin, WazirX, DMM Bitcoin) — CeFi, not on-chain DeFi. Out of scope.
- **Stablecoin de-pegs** that aren't exploits (UST collapse, USDC March 2023, sUSD edge cases) — collapses without a contract bug or key theft.
- **Long-tail sub-$10M incidents** — interesting historically but they'd drown the feed.
- **Frontrunning / MEV "exploits"** — gray-area, not really hacks.

## Field-by-field gaps

Going through later if we want to upgrade dataset quality — these are the entries the verification pass left without addresses, by category:

- **No publicly-named attacker** — The DAO 2016, Parity Multisig, bZx, dForce, Pickle, Yearn V1, Compound 062, Inverse Finance, Multichain (6 dust addresses, no canonical), Gala Games (label only)
- **Victim contract not yet filled** — most of the 2020-2021 long-tail (Yearn V1, Pickle, Cream)
- **Amount precision** — round figures from rekt.news / DefiLlama; could refine with on-chain reconstruction

These aren't blockers; partial-data incidents still appear in the feed with their title, source URL, and amount. The seeding script will treat empty arrays as "no addresses to confirm" and post a title-only alert.

---

## Adding a new entry

1. Pick a stable slug (`{protocol-slug}-{yyyy}-{mm}` is the convention).
2. Add the entry to `historic-incidents.json` in chronological position by `attackedAt`.
3. Re-sort if you add to the end:
   ```sh
   jq 'sort_by(.attackedAt)' data/historic-incidents.json > /tmp/s.json && mv /tmp/s.json data/historic-incidents.json
   ```
4. Verify it parses:
   ```sh
   jq 'length' data/historic-incidents.json
   ```
5. Open a PR.

For sourcing addresses: rekt.news writeups are the primary source we've been using. DefiLlama hacks page and official protocol post-mortems are secondary. Cross-check on Etherscan/Arbiscan/etc. before adding any address — the verification commit (PR #26) sets the bar.

---

## Next step

Build the seeding script: read this JSON, filter by `chain` (or use `chainsAffected[]` to fan out), POST each entry through the relay's `/post` endpoint or via direct `cast send` from a whitelisted EOA. Defer until the operator decides:

1. **Curator identity** — single seed address or spread across several "founding curators" so the leaderboard isn't a one-line affair on launch day?
2. **Chain mapping** — seed everything to Ethereum mainnet, or split per chain matching the original incident location?
3. **Live timing** — post the seeds before launch, or batch on day 0?
