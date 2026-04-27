import * as p from '@subsquid/evm-codec'
import { event, fun, viewFun, indexed, ContractBase } from '@subsquid/evm-abi'
import type { EventParams as EParams, FunctionArguments, FunctionReturn } from '@subsquid/evm-abi'

export const events = {
    AttackersAdded: event("0x11e33fe659ce20067cdcc1c90a3b342aa497e29cfcb732a3eaddd3a2d3c39bb4", "AttackersAdded(uint256,address,address[])", {"postId": indexed(p.uint256), "amender": indexed(p.address), "newAttackers": p.array(p.address)}),
    Initialized: event("0xc7f505b2f371ae2175ee4913f4499e1f2633a7b5936321eed1cdaeb6115181d2", "Initialized(uint64)", {"version": p.uint64}),
    OwnershipTransferStarted: event("0x38d16b8cac22d99fc7c124b9cd0de2d3fa1faef420bfe791d8c362d765e22700", "OwnershipTransferStarted(address,address)", {"previousOwner": indexed(p.address), "newOwner": indexed(p.address)}),
    OwnershipTransferred: event("0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0", "OwnershipTransferred(address,address)", {"previousOwner": indexed(p.address), "newOwner": indexed(p.address)}),
    PostCreated: event("0xbd76475d0c0c57cc41fa7ef0d462fc48337bb4528731e970400088926f96337a", "PostCreated(uint256,address,uint64,address[],address[],string)", {"id": indexed(p.uint256), "poster": indexed(p.address), "attackedAt": p.uint64, "attackers": p.array(p.address), "victims": p.array(p.address), "note": p.string}),
    PostNoteAmended: event("0x6b4b6748b092a36f538b5d936f48f9e52910f5b77b05297c90560423a14bb25c", "PostNoteAmended(uint256,address,string)", {"postId": indexed(p.uint256), "amender": indexed(p.address), "newNote": p.string}),
    PostRemoved: event("0x5718ae2ef8a84a4ac1944e4db68da2c2f99b2367a583836f2032da026b358c80", "PostRemoved(uint256,uint8)", {"postId": indexed(p.uint256), "reason": p.uint8}),
    Upgraded: event("0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b", "Upgraded(address)", {"implementation": indexed(p.address)}),
    VictimsAdded: event("0x6bb42a267ffcd2d73693fdcf84c1f13c887f2d4dba77e9477c0c4123eae655c8", "VictimsAdded(uint256,address,address[])", {"postId": indexed(p.uint256), "amender": indexed(p.address), "newVictims": p.array(p.address)}),
    Voted: event("0x19adb7d3e13e2d662a94a50dfe0d354cd07a4f56f757fe2d58e8d188797b7703", "Voted(uint256,address,uint8,uint8)", {"postId": indexed(p.uint256), "voter": indexed(p.address), "oldDirection": p.uint8, "newDirection": p.uint8}),
    WhitelistUpdated: event("0xf93f9a76c1bf3444d22400a00cb9fe990e6abe9dbb333fda48859cfee864543d", "WhitelistUpdated(address,bool)", {"account": indexed(p.address), "status": p.bool}),
}

