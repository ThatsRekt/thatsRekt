import 'dotenv/config'
import { TypeormDatabase } from '@subsquid/typeorm-store'

import { events } from './abi/ThatsRekt'
import { getChain } from './chains'
import { buildProcessor, Log, ProcessorContext } from './processor'

const requireEnv = (key: string): string => {
  const v = process.env[key]
  if (!v) throw new Error(`Missing required env var: ${key}`)
  return v
}

const chain = getChain(requireEnv('CHAIN'))
const { processor, contractAddress: CONTRACT_ADDRESS } = buildProcessor(chain)
import {
  Address,
  Edit,
  EditKind,
  OwnershipChange,
  Post,
  PostAttacker,
  PostVictim,
  Proposer,
  Upgrade,
  Confirmation,
  ConfirmDirection,
  WhitelistChange,
  Whitelister,
} from './model'

type Ctx = ProcessorContext

type Caches = {
  posts: Map<string, Post>
  addresses: Map<string, Address>
  whitelisters: Map<string, Whitelister>
  proposers: Map<string, Proposer>
  postAttackers: Map<string, PostAttacker>
  postVictims: Map<string, PostVictim>
  // Per-batch memo of getPostAttackerLinks / getPostVictimLinks results
  // keyed by postId. Avoids redundant `ctx.store.find` roundtrips when a
  // single post receives multiple Confirmed events in the same batch
  // (each Confirmed with delta != 0 calls the helper). Invalidated by
  // `getOrCreatePostAttacker` / `getOrCreatePostVictim` whenever a new
  // link is added to `postAttackers` / `postVictims`, so the next call
  // re-queries DB + re-merges with the now-updated cache.
  postAttackerLinksByPost: Map<string, PostAttacker[]>
  postVictimLinksByPost: Map<string, PostVictim[]>
  // append-only — never read back this batch
  confirmationLog: Confirmation[]
  edits: Edit[]
  whitelistChanges: WhitelistChange[]
  upgrades: Upgrade[]
  ownershipChanges: OwnershipChange[]
}

const newCaches = (): Caches => ({
  posts: new Map(),
  addresses: new Map(),
  whitelisters: new Map(),
  proposers: new Map(),
  postAttackers: new Map(),
  postVictims: new Map(),
  postAttackerLinksByPost: new Map(),
  postVictimLinksByPost: new Map(),
  confirmationLog: [],
  edits: [],
  whitelistChanges: [],
  upgrades: [],
  ownershipChanges: [],
})

// --- entity helpers ---

const lc = (a: string): string => a.toLowerCase()
const linkId = (postId: string, addr: string): string => `${postId}-${lc(addr)}`
const eventId = (log: Log): string => `${log.transactionHash}-${log.logIndex}`

async function getOrCreatePost(
  ctx: Ctx,
  caches: Caches,
  id: string,
): Promise<Post | undefined> {
  if (caches.posts.has(id)) return caches.posts.get(id)
  // Load with the `poster` relation populated. `handleConfirmed` and
  // `handlePostRemoved` both touch `post.poster.id` to update the
  // poster's leaderboard / aggregates, and TypeORM's bare `store.get`
  // returns the entity with relation refs as `undefined`. Without the
  // relation, a Confirmed event hitting a post created in a *previous*
  // batch (cache miss) crashes the processor on `post.poster.id`. The
  // crash retries forever — blocking the indexer at that block.
  //
  // Cheap one-off JOIN per post lookup. The cache hit above still
  // covers the same-batch case so this only kicks in on cold lookups.
  const existing = await ctx.store.findOne(Post, {
    where: { id },
    relations: { poster: true },
  })
  if (existing) caches.posts.set(id, existing)
  return existing
}

async function getOrCreateAddress(
  ctx: Ctx,
  caches: Caches,
  rawAddr: string,
): Promise<Address> {
  const id = lc(rawAddr)
  const cached = caches.addresses.get(id)
  if (cached) return cached
  let addr = await ctx.store.get(Address, id)
  if (!addr) {
    addr = new Address({
      id,
      attackerScore: 0n,
      attackerAppearances: 0,
      isVictim: false,
      victimActivePostCount: 0,
    })
  }
  caches.addresses.set(id, addr)
  return addr
}

