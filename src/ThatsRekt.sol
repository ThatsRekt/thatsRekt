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
                                  STRUCTS
    //////////////////////////////////////////////////////////////*/

    struct Post {
        address  poster;
        /// @dev Poster-supplied UTC second timestamp marking when the
        ///      operator detected the hack. Distinct from the block
        ///      timestamp (already implicit in event/tx metadata) — this
        ///      field is the informational datum, not a tamper-proof one.
        uint64   detectedAt;
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
    mapping(uint256 => mapping(address => int8)) public voteOf;

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
        uint64          detectedAt,
        address[]       attackers,
        address[]       victims,
        string          note
    );
    event Voted(
        uint256 indexed postId,
        address indexed voter,
        int8            oldDirection,
        int8            newDirection
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
    error InvalidDirection();
    error NoVoteChange();
    error EmptyPost();
    error PostTooLarge();
    error NotPoster();
    error InvalidDetectedAt();

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

    /// @param detectedAt UTC second timestamp the operator marks as the
    ///                   detection time of the hack. Must be > 0 and not
    ///                   in the future (relative to block.timestamp).
    ///                   Combined with the block timestamp this gives
    ///                   detection-to-post latency, useful for operator
    ///                   reputation tracking and integrator signals.
    function post(
        address[] calldata attackers_,
        address[] calldata victims_,
        string   calldata note,
        uint64            detectedAt
    ) external onlyWhitelisted returns (uint256 id) {
        if (detectedAt == 0)                        revert InvalidDetectedAt();
        if (detectedAt > uint64(block.timestamp))   revert InvalidDetectedAt();

        uint256 totalAddrs = attackers_.length + victims_.length;
        if (totalAddrs > MAX_ADDRESSES_PER_POST) revert PostTooLarge();
        if (totalAddrs == 0 && bytes(note).length == 0) revert EmptyPost();

        unchecked { id = ++postCount; }

        Post storage p = _posts[id];
        p.poster     = msg.sender;
        p.detectedAt = detectedAt;

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

        emit PostCreated(id, msg.sender, detectedAt, attackers_, victims_, note);
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

    function vote(uint256 postId, int8 direction) external onlyWhitelisted {
        if (direction < -1 || direction > 1) revert InvalidDirection();

        Post storage p = _posts[postId];
        if (p.poster == address(0))   revert PostNotFound();
        if (p.removed)                revert PostIsRemoved();
        if (p.poster == msg.sender)   revert PosterCannotVote();

        int8 oldDir = voteOf[postId][msg.sender];
        if (oldDir == direction)      revert NoVoteChange();

        if (oldDir == 1)        { p.upvotes   -= 1; }
        else if (oldDir == -1)  { p.downvotes -= 1; }
        if (direction == 1)     { p.upvotes   += 1; }
        else if (direction == -1) { p.downvotes += 1; }

        int256 delta = int256(direction) - int256(oldDir);

        uint256 aLen = p.attackers.length;
        for (uint256 i; i < aLen; ++i) {
            attackerScore[p.attackers[i]] += delta;
        }

        voteOf[postId][msg.sender] = direction;

        emit Voted(postId, msg.sender, oldDir, direction);
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
        uint64   detectedAt,
        uint32   upvotes,
        uint32   downvotes,
        bool     removed,
        address[] memory attackers_,
        address[] memory victims_
    ) {
        Post storage p = _posts[id];
        if (p.poster == address(0)) revert PostNotFound();
        return (p.poster, p.detectedAt, p.upvotes, p.downvotes, p.removed, p.attackers, p.victims);
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