export const functions = {
    MAX_ADDRESSES_PER_POST: viewFun("0x22d4164d", "MAX_ADDRESSES_PER_POST()", {}, p.uint256),
    MAX_VIEW_LIMIT: viewFun("0x34fe4650", "MAX_VIEW_LIMIT()", {}, p.uint256),
    UPGRADE_INTERFACE_VERSION: viewFun("0xad3cb1cc", "UPGRADE_INTERFACE_VERSION()", {}, p.string),
    acceptOwnership: fun("0x79ba5097", "acceptOwnership()", {}, ),
    activePostsBefore: viewFun("0x17a1e54d", "activePostsBefore(uint256,uint256)", {"beforeId": p.uint256, "limit": p.uint256}, p.array(p.uint256)),
    addAttackers: fun("0x34d46b53", "addAttackers(uint256,address[])", {"postId": p.uint256, "newAttackers": p.array(p.address)}, ),
    addVictims: fun("0x17ada0b0", "addVictims(uint256,address[])", {"postId": p.uint256, "newVictims": p.array(p.address)}, ),
    addWhitelisted: fun("0x10154bad", "addWhitelisted(address)", {"account": p.address}, ),
    amendNote: fun("0x5ef7c714", "amendNote(uint256,string)", {"postId": p.uint256, "newNote": p.string}, ),
    attackerAppearances: viewFun("0x640c6395", "attackerAppearances(address)", {"_0": p.address}, p.uint256),
    attackerReport: viewFun("0x07363ce8", "attackerReport(address)", {"a": p.address}, {"score": p.int256, "appearances": p.uint256}),
    attackerScore: viewFun("0x6559e955", "attackerScore(address)", {"_0": p.address}, p.int256),
    getDownvoterCount: viewFun("0x0914f11d", "getDownvoterCount(uint256)", {"postId": p.uint256}, p.uint256),
    getDownvoters: viewFun("0x29b5b159", "getDownvoters(uint256)", {"postId": p.uint256}, p.array(p.address)),
    getPost: viewFun("0x40731c24", "getPost(uint256)", {"id": p.uint256}, {"poster": p.address, "attackedAt": p.uint64, "upvotes": p.uint32, "downvotes": p.uint32, "removed": p.bool, "attackers_": p.array(p.address), "victims_": p.array(p.address), "lastUpdatedAt": p.uint64}),
    getUpvoterCount: viewFun("0x34bead0c", "getUpvoterCount(uint256)", {"postId": p.uint256}, p.uint256),
    getUpvoters: viewFun("0xaa6ee29b", "getUpvoters(uint256)", {"postId": p.uint256}, p.array(p.address)),
    headPostId: viewFun("0xf93b72e1", "headPostId()", {}, p.uint256),
    initialize: fun("0xc4d66de8", "initialize(address)", {"initialOwner": p.address}, ),
    isVictim: viewFun("0x2d10cc3d", "isVictim(address)", {"_0": p.address}, p.bool),
    isWhitelisted: viewFun("0x3af32abf", "isWhitelisted(address)", {"_0": p.address}, p.bool),
    nextPostId: viewFun("0x932375e9", "nextPostId(uint256)", {"_0": p.uint256}, p.uint256),
    owner: viewFun("0x8da5cb5b", "owner()", {}, p.address),
    pendingOwner: viewFun("0xe30c3978", "pendingOwner()", {}, p.address),
    post: fun("0x1f4a01bb", "post(address[],address[],string,uint64)", {"attackers_": p.array(p.address), "victims_": p.array(p.address), "note": p.string, "attackedAt": p.uint64}, p.uint256),
    postCount: viewFun("0x17906c2e", "postCount()", {}, p.uint256),
    prevPostId: viewFun("0xe3c91286", "prevPostId(uint256)", {"_0": p.uint256}, p.uint256),
    proxiableUUID: viewFun("0x52d1902d", "proxiableUUID()", {}, p.bytes32),
    recentActivePosts: viewFun("0xccde89ce", "recentActivePosts(uint256)", {"limit": p.uint256}, p.array(p.uint256)),
    removeWhitelisted: fun("0x291d9549", "removeWhitelisted(address)", {"account": p.address}, ),
    renounceOwnership: fun("0x715018a6", "renounceOwnership()", {}, ),
    retract: fun("0x9fab6656", "retract(uint256)", {"postId": p.uint256}, ),
    tailPostId: viewFun("0x8094c914", "tailPostId()", {}, p.uint256),
    transferOwnership: fun("0xf2fde38b", "transferOwnership(address)", {"newOwner": p.address}, ),
    unvote: fun("0x51ec4285", "unvote(uint256)", {"postId": p.uint256}, ),
    upgradeToAndCall: fun("0x4f1ef286", "upgradeToAndCall(address,bytes)", {"newImplementation": p.address, "data": p.bytes}, ),
    vote: fun("0x943e8216", "vote(uint256,uint8)", {"postId": p.uint256, "direction": p.uint8}, ),
    voteOf: viewFun("0x45ddc85d", "voteOf(uint256,address)", {"_0": p.uint256, "_1": p.address}, p.uint8),
}

export class Contract extends ContractBase {

    MAX_ADDRESSES_PER_POST() {
        return this.eth_call(functions.MAX_ADDRESSES_PER_POST, {})
    }

    MAX_VIEW_LIMIT() {
        return this.eth_call(functions.MAX_VIEW_LIMIT, {})
    }

    UPGRADE_INTERFACE_VERSION() {
        return this.eth_call(functions.UPGRADE_INTERFACE_VERSION, {})
    }

    activePostsBefore(beforeId: ActivePostsBeforeParams["beforeId"], limit: ActivePostsBeforeParams["limit"]) {
        return this.eth_call(functions.activePostsBefore, {beforeId, limit})
    }

    attackerAppearances(_0: AttackerAppearancesParams["_0"]) {
        return this.eth_call(functions.attackerAppearances, {_0})
    }

    attackerReport(a: AttackerReportParams["a"]) {
        return this.eth_call(functions.attackerReport, {a})
    }

    attackerScore(_0: AttackerScoreParams["_0"]) {
        return this.eth_call(functions.attackerScore, {_0})
    }

    getDownvoterCount(postId: GetDownvoterCountParams["postId"]) {
        return this.eth_call(functions.getDownvoterCount, {postId})
    }