async function getOrCreateWhitelister(
  ctx: Ctx,
  caches: Caches,
  rawAddr: string,
): Promise<Whitelister> {
  const id = lc(rawAddr)
  const cached = caches.whitelisters.get(id)
  if (cached) return cached
  let w = await ctx.store.get(Whitelister, id)
  if (!w) {
    w = new Whitelister({
      id,
      isCurrentlyWhitelisted: false,
    })
  }
  caches.whitelisters.set(id, w)
  return w
}

async function getOrCreateProposer(
  ctx: Ctx,
  caches: Caches,
  rawAddr: string,
  blockNumber: number,
  ts: Date,
): Promise<Proposer> {
  const id = lc(rawAddr)
  const cached = caches.proposers.get(id)
  if (cached) return cached
  let p = await ctx.store.get(Proposer, id)
  if (!p) {
    p = new Proposer({
      id,
      postCount: 0,
      totalConfirmations: 0n,
      totalDisconfirmations: 0n,
      lastUpdatedAt: ts,
      lastUpdatedAtBlock: blockNumber,
    })
  }
  caches.proposers.set(id, p)
  return p
}

async function getOrCreatePostAttacker(
  ctx: Ctx,
  caches: Caches,
  post: Post,
  address: Address,
  blockNumber: number,
): Promise<PostAttacker | undefined> {
  const id = linkId(post.id, address.id)
  if (caches.postAttackers.has(id)) return undefined  // already exists this batch
  const existing = await ctx.store.get(PostAttacker, id)
  if (existing) {
    caches.postAttackers.set(id, existing)
    // Invalidate the per-post links memo: a previously cached result for
    // this post may not have included `existing` if it was cached before
    // this DB-loaded entry was added to caches.postAttackers.
    caches.postAttackerLinksByPost.delete(post.id)
    return undefined
  }
  const link = new PostAttacker({ id, post, address, createdAtBlock: blockNumber })
  caches.postAttackers.set(id, link)
  // New same-batch link: any cached result for this post is now stale.
  caches.postAttackerLinksByPost.delete(post.id)
  return link
}

async function getOrCreatePostVictim(
  ctx: Ctx,
  caches: Caches,
  post: Post,
  address: Address,
  blockNumber: number,
): Promise<PostVictim | undefined> {
  const id = linkId(post.id, address.id)
  if (caches.postVictims.has(id)) return undefined
  const existing = await ctx.store.get(PostVictim, id)
  if (existing) {
    caches.postVictims.set(id, existing)
    // Invalidate per-post links memo (see getOrCreatePostAttacker note).
    caches.postVictimLinksByPost.delete(post.id)
    return undefined
  }
  const link = new PostVictim({ id, post, address, createdAtBlock: blockNumber })
  caches.postVictims.set(id, link)
  caches.postVictimLinksByPost.delete(post.id)
  return link
}

// Merge DB rows with same-batch cache entries for PostAttacker / PostVictim
// lookups by post id. `ctx.store.find` only sees persisted rows; entries
// created earlier in THIS batch (e.g. PostCreated followed by Confirmed in
// the same Subsquid hot batch) live only in the cache Map and would be
// missed otherwise — silently dropping score deltas / aggregate reversals.
//
// DB rows win on id collisions: cache may hold an entry that was loaded
// via `ctx.store.get(PostAttacker, id)` in `getOrCreatePostAttacker`'s
// "already exists" path, which does NOT populate the `address` relation.
// The DB `find` here uses `relations: { address: true }`, so the DB copy
// always has a usable `address` ref. Same-batch cache-only entries (built
// via `new PostAttacker({ ..., address })`) get added afterwards because
// they are NOT in the DB yet — and they carry their address from the
// constructor, so the score-delta loop can read `link.address.id` safely.
async function getPostAttackerLinks(
  ctx: Ctx,
  caches: Caches,
  postId: string,
): Promise<PostAttacker[]> {
  const memo = caches.postAttackerLinksByPost.get(postId)
  if (memo !== undefined) return memo
  const dbLinks = await ctx.store.find(PostAttacker, {
    where: { post: { id: postId } },
    relations: { address: true },
  })
  const byId = new Map<string, PostAttacker>()
  for (const l of dbLinks) byId.set(l.id, l)
  for (const l of caches.postAttackers.values()) {
    if (l.post.id !== postId) continue
    if (byId.has(l.id)) continue
    byId.set(l.id, l)
  }
  const merged = [...byId.values()]
  caches.postAttackerLinksByPost.set(postId, merged)
  return merged
}

