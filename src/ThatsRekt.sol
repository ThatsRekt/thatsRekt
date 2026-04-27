// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title  ThatsRekt - On-chain hack-alert registry (v0)
/// @notice Whitelisted operators post structured alerts identifying attacker
///         addresses, victim contracts, and free-form context. Other whitelisters
///         vouch (upvote) or refute (downvote). Aggregates exposed as O(1) reads
///         so any contract can plug in and inline-blacklist.
/// @dev    Single immutable contract. Cross-chain identical-address deploy via
///         the singleton CREATE2 factory. See tasks/v0-impl-plan.md and the
///         design spec in DAMMfi-knowledge-base for the full architecture.
contract ThatsRekt is Ownable2Step {
    /*//////////////////////////////////////////////////////////////
                                 CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Hard cap on attackers.length + victims.length per post.
    uint256 public constant MAX_ADDRESSES_PER_POST = 32;

    /// @notice Pagination cap for view helpers (eth_call gas budget).
    uint256 public constant MAX_VIEW_LIMIT = 100;

    /*//////////////////////////////////////////////////////////////
                                   ENUMS
    //////////////////////////////////////////////////////////////*/

    /// @notice Direction of a voter's vote on a post.
    /// @dev    `None` is the zero value (default for unset mapping slots),
    ///         which lets `voteOf[postId][voter] == None` serve as the natural
    ///         "no vote yet" sentinel without an extra storage flag.
    enum VoteDirection { None, Upvote, Downvote }

    /*//////////////////////////////////////////////////////////////
                                  STRUCTS
    //////////////////////////////////////////////////////////////*/

    struct Post {
        address  poster;
        /// @dev Poster-supplied UTC second timestamp marking when the
        ///      on-chain attack itself happened (e.g. the malicious
        ///      transaction's block.timestamp). Distinct from the post
        ///      tx's block.timestamp — operator detection time is implicit
        ///      in the post tx and indexers already see it for free, so
        ///      this field carries the *attack* time as the informational
        ///      datum (not a tamper-proof one).
        uint64   attackedAt;
        uint32   upvotes;
        uint32   downvotes;
        bool     removed;
        address[] attackers;
        address[] victims;
    }

    /*//////////////////////////////////////////////////////////////
                                  STORAGE
    //////////////////////////////////////////////////////////////*/

    mapping(address => bool) public isWhitelisted;

    uint256 public postCount;
    mapping(uint256 => Post) private _posts;
    mapping(uint256 => mapping(address => VoteDirection)) public voteOf;

    mapping(address => int256)  public attackerScore;
    mapping(address => uint256) public attackerAppearances;

    mapping(address => bool)    public isVictim;
    mapping(address => uint256) private _victimActivePosts;

    uint256 public headPostId;
    uint256 public tailPostId;
    mapping(uint256 => uint256) public nextPostId;
    mapping(uint256 => uint256) public prevPostId;

    /*//////////////////////////////////////////////////////////////
                                  EVENTS
    //////////////////////////////////////////////////////////////*/

    event WhitelistUpdated(address indexed account, bool status);
    event PostCreated(
        uint256 indexed id,
        address indexed poster,
        uint64          attackedAt,
        address[]       attackers,
        address[]       victims,
        string          note
    );
    event Voted(
        uint256 indexed postId,
        address indexed voter,
        VoteDirection   oldDirection,
        VoteDirection   newDirection
    );

    /// @dev Single variant today; kept as an enum for forward extensibility
    ///      (e.g. owner-driven moderation) without ABI churn for indexers.
    enum RemovalReason { Retracted }
    event PostRemoved(uint256 indexed postId, RemovalReason reason);

    /*//////////////////////////////////////////////////////////////
                                  ERRORS
    //////////////////////////////////////////////////////////////*/

    error NotWhitelisted();
    error PosterCannotVote();
    error PostIsRemoved();
    error PostNotFound();
    error NoVoteChange();
    error EmptyPost();
    error PostTooLarge();
    error NotPoster();
    error InvalidAttackedAt();
    error InvalidVoteDirection();
    error NoVoteToRetract();

    /*//////////////////////////////////////////////////////////////
                                CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /// @param initialOwner The Safe multisig (or any contract / EOA) that will
    ///                     own the whitelist at deploy time. The owner role
    ///                     is fully transferable via the inherited Ownable2Step
    ///                     two-step flow (`transferOwnership` -> `acceptOwnership`),
    ///                     so the governance keys can be rotated freely. Reverts
    ///                     if zero (Ownable check).
    constructor(address initialOwner) Ownable(initialOwner) {}

    /*//////////////////////////////////////////////////////////////
                                MODIFIERS
    //////////////////////////////////////////////////////////////*/

    modifier onlyWhitelisted() {
        if (!isWhitelisted[msg.sender]) revert NotWhitelisted();
        _;
    }

    /*//////////////////////////////////////////////////////////////
                          OWNER (whitelist mgmt)
    //////////////////////////////////////////////////////////////*/

    function addWhitelisted(address account) external onlyOwner {
        if (!isWhitelisted[account]) {
            isWhitelisted[account] = true;
            emit WhitelistUpdated(account, true);
        }
    }

    function removeWhitelisted(address account) external onlyOwner {
        if (isWhitelisted[account]) {
            isWhitelisted[account] = false;
            emit WhitelistUpdated(account, false);
        }
    }

    /*//////////////////////////////////////////////////////////////
                          WHITELISTED (post + vote)
    //////////////////////////////////////////////////////////////*/

    /// @param attackedAt UTC second timestamp of the on-chain attack itself
    ///                   (e.g. the malicious transaction's block.timestamp).
    ///                   Must be > 0 and not in the future (relative to
    ///                   block.timestamp) — a hack cannot have happened
    ///                   after the post tx was mined. Operator detection
    ///                   time is implicit in the post tx's block.timestamp,
    ///                   already available to indexers for free, so it is
    ///                   not stored explicitly. Combined with the post's
    ///                   block timestamp this still gives an attack-to-post
    ///                   latency useful for operator reputation tracking
    ///                   and integrator signals.
    function post(
        address[] calldata attackers_,
        address[] calldata victims_,
        string   calldata note,
        uint64            attackedAt
    ) external onlyWhitelisted returns (uint256 id) {
        if (attackedAt == 0)                        revert InvalidAttackedAt();
        if (attackedAt > uint64(block.timestamp))   revert InvalidAttackedAt();

        uint256 totalAddrs = attackers_.length + victims_.length;
        if (totalAddrs > MAX_ADDRESSES_PER_POST) revert PostTooLarge();
        if (totalAddrs == 0 && bytes(note).length == 0) revert EmptyPost();

        unchecked { id = ++postCount; }

        Post storage p = _posts[id];
        p.poster     = msg.sender;
        p.attackedAt = attackedAt;

        uint256 aLen = attackers_.length;
        for (uint256 i; i < aLen; ++i) {
            p.attackers.push(attackers_[i]);
            unchecked { ++attackerAppearances[attackers_[i]]; }
        }
        uint256 vLen = victims_.length;
        for (uint256 i; i < vLen; ++i) {
            address v = victims_[i];
            p.victims.push(v);
            unchecked { ++_victimActivePosts[v]; }
            if (_victimActivePosts[v] == 1) isVictim[v] = true;
        }

        _insertActiveTail(id);

        emit PostCreated(id, msg.sender, attackedAt, attackers_, victims_, note);
    }

    function _insertActiveTail(uint256 id) internal {
        if (tailPostId == 0) {
            headPostId = id;
            tailPostId = id;
        } else {
            prevPostId[id]         = tailPostId;
            nextPostId[tailPostId] = id;
            tailPostId             = id;
        }
    }

    /// @notice Map a `VoteDirection` to its signed weight for aggregate math.
    /// @dev    Upvote -> +1, Downvote -> -1, None -> 0. Pure helper used to
    ///         compute deltas in `vote()` and reversal in `unvote()`.
    function _voteWeight(VoteDirection d) internal pure returns (int8) {
        if (d == VoteDirection.Upvote)   return int8(1);
        if (d == VoteDirection.Downvote) return int8(-1);
        return int8(0);
    }

    /// @param postId    Target post id.
    /// @param direction `Upvote` (+1) or `Downvote` (-1). `None` is rejected;
    ///                  use `unvote()` to clear an existing vote.
    /// @dev   `voteOf[postId][voter]` is `VoteDirection`, with `None` (= 0) as
    ///        the implicit "no vote yet" default. Callers can flip up<->down
    ///        via this entry point; clearing back to `None` lives on `unvote()`.
    function vote(uint256 postId, VoteDirection direction) external onlyWhitelisted {
        if (direction == VoteDirection.None) revert InvalidVoteDirection();

        Post storage p = _posts[postId];
        if (p.poster == address(0))   revert PostNotFound();
        if (p.removed)                revert PostIsRemoved();
        if (p.poster == msg.sender)   revert PosterCannotVote();

        VoteDirection oldDir = voteOf[postId][msg.sender];
        if (oldDir == direction)      revert NoVoteChange();

        if (oldDir == VoteDirection.Upvote)        { p.upvotes   -= 1; }
        else if (oldDir == VoteDirection.Downvote) { p.downvotes -= 1; }
        if (direction == VoteDirection.Upvote)     { p.upvotes   += 1; }
        else                                       { p.downvotes += 1; }

        int256 delta = int256(_voteWeight(direction)) - int256(_voteWeight(oldDir));

        uint256 aLen = p.attackers.length;
        for (uint256 i; i < aLen; ++i) {
            attackerScore[p.attackers[i]] += delta;
        }

        voteOf[postId][msg.sender] = direction;

        emit Voted(postId, msg.sender, oldDir, direction);
    }

    /// @notice Retract a previously cast vote on `postId`, restoring storage
    ///         to the "no vote" state and reversing the aggregate impact.
    /// @dev    Reverts if the caller never voted on this post (`NoVoteToRetract`),
    ///         if the post does not exist (`PostNotFound`), or if it has already
    ///         been removed (`PostIsRemoved`). Only whitelisters can call —
    ///         a de-whitelisted account cannot rewrite history.
    function unvote(uint256 postId) external onlyWhitelisted {
        Post storage p = _posts[postId];
        if (p.poster == address(0)) revert PostNotFound();
        if (p.removed)              revert PostIsRemoved();

        VoteDirection oldDir = voteOf[postId][msg.sender];
        if (oldDir == VoteDirection.None) revert NoVoteToRetract();

        // Reverse per-post counters.
        if (oldDir == VoteDirection.Upvote) { p.upvotes   -= 1; }
        else                                { p.downvotes -= 1; }

        // Reverse attacker aggregate score: subtract the old weight.
        int256 oldWeight = int256(_voteWeight(oldDir));
        uint256 aLen = p.attackers.length;
        for (uint256 i; i < aLen; ++i) {
            attackerScore[p.attackers[i]] -= oldWeight;
        }

        voteOf[postId][msg.sender] = VoteDirection.None;

        emit Voted(postId, msg.sender, oldDir, VoteDirection.None);
    }

    function _removePost(uint256 id, RemovalReason reason) internal {
        Post storage p = _posts[id];

        int256 net = int256(uint256(p.upvotes)) - int256(uint256(p.downvotes));

        // 1. reverse attacker aggregates
        uint256 aLen = p.attackers.length;
        for (uint256 i; i < aLen; ++i) {
            address a = p.attackers[i];
            attackerScore[a] -= net;
            unchecked { --attackerAppearances[a]; }
        }

        // 2. reverse victim aggregates
        uint256 vLen = p.victims.length;
        for (uint256 i; i < vLen; ++i) {
            address v = p.victims[i];
            unchecked { --_victimActivePosts[v]; }
            if (_victimActivePosts[v] == 0) isVictim[v] = false;
        }

        // 3. unlink from active-post linked list
        uint256 prev = prevPostId[id];
        uint256 next = nextPostId[id];
        if (prev != 0) nextPostId[prev] = next; else headPostId = next;
        if (next != 0) prevPostId[next] = prev; else tailPostId = prev;
        delete prevPostId[id];
        delete nextPostId[id];

        // 4. mark removed
        p.removed = true;

        emit PostRemoved(id, reason);
    }

    /*//////////////////////////////////////////////////////////////
                          POSTER (retract)
    //////////////////////////////////////////////////////////////*/

    function retract(uint256 postId) external {
        Post storage p = _posts[postId];
        if (p.poster == address(0))     revert PostNotFound();
        if (p.poster != msg.sender)     revert NotPoster();
        if (p.removed)                  revert PostIsRemoved();
        _removePost(postId, RemovalReason.Retracted);
    }

    /*//////////////////////////////////////////////////////////////
                                  READS
    //////////////////////////////////////////////////////////////*/

    function getPost(uint256 id) external view returns (
        address  poster,
        uint64   attackedAt,
        uint32   upvotes,
        uint32   downvotes,
        bool     removed,
        address[] memory attackers_,
        address[] memory victims_
    ) {
        Post storage p = _posts[id];
        if (p.poster == address(0)) revert PostNotFound();
        return (p.poster, p.attackedAt, p.upvotes, p.downvotes, p.removed, p.attackers, p.victims);
    }

    function attackerReport(address a) external view returns (int256 score, uint256 appearances) {
        return (attackerScore[a], attackerAppearances[a]);
    }

    function recentActivePosts(uint256 limit) external view returns (uint256[] memory ids) {
        if (limit > MAX_VIEW_LIMIT) limit = MAX_VIEW_LIMIT;
        uint256[] memory tmp = new uint256[](limit);
        uint256 cur = tailPostId;
        uint256 i;
        while (cur != 0 && i < limit) {
            tmp[i] = cur;
            cur = prevPostId[cur];
            unchecked { ++i; }
        }
        ids = new uint256[](i);
        for (uint256 j; j < i; ++j) ids[j] = tmp[j];
    }

    function activePostsBefore(uint256 beforeId, uint256 limit) external view returns (uint256[] memory ids) {
        Post storage anchor = _posts[beforeId];
        if (anchor.poster == address(0) || anchor.removed) revert PostNotFound();
        if (limit > MAX_VIEW_LIMIT) limit = MAX_VIEW_LIMIT;

        uint256[] memory tmp = new uint256[](limit);
        uint256 cur = prevPostId[beforeId];
        uint256 i;
        while (cur != 0 && i < limit) {
            tmp[i] = cur;
            cur = prevPostId[cur];
            unchecked { ++i; }
        }
        ids = new uint256[](i);
        for (uint256 j; j < i; ++j) ids[j] = tmp[j];
    }
}