    getDownvoters(postId: GetDownvotersParams["postId"]) {
        return this.eth_call(functions.getDownvoters, {postId})
    }

    getPost(id: GetPostParams["id"]) {
        return this.eth_call(functions.getPost, {id})
    }

    getUpvoterCount(postId: GetUpvoterCountParams["postId"]) {
        return this.eth_call(functions.getUpvoterCount, {postId})
    }

    getUpvoters(postId: GetUpvotersParams["postId"]) {
        return this.eth_call(functions.getUpvoters, {postId})
    }

    headPostId() {
        return this.eth_call(functions.headPostId, {})
    }

    isVictim(_0: IsVictimParams["_0"]) {
        return this.eth_call(functions.isVictim, {_0})
    }

    isWhitelisted(_0: IsWhitelistedParams["_0"]) {
        return this.eth_call(functions.isWhitelisted, {_0})
    }

    nextPostId(_0: NextPostIdParams["_0"]) {
        return this.eth_call(functions.nextPostId, {_0})
    }

    owner() {
        return this.eth_call(functions.owner, {})
    }

    pendingOwner() {
        return this.eth_call(functions.pendingOwner, {})
    }

    postCount() {
        return this.eth_call(functions.postCount, {})
    }

    prevPostId(_0: PrevPostIdParams["_0"]) {
        return this.eth_call(functions.prevPostId, {_0})
    }

    proxiableUUID() {
        return this.eth_call(functions.proxiableUUID, {})
    }

    recentActivePosts(limit: RecentActivePostsParams["limit"]) {
        return this.eth_call(functions.recentActivePosts, {limit})
    }

    tailPostId() {
        return this.eth_call(functions.tailPostId, {})
    }

    voteOf(_0: VoteOfParams["_0"], _1: VoteOfParams["_1"]) {
        return this.eth_call(functions.voteOf, {_0, _1})
    }
}

/// Event types
export type AttackersAddedEventArgs = EParams<typeof events.AttackersAdded>
export type InitializedEventArgs = EParams<typeof events.Initialized>
export type OwnershipTransferStartedEventArgs = EParams<typeof events.OwnershipTransferStarted>
export type OwnershipTransferredEventArgs = EParams<typeof events.OwnershipTransferred>
export type PostCreatedEventArgs = EParams<typeof events.PostCreated>
export type PostNoteAmendedEventArgs = EParams<typeof events.PostNoteAmended>
export type PostRemovedEventArgs = EParams<typeof events.PostRemoved>
export type UpgradedEventArgs = EParams<typeof events.Upgraded>
export type VictimsAddedEventArgs = EParams<typeof events.VictimsAdded>
export type VotedEventArgs = EParams<typeof events.Voted>
export type WhitelistUpdatedEventArgs = EParams<typeof events.WhitelistUpdated>

/// Function types
export type MAX_ADDRESSES_PER_POSTParams = FunctionArguments<typeof functions.MAX_ADDRESSES_PER_POST>
export type MAX_ADDRESSES_PER_POSTReturn = FunctionReturn<typeof functions.MAX_ADDRESSES_PER_POST>

export type MAX_VIEW_LIMITParams = FunctionArguments<typeof functions.MAX_VIEW_LIMIT>
export type MAX_VIEW_LIMITReturn = FunctionReturn<typeof functions.MAX_VIEW_LIMIT>

export type UPGRADE_INTERFACE_VERSIONParams = FunctionArguments<typeof functions.UPGRADE_INTERFACE_VERSION>
export type UPGRADE_INTERFACE_VERSIONReturn = FunctionReturn<typeof functions.UPGRADE_INTERFACE_VERSION>

export type AcceptOwnershipParams = FunctionArguments<typeof functions.acceptOwnership>
export type AcceptOwnershipReturn = FunctionReturn<typeof functions.acceptOwnership>

export type ActivePostsBeforeParams = FunctionArguments<typeof functions.activePostsBefore>
export type ActivePostsBeforeReturn = FunctionReturn<typeof functions.activePostsBefore>

export type AddAttackersParams = FunctionArguments<typeof functions.addAttackers>
export type AddAttackersReturn = FunctionReturn<typeof functions.addAttackers>

export type AddVictimsParams = FunctionArguments<typeof functions.addVictims>
export type AddVictimsReturn = FunctionReturn<typeof functions.addVictims>

export type AddWhitelistedParams = FunctionArguments<typeof functions.addWhitelisted>
export type AddWhitelistedReturn = FunctionReturn<typeof functions.addWhitelisted>

export type AmendNoteParams = FunctionArguments<typeof functions.amendNote>
export type AmendNoteReturn = FunctionReturn<typeof functions.amendNote>