async function getPostVictimLinks(
  ctx: Ctx,
  caches: Caches,
  postId: string,
): Promise<PostVictim[]> {
  const memo = caches.postVictimLinksByPost.get(postId)
  if (memo !== undefined) return memo
  const dbLinks = await ctx.store.find(PostVictim, {
    where: { post: { id: postId } },
    relations: { address: true },
  })
  const byId = new Map<string, PostVictim>()
  for (const l of dbLinks) byId.set(l.id, l)
  for (const l of caches.postVictims.values()) {
    if (l.post.id !== postId) continue
    if (byId.has(l.id)) continue
    byId.set(l.id, l)
  }
  const merged = [...byId.values()]
  caches.postVictimLinksByPost.set(postId, merged)
  return merged
}

const directionFromUint8 = (n: number): ConfirmDirection => {
  switch (n) {
    case 0: return ConfirmDirection.None
    case 1: return ConfirmDirection.Up
    case 2: return ConfirmDirection.Down
    default: throw new Error(`Unknown ConfirmDirection uint8: ${n}`)
  }
}

const weight = (d: ConfirmDirection): number => {
  if (d === ConfirmDirection.Up) return 1
  if (d === ConfirmDirection.Down) return -1
  return 0
}

// --- event handlers ---

async function handlePostCreated(ctx: Ctx, caches: Caches, log: Log): Promise<void> {
  const e = events.PostCreated.decode(log)
  const block = log.block
  const ts = new Date(block.timestamp)
  const postId = e.id.toString()

  const poster = await getOrCreateWhitelister(ctx, caches, e.poster)
  const post = new Post({
    id: postId,
    poster,
    attackedAt: new Date(Number(e.attackedAt) * 1000),
    lastUpdatedAt: ts,
    actionCount: 1,
    title: e.title,
    note: e.note,
    confirmations: 0,
    disconfirmations: 0,
    netScore: 0,
    removed: false,
    purged: false,
    createdAtBlock: block.height,
    createdAtTimestamp: ts,
  })
  caches.posts.set(postId, post)

  // Bump the poster's leaderboard stats. Lifetime postCount; firstPostedAt
  // sticks on first post and never moves; lastUpdatedAt tracks any change.
  const proposer = await getOrCreateProposer(ctx, caches, e.poster, block.height, ts)
  proposer.postCount += 1
  if (proposer.firstPostedAt == null) {
    proposer.firstPostedAt = ts
    proposer.firstPostedAtBlock = block.height
  }
  proposer.lastUpdatedAt = ts
  proposer.lastUpdatedAtBlock = block.height

  for (const rawAttacker of e.attackers) {
    const addr = await getOrCreateAddress(ctx, caches, rawAttacker)
    addr.attackerAppearances += 1
    // score unchanged at creation: post starts at 0/0 confirmations -> netScore == 0
    await getOrCreatePostAttacker(ctx, caches, post, addr, block.height)
  }

  for (const rawVictim of e.victims) {
    const addr = await getOrCreateAddress(ctx, caches, rawVictim)
    addr.victimActivePostCount += 1
    addr.isVictim = true
    await getOrCreatePostVictim(ctx, caches, post, addr, block.height)
  }
}

