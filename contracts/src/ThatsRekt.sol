// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/// @title  ThatsRekt - On-chain hack-alert registry (v1)
/// @notice Whitelisted operators post structured alerts identifying attacker
///         addresses, victim contracts, and free-form context. Other whitelisters
///         confirm (up) or disconfirm (down) the alert — saying "I agree this
///         is real" or "I think this is wrong". Aggregates exposed as O(1) reads
///         so any contract can plug in and inline-blacklist.
/// @dev    UUPS upgradeable. The implementation lives behind an ERC1967Proxy;
///         the proxy is the canonical permanent address (cross-chain identical
///         via CREATE2 with a constant salt).
///
///         Two-tier governance:
///           - `owner` (TimelockController in prod): controls upgrades and
///             rotation of the whitelist admin. Every `owner` call is
///             timelock-gated (7-day delay).
///           - `whitelistAdmin` (multisig in prod): adds/removes whitelisted
///             posters directly, no delay. Posters need to be kickable
///             immediately when an incident demands it.
///
///         The owner can revoke the whitelist admin role via
///         `setWhitelistAdmin`, which is itself timelock-gated — so a
///         compromised whitelist admin can be rotated out, but only after
///         the standard 7-day disengage window for integrators.
contract ThatsRekt is Initializable, Ownable2StepUpgradeable, UUPSUpgradeable {
    using EnumerableSet for EnumerableSet.AddressSet;

    /*//////////////////////////////////////////////////////////////
                                 CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Hard cap on attackers.length + victims.length per post.
    /// @dev Sized to accommodate large multi-wallet investigations
    ///      (e.g. attacker wallets + victim contracts across protocol legs)
    ///      while staying within a single tx's gas budget on every supported
    ///      chain — even at the max-size 100/100 boundary the cost is bounded.
    uint256 public constant MAX_ADDRESSES_PER_POST = 100;

    /// @notice Hard cap on a post's title length, in bytes.
    /// @dev    UTF-8 byte count, not character count — a string of e.g.
    ///         emoji will hit the cap sooner than a string of ASCII.
    ///         Sized to keep titles headline-shaped (≈40-50 chars of
    ///         English plus headroom for non-ASCII). Title is required;
    ///         see `post()` and `amendTitle()`.
    uint256 public constant MAX_TITLE_LENGTH = 200;

    /// @notice Pagination cap for view helpers (eth_call gas budget).
    uint256 public constant MAX_VIEW_LIMIT = 100;

    /*//////////////////////////////////////////////////////////////
                                   ENUMS
    //////////////////////////////////////////////////////////////*/

    /// @notice Direction of a confirmer's signal on a post.
    /// @dev    `None` is the zero value (default for unset mapping slots),
    ///         which lets `confirmationOf[postId][confirmer] == None` serve as
    ///         the natural "no confirmation yet" sentinel without an extra
    ///         storage flag. `Up` means "I agree this is a real incident",
    ///         `Down` means "I think this is wrong / not real".
    enum ConfirmDirection { None, Up, Down }

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
        uint32   confirmations;
        uint32   disconfirmations;
        bool     removed;
        /// @dev Block-time freshness signal. Set to `block.timestamp` at
        ///      post creation and bumped on every poster-driven edit
        ///      (`amendNote`, `addAttackers`, `addVictims`). Indexers and
        ///      consumers can use this to surface "recently edited" posts
        ///      without scanning the event log. Packs into the same storage
        ///      slot as `disconfirmations` (u32) + `removed` (bool) + this u64.
        uint64   lastUpdatedAt;
        address[] attackers;
        address[] victims;
    }

    /*//////////////////////////////////////////////////////////////
                                  STORAGE
    //////////////////////////////////////////////////////////////*/

    mapping(address => bool) public isWhitelisted;

    /// @notice Address authorized to add/remove whitelisters directly,
    ///         without going through the timelock. The multisig holds
    ///         this role in production so posters can be added or
    ///         removed instantly when an incident demands it.
    /// @dev    Set on initialize; rotated via `setWhitelistAdmin`,
    ///         which is `onlyOwner` and therefore still gated by the
    ///         7-day timelock — integrators retain a week to disengage
    ///         if governance moves whitelist authority somewhere
    ///         hostile. The role itself is single-step (not 2-step)
    ///         because it carries no upgrade authority; only the
    ///         OwnableUpgradeable owner controls upgrades.
    address public whitelistAdmin;

    uint256 public postCount;
    mapping(uint256 => Post) private _posts;
    mapping(uint256 => mapping(address => ConfirmDirection)) public confirmationOf;

    /// @dev Per-post enumerable confirmer sets. Kept in lockstep with the
    ///      `confirmationOf` mapping and the per-post `confirmations`/`disconfirmations` counters
    ///      via `_applyConfirmerSetChange`. Exposed through `getConfirmers` /
    ///      `getDisconfirmers` so consumers can answer "who confirmed this post?"
    ///      on-chain — useful when integrators want to gate on a trusted
    ///      subset of whitelisters rather than the raw aggregate score.
    mapping(uint256 => EnumerableSet.AddressSet) private _confirmers;
    mapping(uint256 => EnumerableSet.AddressSet) private _disconfirmers;

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
    event WhitelistAdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    event PostCreated(
        uint256 indexed id,
        address indexed poster,
        uint64          attackedAt,
        string          title,
        address[]       attackers,
        address[]       victims,
        string          note
    );
    event Confirmed(
        uint256 indexed postId,
        address indexed confirmer,
        ConfirmDirection   oldDirection,
        ConfirmDirection   newDirection
    );

    /// @dev Single variant today; kept as an enum for forward extensibility
    ///      (e.g. owner-driven moderation) without ABI churn for indexers.
    enum RemovalReason { Retracted }
    event PostRemoved(uint256 indexed postId, RemovalReason reason);

    /// @notice Emitted when the poster amends a post's free-form note.
    /// @dev    Notes are intentionally not in storage — they live entirely
    ///         in the event log (originally `PostCreated`, now also this
    ///         event). The on-chain `lastUpdatedAt` field is bumped as a
    ///         side effect. `lastUpdatedAt` is *not* in this event's
    ///         params: it is implicitly equal to `block.timestamp` of the
    ///         emit, so duplicating it would be dead weight for indexers.
    event PostNoteAmended(uint256 indexed postId, address indexed amender, string newNote);

    /// @notice Emitted when the poster amends a post's title.
    /// @dev    Title IS in storage (`_postTitles[postId]`) — it is a
    ///         required headline integrators may want to read on-chain,
    ///         distinct from the longer-form `note` which only lives in
    ///         events. `lastUpdatedAt` is bumped as a side effect.
    event PostTitleAmended(uint256 indexed postId, address indexed amender, string newTitle);

    /// @notice Emitted when the poster appends new attackers to a post.
    /// @dev    `lastUpdatedAt` is omitted (deducible from `block.timestamp`).
    event AttackersAdded(uint256 indexed postId, address indexed amender, address[] newAttackers);

    /// @notice Emitted when the poster appends new victims to a post.
    /// @dev    `lastUpdatedAt` is omitted (deducible from `block.timestamp`).
    event VictimsAdded(uint256 indexed postId, address indexed amender, address[] newVictims);

    /*//////////////////////////////////////////////////////////////
                                  ERRORS
    //////////////////////////////////////////////////////////////*/

    error NotWhitelisted();
    error NotWhitelistAdmin();
    error PosterCannotConfirm();
    error PostIsRemoved();
    error PostNotFound();
    error NoConfirmationChange();
    error EmptyPost();
    error PostTooLarge();
    error NotPoster();
    error InvalidAttackedAt();
    error InvalidConfirmDirection();
    error NothingToUnconfirm();
    error EmptyAdditions();
    error DuplicateAddress();
    error ZeroAddress();
    error TitleEmpty();
    error TitleTooLong();

    /*//////////////////////////////////////////////////////////////
                          CONSTRUCTOR / INITIALIZER
    //////////////////////////////////////////////////////////////*/

    /// @dev    The implementation contract is never initialized — only the
    ///         proxy is. Calling `_disableInitializers()` here permanently
    ///         locks `initialize` against direct invocation on the impl,
    ///         which would otherwise be a foothold for taking over the
    ///         logic contract's owner slot.
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Proxy entry point. Sets the initial owner (upgrade
    ///         authority, gated by the timelock in production) and the
    ///         initial whitelist admin (multisig in production —
    ///         instant whitelist mutations, no delay).
    /// @param  initialOwner Holds upgrade authority on the proxy.
    ///                      Production deploys set this to a
    ///                      TimelockController. Reverts on
    ///                      `address(0)` via OwnableUpgradeable.
    /// @param  initialWhitelistAdmin Holds direct add/remove authority
    ///                      over the whitelist. Production deploys set
    ///                      this to the multisig. Cannot be zero.
    /// @dev    Idempotency is enforced by `Initializable` — re-calling
    ///         `initialize` on an already-initialized proxy reverts with
    ///         `InvalidInitialization()`. The owner role is fully
    ///         transferable via the inherited Ownable2Step two-step flow
    ///         (`transferOwnership` -> `acceptOwnership`); the
    ///         whitelistAdmin role is rotated via the
    ///         single-step `setWhitelistAdmin` (also onlyOwner).
    function initialize(
        address initialOwner,
        address initialWhitelistAdmin
    ) external initializer {
        if (initialWhitelistAdmin == address(0)) revert ZeroAddress();
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        // UUPSUpgradeable has no `__UUPSUpgradeable_init` in OZ 5.x — it
        // holds no state, so there is nothing to wire up here. The
        // upgrade authority is enforced solely by `_authorizeUpgrade`.
        whitelistAdmin = initialWhitelistAdmin;
        emit WhitelistAdminTransferred(address(0), initialWhitelistAdmin);
    }

    /// @notice UUPS upgrade authorization hook. Only the owner (i.e. the
    ///         TimelockController in production) can install a new impl.
    /// @dev    Empty body — the `onlyOwner` modifier is the entire policy.
    ///         The OZ `UUPSUpgradeable.upgradeToAndCall` entry point is
    ///         what callers actually invoke; this hook just gates it.
    function _authorizeUpgrade(address /* newImplementation */) internal override onlyOwner {}

    /*//////////////////////////////////////////////////////////////
                                MODIFIERS
    //////////////////////////////////////////////////////////////*/

    modifier onlyWhitelisted() {
        if (!isWhitelisted[msg.sender]) revert NotWhitelisted();
        _;
    }

    modifier onlyWhitelistAdmin() {
        if (msg.sender != whitelistAdmin) revert NotWhitelistAdmin();
        _;
    }

    /*//////////////////////////////////////////////////////////////
                       OWNER (governance role rotation)
    //////////////////////////////////////////////////////////////*/

    /// @notice Rotate the whitelist admin role. Only callable by the
    ///         proxy owner — in production that's the
    ///         TimelockController, so this rotation is gated by the
    ///         7-day delay. Integrators retain the same disengage
    ///         window they have on upgrades.
    /// @param  newAdmin New holder of the whitelist admin role.
    ///                  Cannot be zero (use a paused-multisig pattern
    ///                  if you want to effectively suspend posting).
    function setWhitelistAdmin(address newAdmin) external onlyOwner {
        if (newAdmin == address(0)) revert ZeroAddress();
        address prev = whitelistAdmin;
        whitelistAdmin = newAdmin;
        emit WhitelistAdminTransferred(prev, newAdmin);
    }

    /*//////////////////////////////////////////////////////////////
                     WHITELIST ADMIN (instant whitelist mgmt)
    //////////////////////////////////////////////////////////////*/

    /// @notice Add an address to the whitelist of authorized posters.
    ///         Direct call from `whitelistAdmin` — no timelock delay.
    function addWhitelisted(address account) external onlyWhitelistAdmin {
        if (!isWhitelisted[account]) {
            isWhitelisted[account] = true;
            emit WhitelistUpdated(account, true);
        }
    }

    /// @notice Remove an address from the whitelist of authorized
    ///         posters. Direct call from `whitelistAdmin` — no
    ///         timelock delay, so a misbehaving poster can be kicked
    ///         immediately.
    function removeWhitelisted(address account) external onlyWhitelistAdmin {
        if (isWhitelisted[account]) {
            isWhitelisted[account] = false;
            emit WhitelistUpdated(account, false);
        }
    }

    /*//////////////////////////////////////////////////////////////
                          WHITELISTED (post + confirm)
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
        string   calldata title,
        address[] calldata attackers_,
        address[] calldata victims_,
        string   calldata note,
        uint64            attackedAt
    ) external onlyWhitelisted returns (uint256 id) {
        // Title is required and bounded — see MAX_TITLE_LENGTH.
        uint256 titleLen = bytes(title).length;
        if (titleLen == 0)                          revert TitleEmpty();
        if (titleLen > MAX_TITLE_LENGTH)            revert TitleTooLong();

        if (attackedAt == 0)                        revert InvalidAttackedAt();
        if (attackedAt > uint64(block.timestamp))   revert InvalidAttackedAt();

        uint256 totalAddrs = attackers_.length + victims_.length;
        if (totalAddrs > MAX_ADDRESSES_PER_POST) revert PostTooLarge();
        // Title is required, so a post is never "empty" in v1.1 — but the
        // intent of `EmptyPost` was to forbid zero-content posts. With
        // title required, a post with no addresses and no note is still a
        // pure-headline alert, which is acceptable. Drop the legacy check.

        unchecked { id = ++postCount; }

        Post storage p = _posts[id];
        p.poster        = msg.sender;
        p.attackedAt    = attackedAt;
        p.lastUpdatedAt = uint64(block.timestamp);

        // Title goes in storage so it's readable on-chain without an indexer.
        postTitle[id] = title;

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

        emit PostCreated(id, msg.sender, attackedAt, title, attackers_, victims_, note);
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

    /// @notice Map a `ConfirmDirection` to its signed weight for aggregate math.
    /// @dev    Up -> +1, Down -> -1, None -> 0. Pure helper used to
    ///         compute deltas in `confirm()` and reversal in `unconfirm()`.
    function _directionWeight(ConfirmDirection d) internal pure returns (int8) {
        if (d == ConfirmDirection.Up)   return int8(1);
        if (d == ConfirmDirection.Down) return int8(-1);
        return int8(0);
    }

    /// @notice Keep the per-post confirmer/disconfirmer sets in sync with a confirmation
    ///         transition (`oldDir -> newDir`).
    /// @dev    Removes the confirmer from the set matching `oldDir` (if any) and
    ///         adds them to the set matching `newDir` (if any). `None` slots
    ///         on either side are no-ops, which makes this helper correct for
    ///         fresh confirmations, flips, and unconfirms alike.
    function _applyConfirmerSetChange(
        uint256 postId,
        address confirmer,
        ConfirmDirection oldDir,
        ConfirmDirection newDir
    ) internal {
        if (oldDir == ConfirmDirection.Up)        _confirmers[postId].remove(confirmer);
        else if (oldDir == ConfirmDirection.Down) _disconfirmers[postId].remove(confirmer);

        if (newDir == ConfirmDirection.Up)        _confirmers[postId].add(confirmer);
        else if (newDir == ConfirmDirection.Down) _disconfirmers[postId].add(confirmer);
    }

    /// @param postId    Target post id.
    /// @param direction `Up` (+1) or `Down` (-1). `None` is rejected;
    ///                  use `unconfirm()` to clear an existing confirmation.
    /// @dev   `confirmationOf[postId][confirmer]` is `ConfirmDirection`, with `None` (= 0) as
    ///        the implicit "no confirmation yet" default. Callers can flip up<->down
    ///        via this entry point; clearing back to `None` lives on `unconfirm()`.
    function confirm(uint256 postId, ConfirmDirection direction) external onlyWhitelisted {
        if (direction == ConfirmDirection.None) revert InvalidConfirmDirection();

        Post storage p = _posts[postId];
        if (p.poster == address(0))   revert PostNotFound();
        if (p.removed)                revert PostIsRemoved();
        if (p.poster == msg.sender)   revert PosterCannotConfirm();

        ConfirmDirection oldDir = confirmationOf[postId][msg.sender];
        if (oldDir == direction)      revert NoConfirmationChange();

        if (oldDir == ConfirmDirection.Up)        { p.confirmations   -= 1; }
        else if (oldDir == ConfirmDirection.Down) { p.disconfirmations -= 1; }
        if (direction == ConfirmDirection.Up)     { p.confirmations   += 1; }
        else                                       { p.disconfirmations += 1; }

        int256 delta = int256(_directionWeight(direction)) - int256(_directionWeight(oldDir));

        uint256 aLen = p.attackers.length;
        for (uint256 i; i < aLen; ++i) {
            attackerScore[p.attackers[i]] += delta;
        }

        confirmationOf[postId][msg.sender] = direction;
        _applyConfirmerSetChange(postId, msg.sender, oldDir, direction);

        emit Confirmed(postId, msg.sender, oldDir, direction);
    }

    /// @notice Clear a previously cast confirmation on `postId`, restoring storage
    ///         to the "no confirmation" state and reversing the aggregate impact.
    /// @dev    Reverts if the caller never confirmed on this post (`NothingToUnconfirm`),
    ///         if the post does not exist (`PostNotFound`), or if it has already
    ///         been removed (`PostIsRemoved`). Only whitelisters can call —
    ///         a de-whitelisted account cannot rewrite history.
    function unconfirm(uint256 postId) external onlyWhitelisted {
        Post storage p = _posts[postId];
        if (p.poster == address(0)) revert PostNotFound();
        if (p.removed)              revert PostIsRemoved();

        ConfirmDirection oldDir = confirmationOf[postId][msg.sender];
        if (oldDir == ConfirmDirection.None) revert NothingToUnconfirm();

        // Reverse per-post counters.
        if (oldDir == ConfirmDirection.Up) { p.confirmations   -= 1; }
        else                                { p.disconfirmations -= 1; }

        // Reverse attacker aggregate score: subtract the old weight.
        int256 oldWeight = int256(_directionWeight(oldDir));
        uint256 aLen = p.attackers.length;
        for (uint256 i; i < aLen; ++i) {
            attackerScore[p.attackers[i]] -= oldWeight;
        }

        confirmationOf[postId][msg.sender] = ConfirmDirection.None;
        _applyConfirmerSetChange(postId, msg.sender, oldDir, ConfirmDirection.None);

        emit Confirmed(postId, msg.sender, oldDir, ConfirmDirection.None);
    }

    function _removePost(uint256 id, RemovalReason reason) internal {
        Post storage p = _posts[id];

        int256 net = int256(uint256(p.confirmations)) - int256(uint256(p.disconfirmations));

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
                          POSTER (edits)
    //////////////////////////////////////////////////////////////*/

    /// @notice Amend the free-form note of a post the caller authored.
    /// @dev    Notes never lived in storage (event-only design from v0):
    ///         the new note is emitted in `PostNoteAmended` rather than
    ///         written. The only on-chain side effect is bumping
    ///         `lastUpdatedAt` so consumers can surface "recently
    ///         amended" posts without scanning logs.
    ///
    ///         Address arrays are *not* mutable via this entry point —
    ///         additive-only edits live on `addAttackers` / `addVictims`,
    ///         and removal is fundamentally not supported (anti
    ///         bait-and-switch). Posters who need to change addresses
    ///         must `retract()` and re-post.
    /// @param postId  Target post id (must exist and be live).
    /// @param newNote New note contents. Empty string is allowed —
    ///                clearing context is a legitimate amend.
    function amendNote(uint256 postId, string calldata newNote) external onlyWhitelisted {
        Post storage p = _posts[postId];
        if (p.poster == address(0))   revert PostNotFound();
        if (p.poster != msg.sender)   revert NotPoster();
        if (p.removed)                revert PostIsRemoved();

        p.lastUpdatedAt = uint64(block.timestamp);

        emit PostNoteAmended(postId, msg.sender, newNote);
    }

    /// @notice Update the title of an existing post. Poster only, not
    ///         allowed once the post is removed.
    /// @dev    Title remains required — empty strings are rejected even
    ///         on amendment. Length cap matches `post()`.
    /// @param postId   Target post id (must exist and be live).
    /// @param newTitle New title (required, ≤ MAX_TITLE_LENGTH bytes).
    function amendTitle(uint256 postId, string calldata newTitle) external onlyWhitelisted {
        Post storage p = _posts[postId];
        if (p.poster == address(0))   revert PostNotFound();
        if (p.poster != msg.sender)   revert NotPoster();
        if (p.removed)                revert PostIsRemoved();

        uint256 titleLen = bytes(newTitle).length;
        if (titleLen == 0)            revert TitleEmpty();
        if (titleLen > MAX_TITLE_LENGTH) revert TitleTooLong();

        postTitle[postId] = newTitle;
        p.lastUpdatedAt = uint64(block.timestamp);

        emit PostTitleAmended(postId, msg.sender, newTitle);
    }

    /// @notice Append new attackers to an existing post. Additive only —
    ///         attackers cannot be removed via any path other than
    ///         `retract()` + re-post.
    /// @dev    Each new attacker inherits the post's *current* net karma
    ///         (`confirmations - disconfirmations`) at the moment of addition. From
    ///         that point on, subsequent confirmations / unconfirms update all
    ///         listed attackers (original + newly added) uniformly,
    ///         preserving v1's single-aggregate model.
    ///
    ///         Bait-and-switch resistance: the additive-only design means
    ///         a poster cannot swap an innocent address into a karma-laden
    ///         post. They CAN add a fresh address that inherits karma —
    ///         that's a known and intentional limit (mitigated by
    ///         disconfirmations from peers if the addition looks bogus).
    ///
    ///         Strict no-duplicates: rejects (a) duplicates within the
    ///         input batch, (b) addresses already in the post's attacker
    ///         array, and (c) addresses already in the post's victim
    ///         array. Asymmetric with `post()` (which permits intra-post
    ///         duplicates for legacy reasons) — by the time we're in v1
    ///         edit territory, we have the chance to enforce a cleaner
    ///         invariant on the additive path.
    /// @param postId        Target post id.
    /// @param newAttackers  Non-empty array of unique, non-zero addresses.
    function addAttackers(uint256 postId, address[] calldata newAttackers) external onlyWhitelisted {
        Post storage p = _posts[postId];
        if (p.poster == address(0))   revert PostNotFound();
        if (p.poster != msg.sender)   revert NotPoster();
        if (p.removed)                revert PostIsRemoved();
        if (newAttackers.length == 0) revert EmptyAdditions();
        // Cap is total addresses (attackers + victims), matching `post()`.
        // Checking only one array would let the post grow past the cap by
        // unbalancing the split.
        if (p.attackers.length + p.victims.length + newAttackers.length > MAX_ADDRESSES_PER_POST) {
            revert PostTooLarge();
        }

        int256 currentNet = int256(uint256(p.confirmations)) - int256(uint256(p.disconfirmations));

        uint256 nNew = newAttackers.length;
        for (uint256 i; i < nNew; ++i) {
            address a = newAttackers[i];
            if (a == address(0)) revert ZeroAddress();
            _requireNotInPost(p, a);
            _requireNotInBatch(newAttackers, i, a);

            p.attackers.push(a);
            attackerScore[a]   += currentNet;
            unchecked { ++attackerAppearances[a]; }
        }

        p.lastUpdatedAt = uint64(block.timestamp);

        emit AttackersAdded(postId, msg.sender, newAttackers);
    }

    /// @notice Append new victims to an existing post. Additive only —
    ///         victims cannot be removed via any path other than
    ///         `retract()` + re-post.
    /// @dev    Mirrors `addAttackers` semantics: same authz, same
    ///         lifecycle checks, same strict no-duplicate rules across
    ///         (input batch | attacker array | victim array). Victims
    ///         do not have a karma aggregate, so the per-victim side
    ///         effect is purely the `_victimActivePosts` increment and
    ///         `isVictim[v] = true` flip on first inclusion.
    /// @param postId      Target post id.
    /// @param newVictims  Non-empty array of unique, non-zero addresses.
    function addVictims(uint256 postId, address[] calldata newVictims) external onlyWhitelisted {
        Post storage p = _posts[postId];
        if (p.poster == address(0))   revert PostNotFound();
        if (p.poster != msg.sender)   revert NotPoster();
        if (p.removed)                revert PostIsRemoved();
        if (newVictims.length == 0)   revert EmptyAdditions();
        // Cap is total addresses across both arrays — see `addAttackers`.
        if (p.attackers.length + p.victims.length + newVictims.length > MAX_ADDRESSES_PER_POST) {
            revert PostTooLarge();
        }

        uint256 nNew = newVictims.length;
        for (uint256 i; i < nNew; ++i) {
            address v = newVictims[i];
            if (v == address(0)) revert ZeroAddress();
            _requireNotInPost(p, v);
            _requireNotInBatch(newVictims, i, v);

            p.victims.push(v);
            unchecked { ++_victimActivePosts[v]; }
            if (_victimActivePosts[v] == 1) isVictim[v] = true;
        }

        p.lastUpdatedAt = uint64(block.timestamp);

        emit VictimsAdded(postId, msg.sender, newVictims);
    }

    /// @dev Reverts with `DuplicateAddress` if `a` is already listed in
    ///      either of the post's attacker or victim arrays. Used by the
    ///      additive edit paths (`addAttackers` / `addVictims`) to
    ///      enforce the cross-array uniqueness invariant.
    function _requireNotInPost(Post storage p, address a) internal view {
        uint256 aLen = p.attackers.length;
        for (uint256 j; j < aLen; ++j) {
            if (p.attackers[j] == a) revert DuplicateAddress();
        }
        uint256 vLen = p.victims.length;
        for (uint256 j; j < vLen; ++j) {
            if (p.victims[j] == a) revert DuplicateAddress();
        }
    }

    /// @dev Reverts with `DuplicateAddress` if `a` appears earlier in
    ///      the same input batch (indexes [0, upTo)). Catches caller
    ///      mistakes like `[X, X]` without the gas cost of a fresh
    ///      memory set.
    function _requireNotInBatch(
        address[] calldata batch,
        uint256 upTo,
        address a
    ) internal pure {
        for (uint256 j; j < upTo; ++j) {
            if (batch[j] == a) revert DuplicateAddress();
        }
    }

    /*//////////////////////////////////////////////////////////////
                                  READS
    //////////////////////////////////////////////////////////////*/

    function getPost(uint256 id) external view returns (
        address  poster,
        uint64   attackedAt,
        uint32   confirmations,
        uint32   disconfirmations,
        bool     removed,
        address[] memory attackers_,
        address[] memory victims_,
        uint64   lastUpdatedAt
    ) {
        Post storage p = _posts[id];
        if (p.poster == address(0)) revert PostNotFound();
        return (
            p.poster,
            p.attackedAt,
            p.confirmations,
            p.disconfirmations,
            p.removed,
            p.attackers,
            p.victims,
            p.lastUpdatedAt
        );
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

    /// @notice Full set of confirmers on `postId`, in insertion order (per
    ///         OpenZeppelin EnumerableSet.values()).
    /// @dev    Unbounded by design: caller picks the gas budget at the
    ///         eth_call layer. For very large confirmer sets, paginate at the
    ///         consumer level.
    function getConfirmers(uint256 postId) external view returns (address[] memory) {
        return _confirmers[postId].values();
    }

    /// @notice Full set of disconfirmers on `postId`, same semantics as
    ///         `getConfirmers`.
    function getDisconfirmers(uint256 postId) external view returns (address[] memory) {
        return _disconfirmers[postId].values();
    }

    /// @notice Cardinality of the confirmer set for `postId`. Equal to the
    ///         post's `confirmations` counter as an invariant.
    function getConfirmerCount(uint256 postId) external view returns (uint256) {
        return _confirmers[postId].length();
    }

    /// @notice Cardinality of the disconfirmer set for `postId`. Equal to the
    ///         post's `disconfirmations` counter as an invariant.
    function getDisconfirmerCount(uint256 postId) external view returns (uint256) {
        return _disconfirmers[postId].length();
    }

    /*//////////////////////////////////////////////////////////////
                            v1.1 STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Per-post title — required, max length `MAX_TITLE_LENGTH`
    ///         bytes, set on creation, mutable via `amendTitle()`.
    /// @dev    Stored on-chain (unlike `note`, which lives only in events)
    ///         so integrators can read titles without an indexer. Empty
    ///         string is rejected on `post()` and `amendTitle()`.
    /// @custom:storage-location v1.1
    mapping(uint256 => string) public postTitle;

    /*//////////////////////////////////////////////////////////////
                            STORAGE GAP
    //////////////////////////////////////////////////////////////*/

    /// @dev Reserved for future upgrades. When adding new state variables
    ///      in a future implementation, append them above this line and
    ///      shrink the gap by the number of slots consumed. The OZ
    ///      inherited contracts (Ownable, Ownable2Step, UUPS) use
    ///      ERC-7201 namespaced storage internally, so they do not
    ///      collide with this sequential layout.
    ///      v1.0 gap was [50]; v1.1 added `postTitle` (1 slot for the
    ///      mapping reference), so the gap is [49].
    uint256[49] private __gap;
}
