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
  postAttackers: Map<string, PostAttacker>
  postVictims: Map<string, PostVictim>
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
  postAttackers: new Map(),
  postVictims: new Map(),
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
  const existing = await ctx.store.get(Post, id)
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
    return undefined
  }
  const link = new PostAttacker({ id, post, address, createdAtBlock: blockNumber })
  caches.postAttackers.set(id, link)
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
    return undefined
  }
  const link = new PostVictim({ id, post, address, createdAtBlock: blockNumber })
  caches.postVictims.set(id, link)
  return link
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
    title: e.title,
    note: e.note,
    confirmations: 0,
    disconfirmations: 0,
    netScore: 0,
    removed: false,
    createdAtBlock: block.height,
    createdAtTimestamp: ts,
  })
  caches.posts.set(postId, post)

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

  // Maintain post.confirmations / post.disconfirmations counters per direction transition.
  if (oldDir === ConfirmDirection.Up) post.confirmations -= 1
  else if (oldDir === ConfirmDirection.Down) post.disconfirmations -= 1
  if (newDir === ConfirmDirection.Up) post.confirmations += 1
  else if (newDir === ConfirmDirection.Down) post.disconfirmations += 1
  post.netScore = post.confirmations - post.disconfirmations

  // Apply attacker score delta — load every attacker linked to this post.
  if (delta !== 0) {
    const links = await ctx.store.find(PostAttacker, {
      where: { post: { id: postId } },
      relations: { address: true },
    })
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
  if (post.removed) return  // idempotent

  post.removed = true
  post.removedAtBlock = block.height
  post.removedAtTimestamp = ts

  // Reverse aggregates: subtract current netScore from each listed attacker;
  // decrement victimActivePostCount for each listed victim.
  const attackerLinks = await ctx.store.find(PostAttacker, {
    where: { post: { id: postId } },
    relations: { address: true },
  })
  const netAtRemoval = BigInt(post.netScore)
  for (const link of attackerLinks) {
    const addrId = link.address.id
    const cached = caches.addresses.get(addrId) ?? link.address
    cached.attackerScore = cached.attackerScore - netAtRemoval
    caches.addresses.set(addrId, cached)
  }

  const victimLinks = await ctx.store.find(PostVictim, {
    where: { post: { id: postId } },
    relations: { address: true },
  })
  for (const link of victimLinks) {
    const addrId = link.address.id
    const cached = caches.addresses.get(addrId) ?? link.address
    cached.victimActivePostCount = Math.max(0, cached.victimActivePostCount - 1)
    cached.isVictim = cached.victimActivePostCount > 0
    caches.addresses.set(addrId, cached)
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
  post.note = e.newNote
  post.lastUpdatedAt = ts

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
  post.title = e.newTitle
  post.lastUpdatedAt = ts

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
  post.lastUpdatedAt = ts

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
  post.lastUpdatedAt = ts

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
  await ctx.store.upsert([...caches.whitelisters.values()])
  await ctx.store.upsert([...caches.addresses.values()])
  await ctx.store.upsert([...caches.posts.values()])
  await ctx.store.upsert([...caches.postAttackers.values()])
  await ctx.store.upsert([...caches.postVictims.values()])
  await ctx.store.insert(caches.confirmationLog)
  await ctx.store.insert(caches.edits)
  await ctx.store.insert(caches.whitelistChanges)
  await ctx.store.insert(caches.upgrades)
  await ctx.store.insert(caches.ownershipChanges)
})