async function handleConfirmed(ctx: Ctx, caches: Caches, log: Log): Promise<void> {
  const e = events.Confirmed.decode(log)
  const block = log.block
  const postId = e.postId.toString()
  const oldDir = directionFromUint8(e.oldDirection)
  const newDir = directionFromUint8(e.newDirection)
  const delta = weight(newDir) - weight(oldDir)

  const post = await getOrCreatePost(ctx, caches, postId)
  if (!post) {
    ctx.log.warn(`Confirmed event references unknown postId=${postId}; skipping`)
    return
  }
  // Defensive: contract reverts on purged posts (PostIsPurged) so we should
  // never see this. Guard anyway for legacy events from any earlier
  // pre-fix contract version that may still be on-chain.
  if (post.purged) {
    ctx.log.warn(`Confirmed on purged post ${postId}; skipping`)
    return
  }

  // Maintain post.confirmations / post.disconfirmations counters per direction transition.
  if (oldDir === ConfirmDirection.Up) post.confirmations -= 1
  else if (oldDir === ConfirmDirection.Down) post.disconfirmations -= 1
  if (newDir === ConfirmDirection.Up) post.confirmations += 1
  else if (newDir === ConfirmDirection.Down) post.disconfirmations += 1
  post.netScore = post.confirmations - post.disconfirmations

  // Mirror the same delta into the post author's Proposer leaderboard
  // totals. Same transitions, same sign convention, just summed across
  // every post the author has ever made. Lifetime semantics — these
  // counters are NOT reversed when the post is later retracted.
  const posterProposer = await getOrCreateProposer(
    ctx,
    caches,
    post.poster.id,
    block.height,
    new Date(block.timestamp),
  )
  if (oldDir === ConfirmDirection.Up)        posterProposer.totalConfirmations -= 1n
  else if (oldDir === ConfirmDirection.Down) posterProposer.totalDisconfirmations -= 1n
  if (newDir === ConfirmDirection.Up)        posterProposer.totalConfirmations += 1n
  else if (newDir === ConfirmDirection.Down) posterProposer.totalDisconfirmations += 1n
  posterProposer.lastUpdatedAt = new Date(block.timestamp)
  posterProposer.lastUpdatedAtBlock = block.height

  // Apply attacker score delta — load every attacker linked to this post.
  // Use the merge helper so same-batch PostAttacker entries (cache-only,
  // not yet persisted) are still picked up.
  if (delta !== 0) {
    const links = await getPostAttackerLinks(ctx, caches, postId)
    for (const link of links) {
      const addrId = link.address.id
      const cached = caches.addresses.get(addrId) ?? link.address
      cached.attackerScore = cached.attackerScore + BigInt(delta)
      caches.addresses.set(addrId, cached)
    }
  }

  const confirmer = await getOrCreateWhitelister(ctx, caches, e.confirmer)
  caches.confirmationLog.push(
    new Confirmation({
      id: eventId(log),
      post,
      confirmer,
      oldDirection: oldDir,
      newDirection: newDir,
      blockNumber: block.height,
      timestamp: new Date(block.timestamp),
      txHash: log.transactionHash,
    }),
  )
}

async function handlePostRemoved(ctx: Ctx, caches: Caches, log: Log): Promise<void> {
  const e = events.PostRemoved.decode(log)
  const postId = e.postId.toString()
  const block = log.block
  const ts = new Date(block.timestamp)

  const post = await getOrCreatePost(ctx, caches, postId)
  if (!post) {
    ctx.log.warn(`PostRemoved event references unknown postId=${postId}; skipping`)
    return
  }
  // Defensive: contract reverts retract on purged posts (PostIsPurged) so a
  // PostRemoved event after a PostPurged should not occur from a fixed
  // contract. Skip to avoid double-reversing aggregates if a legacy event
  // sneaks through.
  if (post.purged) {
    ctx.log.warn(`PostRemoved on purged post ${postId}; skipping`)
    return
  }
  if (post.removed) return  // idempotent

  post.removed = true
  post.removedAtBlock = block.height
  post.removedAtTimestamp = ts

  // Reverse aggregates: subtract current netScore from each listed attacker;
  // decrement victimActivePostCount for each listed victim. Use the merge
  // helpers so same-batch links (cache-only, not yet persisted) are
  // included — otherwise a post created and removed in the same batch
  // would skip the reversal entirely.
  const attackerLinks = await getPostAttackerLinks(ctx, caches, postId)
  const netAtRemoval = BigInt(post.netScore)
  for (const link of attackerLinks) {
    const addrId = link.address.id
    const cached = caches.addresses.get(addrId) ?? link.address
    cached.attackerScore = cached.attackerScore - netAtRemoval
    caches.addresses.set(addrId, cached)
  }

  const victimLinks = await getPostVictimLinks(ctx, caches, postId)
  for (const link of victimLinks) {
    const addrId = link.address.id
    const cached = caches.addresses.get(addrId) ?? link.address
    cached.victimActivePostCount = Math.max(0, cached.victimActivePostCount - 1)
    cached.isVictim = cached.victimActivePostCount > 0
    caches.addresses.set(addrId, cached)
  }
}