export type AttackerAppearancesParams = FunctionArguments<typeof functions.attackerAppearances>
export type AttackerAppearancesReturn = FunctionReturn<typeof functions.attackerAppearances>

export type AttackerReportParams = FunctionArguments<typeof functions.attackerReport>
export type AttackerReportReturn = FunctionReturn<typeof functions.attackerReport>

export type AttackerScoreParams = FunctionArguments<typeof functions.attackerScore>
export type AttackerScoreReturn = FunctionReturn<typeof functions.attackerScore>

export type GetDownvoterCountParams = FunctionArguments<typeof functions.getDownvoterCount>
export type GetDownvoterCountReturn = FunctionReturn<typeof functions.getDownvoterCount>

export type GetDownvotersParams = FunctionArguments<typeof functions.getDownvoters>
export type GetDownvotersReturn = FunctionReturn<typeof functions.getDownvoters>

export type GetPostParams = FunctionArguments<typeof functions.getPost>
export type GetPostReturn = FunctionReturn<typeof functions.getPost>

export type GetUpvoterCountParams = FunctionArguments<typeof functions.getUpvoterCount>
export type GetUpvoterCountReturn = FunctionReturn<typeof functions.getUpvoterCount>

export type GetUpvotersParams = FunctionArguments<typeof functions.getUpvoters>
export type GetUpvotersReturn = FunctionReturn<typeof functions.getUpvoters>

export type HeadPostIdParams = FunctionArguments<typeof functions.headPostId>
export type HeadPostIdReturn = FunctionReturn<typeof functions.headPostId>

export type InitializeParams = FunctionArguments<typeof functions.initialize>
export type InitializeReturn = FunctionReturn<typeof functions.initialize>

export type IsVictimParams = FunctionArguments<typeof functions.isVictim>
export type IsVictimReturn = FunctionReturn<typeof functions.isVictim>

export type IsWhitelistedParams = FunctionArguments<typeof functions.isWhitelisted>
export type IsWhitelistedReturn = FunctionReturn<typeof functions.isWhitelisted>

export type NextPostIdParams = FunctionArguments<typeof functions.nextPostId>
export type NextPostIdReturn = FunctionReturn<typeof functions.nextPostId>

export type OwnerParams = FunctionArguments<typeof functions.owner>
export type OwnerReturn = FunctionReturn<typeof functions.owner>

export type PendingOwnerParams = FunctionArguments<typeof functions.pendingOwner>
export type PendingOwnerReturn = FunctionReturn<typeof functions.pendingOwner>

export type PostParams = FunctionArguments<typeof functions.post>
export type PostReturn = FunctionReturn<typeof functions.post>

export type PostCountParams = FunctionArguments<typeof functions.postCount>
export type PostCountReturn = FunctionReturn<typeof functions.postCount>

export type PrevPostIdParams = FunctionArguments<typeof functions.prevPostId>
export type PrevPostIdReturn = FunctionReturn<typeof functions.prevPostId>

export type ProxiableUUIDParams = FunctionArguments<typeof functions.proxiableUUID>
export type ProxiableUUIDReturn = FunctionReturn<typeof functions.proxiableUUID>

export type RecentActivePostsParams = FunctionArguments<typeof functions.recentActivePosts>
export type RecentActivePostsReturn = FunctionReturn<typeof functions.recentActivePosts>

export type RemoveWhitelistedParams = FunctionArguments<typeof functions.removeWhitelisted>
export type RemoveWhitelistedReturn = FunctionReturn<typeof functions.removeWhitelisted>

export type RenounceOwnershipParams = FunctionArguments<typeof functions.renounceOwnership>
export type RenounceOwnershipReturn = FunctionReturn<typeof functions.renounceOwnership>

export type RetractParams = FunctionArguments<typeof functions.retract>
export type RetractReturn = FunctionReturn<typeof functions.retract>

export type TailPostIdParams = FunctionArguments<typeof functions.tailPostId>
export type TailPostIdReturn = FunctionReturn<typeof functions.tailPostId>

export type TransferOwnershipParams = FunctionArguments<typeof functions.transferOwnership>
export type TransferOwnershipReturn = FunctionReturn<typeof functions.transferOwnership>

export type UnvoteParams = FunctionArguments<typeof functions.unvote>
export type UnvoteReturn = FunctionReturn<typeof functions.unvote>

export type UpgradeToAndCallParams = FunctionArguments<typeof functions.upgradeToAndCall>
export type UpgradeToAndCallReturn = FunctionReturn<typeof functions.upgradeToAndCall>

export type VoteParams = FunctionArguments<typeof functions.vote>
export type VoteReturn = FunctionReturn<typeof functions.vote>

export type VoteOfParams = FunctionArguments<typeof functions.voteOf>
export type VoteOfReturn = FunctionReturn<typeof functions.voteOf>

