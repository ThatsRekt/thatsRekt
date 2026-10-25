---
status: accepted
---

# On-chain Channels, run only by governance; whitelisting is per Channel

Each chain's **Registry** stores **Channels**, and every **Post** belongs to exactly one, fixed at creation; a **Report** signs one `channelId`. A **Channel**'s id is `keccak256(name)`, so a name has the same id on every chain, and names never change. **Channels** have no admins: four role addresses held by governance create, staff, unstaff, and close them, each changeable only by the 7-day owner. There is no chain-wide **Guardian** list — an address is a **Guardian** of a specific **Channel**, and every check (posting, **Edits**, **Retractions**, **Votes**, comments) uses that **Channel**'s members. Every **Post** event carries `channelId` as an indexed topic, so anyone can follow one **Channel** from the chain alone. `main` is the public feed: it holds today's **Guardians** and, through the API, every **Legacy Post**, and it is the only **Channel** DAMM forwards to Telegram. Design record: [`intake-redesign.md`](../intake-redesign.md) D57–D70, D74, D75.

## Considered Options

- **Off-chain channels** (tags in the API only) — rejected. A tag the API controls is not something a community can verify or follow without DAMM.
- **A `channelIds[]` array per Report** — rejected. One signature would fan out to several **Posts**, **Duplicate** scopes, and **Request** ids.
- **Guardian-run Channels with their own admins** — rejected. DAMM's **Relayer** pays gas for every **Post**, so admin-added outsiders could spend it.
- **A chain-wide Guardian list that Channels draw from** — rejected. A 1-day add to a small **Channel** would grant **Votes** and comments on `main`.
- **Per-chain counter ids** — rejected. The same **Channel** would have different ids per chain, so grouping and the frontend would need a name ↔ id map.
- **Tagging only `PostRelayed` with the Channel** — rejected. Trackers would have to join every other event by `postId`.

## Consequences

- Event signatures change for every **Post** event; all consumers move to the v2 ABI at the upgrade (ADR 0004).
- The 1-day delay on adding members lives in the `guardianAdder` holder (a TimelockController), not the contract; the holders must be checked at deploy and on every owner change.
- Closing is one-way and freezes the **Channel**; reusing its name is impossible.
- Scores stay per chain, shared by all **Channels**: the same hack in two **Channels** counts its attackers twice in `attackerAppearances`. Changing this is a 7-day upgrade.
- Duplicate checks and **Incident** grouping are scoped to one **Channel**.