async function handlePostPurged(ctx: Ctx, caches: Caches, log: Log): Promise<void> {
  const e = events.PostPurged.decode(log)
  const postId = e.postId.toString()
  const block = log.block
  const ts = new Date(block.timestamp)

  const post = await getOrCreatePost(ctx, caches, postId)
  if (!post) {
    ctx.log.warn(`PostPurged event references unknown postId=${postId}; skipping`)
    return
  }
  if (post.purged) return  // idempotent

  // Mark purged regardless of prior state.
  post.purged = true
  post.purgedAtBlock = block.height
  post.purgedAtTimestamp = ts

  // Reverse aggregates ONLY if the post was NOT already retracted. The
  // contract's purgePost reverses aggregates iff !removed (so retract +
  // purge does not double-reverse). Mirror that exactly here.
  if (!post.removed) {
    const attackerLinks = await getPostAttackerLinks(ctx, caches, postId)
    const netAtPurge = BigInt(post.netScore)
    for (const link of attackerLinks) {
      const addrId = link.address.id
      const cached = caches.addresses.get(addrId) ?? link.address
      cached.attackerScore = cached.attackerScore - netAtPurge
      caches.addresses.set(addrId, cached)
    }

    const victimLinks = await getPostVictimLinks(ctx, caches, postId)
    for (const link of victimLinks) {
      const addrId = link.address.id
      const cached = caches.addresses.get(addrId) ?? link.address
      cached.victimActivePostCount = Math.max(0, cached.victimActivePostCount - 1)
      cached.isVictim = cached.victimActivePostCount > 0
      caches.addresses.set(addrId, cached)
    }
  }
}

async function handlePostNoteAmended(
  ctx: Ctx,
  caches: Caches,
  log: Log,
): Promise<void> {
  const e = events.PostNoteAmended.decode(log)
  const postId = e.postId.toString()
  const block = log.block
  const ts = new Date(block.timestamp)

  const post = await getOrCreatePost(ctx, caches, postId)
  if (!post) {
    ctx.log.warn(`PostNoteAmended references unknown postId=${postId}; skipping`)
    return
  }
  // Defensive: contract reverts amendNote on purged posts (PostIsPurged).
  // Guard for legacy events from any pre-fix contract version on-chain.
  if (post.purged) {
    ctx.log.warn(`PostNoteAmended on purged post ${postId}; skipping`)
    return
  }
  post.note = e.newNote
  post.lastUpdatedAt = ts
  post.actionCount += 1

  caches.edits.push(
    new Edit({
      id: eventId(log),
      post,
      kind: EditKind.AmendNote,
      newNote: e.newNote,
      blockNumber: block.height,
      timestamp: ts,
      txHash: log.transactionHash,
    }),
  )
}

async function handlePostTitleAmended(
  ctx: Ctx,
  caches: Caches,
  log: Log,
): Promise<void> {
  const e = events.PostTitleAmended.decode(log)
  const postId = e.postId.toString()
  const block = log.block
  const ts = new Date(block.timestamp)

  const post = await getOrCreatePost(ctx, caches, postId)
  if (!post) {
    ctx.log.warn(`PostTitleAmended references unknown postId=${postId}; skipping`)
    return
  }
  // Defensive: contract reverts amendTitle on purged posts (PostIsPurged).
  // Guard for legacy events from any pre-fix contract version on-chain.
  if (post.purged) {
    ctx.log.warn(`PostTitleAmended on purged post ${postId}; skipping`)
    return
  }
  post.title = e.newTitle
  post.lastUpdatedAt = ts
  post.actionCount += 1

  caches.edits.push(
    new Edit({
      id: eventId(log),
      post,
      kind: EditKind.AmendTitle,
      newTitle: e.newTitle,
      blockNumber: block.height,
      timestamp: ts,
      txHash: log.transactionHash,
    }),
  )
}

async function handleAttackersAdded(
  ctx: Ctx,
  caches: Caches,
  log: Log,
): Promise<void> {
  const e = events.AttackersAdded.decode(log)
  const postId = e.postId.toString()
  const block = log.block
  const ts = new Date(block.timestamp)

  const post = await getOrCreatePost(ctx, caches, postId)
  if (!post) {
    ctx.log.warn(`AttackersAdded references unknown postId=${postId}; skipping`)
    return
  }
  // Defensive: contract reverts addAttackers on purged posts (PostIsPurged).
  // Skip to avoid pumping appearances/score from any pre-fix legacy event.
  if (post.purged) {
    ctx.log.warn(`AttackersAdded on purged post ${postId}; skipping`)
    return
  }
  post.lastUpdatedAt = ts
  post.actionCount += 1

  const currentNet = BigInt(post.netScore)
  for (const rawAttacker of e.newAttackers) {
    const addr = await getOrCreateAddress(ctx, caches, rawAttacker)
    addr.attackerAppearances += 1
    addr.attackerScore = addr.attackerScore + currentNet
    await getOrCreatePostAttacker(ctx, caches, post, addr, block.height)
  }

  caches.edits.push(
    new Edit({
      id: eventId(log),
      post,
      kind: EditKind.AddAttackers,
      addedAttackers: e.newAttackers.map(lc),
      blockNumber: block.height,
      timestamp: ts,
      txHash: log.transactionHash,
    }),
  )
}

async function handleVictimsAdded(
  ctx: Ctx,
  caches: Caches,
  log: Log,
): Promise<void> {
  const e = events.VictimsAdded.decode(log)
  const postId = e.postId.toString()
  const block = log.block
  const ts = new Date(block.timestamp)

  const post = await getOrCreatePost(ctx, caches, postId)
  if (!post) {
    ctx.log.warn(`VictimsAdded references unknown postId=${postId}; skipping`)
    return
  }
  // Defensive: contract reverts addVictims on purged posts (PostIsPurged).
  // Skip to avoid flipping isVictim from any pre-fix legacy event.
  if (post.purged) {
    ctx.log.warn(`VictimsAdded on purged post ${postId}; skipping`)
    return
  }
  post.lastUpdatedAt = ts
  post.actionCount += 1

  for (const rawVictim of e.newVictims) {
    const addr = await getOrCreateAddress(ctx, caches, rawVictim)
    addr.victimActivePostCount += 1
    addr.isVictim = true
    await getOrCreatePostVictim(ctx, caches, post, addr, block.height)
  }

  caches.edits.push(
    new Edit({
      id: eventId(log),
      post,
      kind: EditKind.AddVictims,
      addedVictims: e.newVictims.map(lc),
      blockNumber: block.height,
      timestamp: ts,
      txHash: log.transactionHash,
    }),
  )
}

async function handleWhitelistUpdated(
  ctx: Ctx,
  caches: Caches,
  log: Log,
): Promise<void> {
  const e = events.WhitelistUpdated.decode(log)
  const block = log.block
  const ts = new Date(block.timestamp)

  const w = await getOrCreateWhitelister(ctx, caches, e.account)
  w.isCurrentlyWhitelisted = e.status
  w.lastChangedAt = ts
  w.lastChangedAtBlock = block.height
  if (e.status && !w.firstWhitelistedAt) {
    w.firstWhitelistedAt = ts
    w.firstWhitelistedAtBlock = block.height
  }

  // Ensure every newly whitelisted address has a Proposer row even before
  // they post — that way the leaderboard surfaces them with a 0/0 line
  // instead of dropping them. De-whitelisting does NOT delete the row;
  // lifetime stats survive removal so historical posters keep their
  // standing.
  if (e.status) {
    await getOrCreateProposer(ctx, caches, e.account, block.height, ts)
  }

  caches.whitelistChanges.push(
    new WhitelistChange({
      id: eventId(log),
      addr: w,
      added: e.status,
      blockNumber: block.height,
      timestamp: ts,
      txHash: log.transactionHash,
    }),
  )
}

async function handleUpgraded(_ctx: Ctx, caches: Caches, log: Log): Promise<void> {
  const e = events.Upgraded.decode(log)
  const block = log.block
  caches.upgrades.push(
    new Upgrade({
      id: eventId(log),
      newImplementation: lc(e.implementation),
      blockNumber: block.height,
      timestamp: new Date(block.timestamp),
      txHash: log.transactionHash,
    }),
  )
}

async function handleOwnershipTransferred(
  _ctx: Ctx,
  caches: Caches,
  log: Log,
): Promise<void> {
  const e = events.OwnershipTransferred.decode(log)
  const block = log.block
  caches.ownershipChanges.push(
    new OwnershipChange({
      id: eventId(log),
      previousOwner: lc(e.previousOwner),
      newOwner: lc(e.newOwner),
      blockNumber: block.height,
      timestamp: new Date(block.timestamp),
      txHash: log.transactionHash,
    }),
  )
}

// --- batch entry point ---

processor.run(new TypeormDatabase({ supportHotBlocks: true }), async (ctx) => {
  const caches = newCaches()

  for (const block of ctx.blocks) {
    for (const log of block.logs) {
      if (lc(log.address) !== CONTRACT_ADDRESS) continue
      const topic0 = log.topics[0]

      switch (topic0) {
        case events.PostCreated.topic:
          await handlePostCreated(ctx, caches, log)
          break
        case events.Confirmed.topic:
          await handleConfirmed(ctx, caches, log)
          break
        case events.PostRemoved.topic:
          await handlePostRemoved(ctx, caches, log)
          break
        case events.PostPurged.topic:
          await handlePostPurged(ctx, caches, log)
          break
        case events.PostNoteAmended.topic:
          await handlePostNoteAmended(ctx, caches, log)
          break
        case events.PostTitleAmended.topic:
          await handlePostTitleAmended(ctx, caches, log)
          break
        case events.AttackersAdded.topic:
          await handleAttackersAdded(ctx, caches, log)
          break
        case events.VictimsAdded.topic:
          await handleVictimsAdded(ctx, caches, log)
          break
        case events.WhitelistUpdated.topic:
          await handleWhitelistUpdated(ctx, caches, log)
          break
        case events.Upgraded.topic:
          await handleUpgraded(ctx, caches, log)
          break
        case events.OwnershipTransferred.topic:
          await handleOwnershipTransferred(ctx, caches, log)
          break
        default:
          // ignore — could be Initialized / OwnershipTransferStarted / other
          // events not subscribed in processor.ts
          break
      }
    }
  }

  // Persist. Order matters: parents (Whitelister, Address, Post) before
  // children (PostAttacker, PostVictim, Confirmation, Edit) due to FK constraints.
  // Proposer has no FK dependencies on Post or Confirmation; safe to upsert
  // in either order, grouping with the other independent aggregates.
  await ctx.store.upsert([...caches.whitelisters.values()])
  await ctx.store.upsert([...caches.addresses.values()])
  await ctx.store.upsert([...caches.proposers.values()])
  await ctx.store.upsert([...caches.posts.values()])
  await ctx.store.upsert([...caches.postAttackers.values()])
  await ctx.store.upsert([...caches.postVictims.values()])
  await ctx.store.insert(caches.confirmationLog)
  await ctx.store.insert(caches.edits)
  await ctx.store.insert(caches.whitelistChanges)
  await ctx.store.insert(caches.upgrades)
  await ctx.store.insert(caches.ownershipChanges)
})
