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
///         Five-role governance (asymmetric delays):
///           - `owner` (TimelockController(7d) in prod): upgrade authority
///             (`_authorizeUpgrade`), re-installation path for the
///             whitelist admin slot via `setWhitelistAdmin`, install /
///             rotation path for the `purgeAdmin` slot via
///             `setPurgeAdmin`, and instant rotation path for both
///             kill-switch slots via `setWhitelistRemover` /
///             `setPurgeRemover`. 7-day delay gives integrators a long
///             disengage window for sensitive moves; the kill-switch
///             slot rotations are instant once the owner-tx lands
///             because the owner is itself the only delay layer needed.
///           - `whitelistAdmin` (TimelockController(3d) in prod): adds
///             posters via `addWhitelisted` and self-rotates via
///             `setWhitelistAdmin`. 3-day delay so installing a new
///             poster (or replacing the operator) is publicly visible
///             before it lands.
///           - `whitelistRemover` (multisig in prod): removes posters
///             instantly via `removeWhitelisted`, and can revoke the
///             whitelist admin slot instantly via `revokeWhitelistAdmin`
///             (zeros it; owner re-installs through the 7-day path).
///             Kill-switch for the whitelist plane — compromised posters
///             or a captured admin TLC can be neutralized in one tx.
///           - `purgeAdmin` (TimelockController(1d) in prod): permanently
///             flags posts as purged via `purgePost` — governance-driven
///             content moderation. 1-day delay balances "clean up
///             illegal/spam content promptly" against "auditable public
///             window".
///           - `purgeRemover` (cold wallet EOA in prod): instantly
///             revokes the `purgeAdmin` slot via `revokePurgeAdmin`
///             (zeros it; owner re-installs through the 7-day path).
///             Kill-switch for the purge plane. In production, this is
///             *also* the proposer/canceller on the purge TLC, so the
///             same address can both kill the role and cancel any
///             pending purge operation before its 1-day delay elapses.
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
        /// @dev Set by the poster via `retract()`. Reverses aggregates
        ///      (attackerScore + victimActivePostCount) and unlinks the
        ///      post from the active linked list.
        bool     removed;
        /// @dev Set by governance via `purgePost()`. Distinct from
        ///      `removed` — purge is for moderating illegal / spam /
        ///      abusive content. Frontends should hide purged posts
        ///      entirely; on-chain state retains the original data
        ///      (events are immutable anyway, scrubbing storage is
        ///      symbolic) but aggregates are reversed so a purged post
        ///      no longer counts toward `attackerScore` /
        ///      `victimActivePostCount`. Idempotent: once true, can
        ///      never flip back.
        bool     purged;
        /// @dev Block-time freshness signal. Set to `block.timestamp` at
        ///      post creation and bumped on every poster-driven edit
        ///      (`amendNote`, `addAttackers`, `addVictims`). Indexers and
        ///      consumers can use this to surface "recently edited" posts
        ///      without scanning the event log. Packs into the same storage
        ///      slot as `disconfirmations` (u32) + `removed` (bool) +
        ///      `purged` (bool) + this u64.
        uint64   lastUpdatedAt;
        address[] attackers;
        address[] victims;
    }

    /*//////////////////////////////////////////////////////////////
                                  STORAGE
    //////////////////////////////////////////////////////////////*/

    mapping(address => bool) public isWhitelisted;

    /// @notice Address authorized to ADD posters via `addWhitelisted`
    ///         and to self-rotate via `setWhitelistAdmin`. In production
    ///         this is a 3-day TimelockController whose proposer is the
    ///         multisig — so adding a poster (or replacing the operator
    ///         with a new one) takes 3 days minimum.
    /// @dev    Set on initialize. Two rotation paths:
    ///           * `setWhitelistAdmin` callable by self (3-day path) or
    ///             by owner (7-day re-install path). Cannot accept
    ///             `address(0)` — use `revokeWhitelistAdmin` for that.
    ///           * `revokeWhitelistAdmin` callable by `whitelistRemover`
    ///             (instant) — sets the slot to `address(0)` so all
    ///             `addWhitelisted` calls revert until the owner
    ///             re-installs an admin via the 7-day path.
    ///         When this slot is `address(0)`, no one can add posters
    ///         (the modifier rejects every caller, since msg.sender is
    ///         always non-zero on external calls).
    address public whitelistAdmin;

    /// @notice Address authorized to REMOVE posters via `removeWhitelisted`
    ///         and to revoke the whitelistAdmin slot via
    ///         `revokeWhitelistAdmin`. Both actions are instant — this
    ///         is the kill-switch for incident response. In production
    ///         this is the multisig directly (not behind any timelock).
    /// @dev    Set on initialize; rotated via `setWhitelistRemover`
    ///         (`onlyOwner`, so 7-day delay in prod). Cannot be zero;
    ///         losing this role means losing the kill-switch, so
    ///         rotation requires the 7-day owner path with full
    ///         integrator visibility.
    address public whitelistRemover;

    /// @notice Address authorized to PURGE posts via `purgePost` —
    ///         governance-driven content moderation for illegal / spam /
    ///         abusive alerts. Distinct from `retract()` (poster-only).
    ///         In production this is a 1-day TimelockController whose
    ///         proposer is the operator cold wallet — short delay so the
    ///         feed can be cleaned up promptly, but still long enough
    ///         that integrators can audit each purge before it lands.
    /// @dev    Set on initialize. Two rotation paths mirror the
    ///         whitelistAdmin pattern:
    ///           * `setPurgeAdmin` callable by `owner` only — 7-day
    ///             path in prod, used to install or replace the purge
    ///             admin. Owner-only (not self-rotating like
    ///             `whitelistAdmin`) because the 1-day TLC delay is too
    ///             short to be the gating delay on its own rotation:
    ///             a captured purge TLC could otherwise install a
    ///             hostile successor in 1 day. Cannot accept
    ///             `address(0)` — use `revokePurgeAdmin` for that.
    ///           * `revokePurgeAdmin` callable by `purgeRemover`
    ///             (instant) — kill-switch sets the slot to
    ///             `address(0)`, after which all `purgePost` calls
    ///             revert with `NotPurgeAdmin` until the owner
    ///             re-installs an admin via the 7-day path.
    ///         May be `address(0)` at deploy time ("purge disabled")
    ///         or after revoke. Production deploys always wire a 1-day
    ///         TimelockController here.
    address public purgeAdmin;

    /// @notice Address authorized to instantly revoke the `purgeAdmin`
    ///         slot via `revokePurgeAdmin`. Mirrors the
    ///         `whitelistRemover` pattern but scoped to the purge plane.
    ///         In production this is the operator's cold wallet EOA —
    ///         the same address that holds proposer + canceller on the
    ///         1-day purge TimelockController, so it can both
    ///         (a) neutralize a captured `purgeAdmin` TLC in one tx, and
    ///         (b) cancel any pending purge operation on that TLC
    ///         before its 1-day delay elapses.
    /// @dev    Set on initialize; rotated via `setPurgeRemover`
    ///         (`onlyOwner`, so 7-day delay in prod). Cannot be zero —
    ///         losing this role means losing the purge kill-switch, so
    ///         rotation requires the 7-day owner path with full
    ///         integrator visibility. No internal timelock layer is
    ///         needed for the rotation itself: the owner is itself a
    ///         7-day TLC in production, which is the only delay layer
    ///         required.
    address public purgeRemover;

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
    event WhitelistRemoverTransferred(address indexed previousRemover, address indexed newRemover);
    event PurgeAdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    event PurgeRemoverTransferred(address indexed previousRemover, address indexed newRemover);

    /// @notice Emitted when governance permanently flags `postId` as purged.
    /// @dev    `by` is `msg.sender` (the purgeAdmin at the time of call —
    ///         in production this is the 1-day TimelockController, so the
    ///         indexed `by` field surfaces the TLC address, not the
    ///         underlying proposer EOA. Consumers wanting the proposer
    ///         must cross-reference the TLC's own `CallScheduled` event.)
    event PostPurged(uint256 indexed postId, address indexed by);
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
    error NotWhitelistRemover();
    error NotPurgeAdmin();
    error NotPurgeRemover();
    error AlreadyPurged();
    error Unauthorized();
    error PosterCannotConfirm();
    error PostIsRemoved();
    error PostIsPurged();
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
    /// @notice Reverts when the caller's claimed `expectedPostId` doesn't match
    ///         the next slot the contract is about to assign. Carries both
    ///         values so a wallet's revert-decoder can show "you expected
    ///         42, got 43".
    error PostIdMismatch(uint256 expected, uint256 actual);

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

    /// @notice Proxy entry point. Wires the three governance roles and
    ///         optionally pre-populates the poster whitelist so the
    ///         registry is operational at deploy time without waiting
    ///         on the 3-day add timelock.
    /// @param  initialOwner Holds upgrade authority + the 7-day
    ///                      re-install path for the whitelistAdmin
    ///                      slot. Production: TimelockController(7d).
    ///                      Reverts on `address(0)` via
    ///                      OwnableUpgradeable.
    /// @param  initialWhitelistAdmin Holds the add path
    ///                      (`addWhitelisted`) and the 3-day
    ///                      self-rotate path (`setWhitelistAdmin`).
    ///                      Production: TimelockController(3d) with
    ///                      multisig as proposer/executor. Cannot be
    ///                      zero at init — the slot may later be
    ///                      zeroed by `revokeWhitelistAdmin`, but it
    ///                      must start populated so the genesis
    ///                      whitelist is actually mutable post-deploy.
    /// @param  initialWhitelistRemover Holds the instant remove path
    ///                      (`removeWhitelisted`) and the kill-switch
    ///                      (`revokeWhitelistAdmin`). Production:
    ///                      multisig directly. Cannot be zero — losing
    ///                      this slot means losing the kill-switch.
    /// @param  initialPurgeAdmin Holds the governance-purge path
    ///                      (`purgePost`). Production: 1-day
    ///                      TimelockController whose proposer is the
    ///                      same cold wallet that fills
    ///                      `initialPurgeRemover`. May be `address(0)`
    ///                      to deploy with purge disabled — the owner
    ///                      can install one later via `setPurgeAdmin`
    ///                      (7-day path).
    /// @param  initialPurgeRemover Holds the purge kill-switch
    ///                      (`revokePurgeAdmin`). Production: the
    ///                      operator's cold wallet EOA, which is also
    ///                      the proposer/canceller on the 1-day purge
    ///                      TLC named in `initialPurgeAdmin` — same
    ///                      principal handles both kill-switch and
    ///                      pending-purge cancellation. Cannot be
    ///                      zero — losing this slot at init means
    ///                      losing the purge kill-switch.
    /// @param  initialWhitelisters Posters to mark as whitelisted at
    ///                      deploy time, bypassing the 3-day add
    ///                      timelock. Each entry must be non-zero;
    ///                      duplicates within the array are silently
    ///                      tolerated (the second insert is a no-op,
    ///                      no duplicate event). Pass an empty array
    ///                      if no pre-population is desired.
    /// @dev    Idempotency is enforced by `Initializable` — re-calling
    ///         `initialize` on an already-initialized proxy reverts
    ///         with `InvalidInitialization()`. The owner role is fully
    ///         transferable via the inherited Ownable2Step two-step
    ///         flow; the whitelistAdmin slot is rotated via
    ///         `setWhitelistAdmin` (single-step), the
    ///         whitelistRemover slot via `setWhitelistRemover`
    ///         (single-step, onlyOwner), the purgeAdmin slot via
    ///         `setPurgeAdmin` (single-step, onlyOwner), and the
    ///         purgeRemover slot via `setPurgeRemover` (single-step,
    ///         onlyOwner).
    function initialize(
        address initialOwner,
        address initialWhitelistAdmin,
        address initialWhitelistRemover,
        address initialPurgeAdmin,
        address initialPurgeRemover,
        address[] calldata initialWhitelisters
    ) external initializer {
        if (initialWhitelistAdmin == address(0)) revert ZeroAddress();
        if (initialWhitelistRemover == address(0)) revert ZeroAddress();
        if (initialPurgeRemover == address(0)) revert ZeroAddress();
        // Note: `initialPurgeAdmin == address(0)` is *allowed* — it means
        // "deploy with purge disabled". The owner can install a purge
        // admin later via `setPurgeAdmin` (7-day path). All `purgePost`
        // calls revert with `NotPurgeAdmin` while the slot is zero
        // (msg.sender on an external call is always non-zero).
        // `initialPurgeRemover` is required even when the admin slot
        // is zero, so the kill-switch is in place for the day the
        // owner does install a purgeAdmin via the 7-day path.

        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        // UUPSUpgradeable has no `__UUPSUpgradeable_init` in OZ 5.x — it
        // holds no state, so there is nothing to wire up here. The
        // upgrade authority is enforced solely by `_authorizeUpgrade`.

        whitelistAdmin   = initialWhitelistAdmin;
        whitelistRemover = initialWhitelistRemover;
        purgeAdmin       = initialPurgeAdmin;
        purgeRemover     = initialPurgeRemover;
        emit WhitelistAdminTransferred(address(0), initialWhitelistAdmin);
        emit WhitelistRemoverTransferred(address(0), initialWhitelistRemover);
        emit PurgeAdminTransferred(address(0), initialPurgeAdmin);
        emit PurgeRemoverTransferred(address(0), initialPurgeRemover);

        // Pre-populate the poster whitelist. This is the only legitimate
        // bypass of the 3-day add timelock and exists solely for the
        // genesis bootstrap — the deploy script is the only context
        // where the proxy's storage is writable without going through
        // the role-gated entry points.
        uint256 n = initialWhitelisters.length;
        for (uint256 i; i < n; ++i) {
            address a = initialWhitelisters[i];
            if (a == address(0)) revert ZeroAddress();
            if (!isWhitelisted[a]) {
                isWhitelisted[a] = true;
                emit WhitelistUpdated(a, true);
            }
        }
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

    modifier onlyWhitelistRemover() {
        if (msg.sender != whitelistRemover) revert NotWhitelistRemover();
        _;
    }

    modifier onlyPurgeAdmin() {
        if (msg.sender != purgeAdmin) revert NotPurgeAdmin();
        _;
    }

    modifier onlyPurgeRemover() {
        if (msg.sender != purgeRemover) revert NotPurgeRemover();
        _;
    }

    /*//////////////////////////////////////////////////////////////
                       GOVERNANCE (role rotation)
    //////////////////////////////////////////////////////////////*/

    /// @notice Rotate the `whitelistAdmin` slot. Two callers are
    ///         authorized, each producing a different effective delay:
    ///           * the current `whitelistAdmin` itself — 3-day path
    ///             (the prod TLC's delay), used for normal operator
    ///             rotation;
    ///           * `owner` — 7-day path (the prod owner TLC's delay),
    ///             used to re-install an admin after the slot has been
    ///             zeroed by `revokeWhitelistAdmin`, or as a fallback
    ///             if the admin role itself is bricked.
    /// @dev    Rejects `address(0)` — that path lives on
    ///         `revokeWhitelistAdmin` so the audit trail makes intent
    ///         (rotate vs kill) explicit. After a revoke, the
    ///         `whitelistAdmin` slot is zero, so the self-rotate path
    ///         cannot be used (no msg.sender will match) — only the
    ///         owner path can re-install. That asymmetry is the whole
    ///         point of the kill-switch: a captured TLC cannot sneak a
    ///         hostile admin back in within 3 days.
    /// @param  newAdmin New holder of the whitelistAdmin slot. Must be
    ///                  non-zero.
    function setWhitelistAdmin(address newAdmin) external {
        if (msg.sender != owner() && msg.sender != whitelistAdmin) {
            revert Unauthorized();
        }
        if (newAdmin == address(0)) revert ZeroAddress();
        address prev = whitelistAdmin;
        whitelistAdmin = newAdmin;
        emit WhitelistAdminTransferred(prev, newAdmin);
    }

    /// @notice Rotate the `whitelistRemover` slot. Only callable by
    ///         `owner`, so 7-day delay in production. Cannot be zero —
    ///         losing this slot means losing both the instant remove
    ///         path and the kill-switch.
    /// @param  newRemover New holder of the whitelistRemover slot.
    function setWhitelistRemover(address newRemover) external onlyOwner {
        if (newRemover == address(0)) revert ZeroAddress();
        address prev = whitelistRemover;
        whitelistRemover = newRemover;
        emit WhitelistRemoverTransferred(prev, newRemover);
    }

    /// @notice Kill-switch for the `whitelistAdmin` slot — sets it to
    ///         `address(0)` instantly. After revoke, no one can call
    ///         `addWhitelisted` until the owner re-installs an admin
    ///         via `setWhitelistAdmin` (7-day path). Existing posters
    ///         are unaffected; this only stops new additions.
    /// @dev    Distinct from `setWhitelistAdmin` because its access
    ///         control is different (whitelistRemover, not owner) and
    ///         its delay is different (instant, not 7 days). Splitting
    ///         the entry points lets indexers and governance dashboards
    ///         distinguish "rotated to a new operator" from "operator
    ///         was killed mid-incident" without parsing arguments.
    function revokeWhitelistAdmin() external onlyWhitelistRemover {
        address prev = whitelistAdmin;
        whitelistAdmin = address(0);
        emit WhitelistAdminTransferred(prev, address(0));
    }

    /// @notice Rotate the `purgeAdmin` slot. Owner-only — 7-day delay in
    ///         production. Allows installing a fresh purge admin or
    ///         replacing an existing one.
    /// @dev    Owner-only (not self-rotating like `whitelistAdmin`)
    ///         because the purge TLC's delay is only 1 day in
    ///         production — too short to be the gating delay on its
    ///         own rotation. Forcing rotation through the owner keeps
    ///         the 7-day public window between proposal and effect.
    ///
    ///         Rejects `address(0)` — that path lives on
    ///         `revokePurgeAdmin` so the audit trail makes intent
    ///         (rotate vs kill) explicit. To disable purge, use
    ///         `revokePurgeAdmin` (instant, purgeRemover-only); to
    ///         install or replace a purge admin, use this entry point
    ///         with a non-zero address. Mirrors the
    ///         `setWhitelistAdmin` / `revokeWhitelistAdmin` split.
    /// @param  newAdmin New holder of the purgeAdmin slot. Must be
    ///                  non-zero.
    function setPurgeAdmin(address newAdmin) external onlyOwner {
        if (newAdmin == address(0)) revert ZeroAddress();
        address prev = purgeAdmin;
        purgeAdmin = newAdmin;
        emit PurgeAdminTransferred(prev, newAdmin);
    }

    /// @notice Kill-switch for the `purgeAdmin` slot — sets it to
    ///         `address(0)` instantly. After revoke, no one can call
    ///         `purgePost` until the owner re-installs an admin via
    ///         `setPurgeAdmin` (7-day path). Existing purged posts
    ///         remain purged; this only stops new purges.
    /// @dev    Mirrors `revokeWhitelistAdmin`'s shape but uses a
    ///         dedicated `purgeRemover` slot (not `whitelistRemover`)
    ///         so the two kill-switches can be held by different
    ///         principals if the operator chooses. In production both
    ///         slots are intentionally distinct: `whitelistRemover` is
    ///         the Safe multisig, `purgeRemover` is the operator's
    ///         cold wallet EOA — same EOA that proposes/cancels on
    ///         the 1-day purge TLC, so a single party can both
    ///         neutralize a captured purge admin AND cancel pending
    ///         purges before their delay elapses.
    function revokePurgeAdmin() external onlyPurgeRemover {
        address prev = purgeAdmin;
        purgeAdmin = address(0);
        emit PurgeAdminTransferred(prev, address(0));
    }

    /// @notice Rotate the `purgeRemover` slot. Only callable by
    ///         `owner`, so 7-day delay in production. Cannot be zero —
    ///         losing this slot means losing the purge kill-switch.
    /// @dev    Mirrors `setWhitelistRemover`: owner-only, single-step,
    ///         instant once the owner-tx lands. No internal timelock
    ///         layer added here — the 7-day owner TLC in production is
    ///         the only delay layer needed, and rotating the
    ///         kill-switch requires the same level of integrator
    ///         visibility as rotating any other governance slot.
    /// @param  newRemover New holder of the purgeRemover slot.
    function setPurgeRemover(address newRemover) external onlyOwner {
        if (newRemover == address(0)) revert ZeroAddress();
        address prev = purgeRemover;
        purgeRemover = newRemover;
        emit PurgeRemoverTransferred(prev, newRemover);
    }

    /*//////////////////////////////////////////////////////////////
                  WHITELIST ADMIN (3-day path: add posters)
    //////////////////////////////////////////////////////////////*/

    /// @notice Add an address to the whitelist of authorized posters.
    ///         Called by `whitelistAdmin`, which is a 3-day
    ///         TimelockController in production — so additions take 3
    ///         days from proposal to execution.
    /// @dev    Idempotent: re-adding an already-whitelisted address is
    ///         a silent no-op (no event), matching the v1 semantics.
    function addWhitelisted(address account) external onlyWhitelistAdmin {
        if (!isWhitelisted[account]) {
            isWhitelisted[account] = true;
            emit WhitelistUpdated(account, true);
        }
    }

    /*//////////////////////////////////////////////////////////////
                WHITELIST REMOVER (instant: remove posters)
    //////////////////////////////////////////////////////////////*/

    /// @notice Remove an address from the whitelist of authorized
    ///         posters. Called by `whitelistRemover` (multisig in
    ///         prod) — no delay, so a misbehaving poster can be kicked
    ///         immediately.
    /// @dev    Idempotent: removing a non-whitelisted address is a
    ///         silent no-op (no event).
    function removeWhitelisted(address account) external onlyWhitelistRemover {
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
    /// @notice Post a new alert with optimistic id commitment.
    /// @param expectedPostId The caller's claimed next id. Must equal `postCount + 1`
    ///                       or the call reverts. Lets posters commit to a stable
    ///                       post URL ("thatsrekt.com/post/base/42") off-chain
    ///                       before the tx mines: if the slot is taken, revert
    ///                       cleanly so the off-chain reference can be retried
    ///                       at the new slot rather than silently pointing to
    ///                       someone else's content.
    /// @dev   This is NOT content-front-run protection — a racer can still copy
    ///        a guardian's content and target the same `expectedPostId`. What it
    ///        guarantees is "you won't accidentally land at a different id than
    ///        you committed to."
    function post(
        uint256           expectedPostId,
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
        if (id != expectedPostId) revert PostIdMismatch(expectedPostId, id);

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

    /// @notice Id the next successful `post()` will receive — i.e. `postCount + 1`.
    /// @dev    Convenience view for clients building the `expectedPostId` arg.
    ///         Equivalent to `postCount() + 1`. "Peek" prefix because the
    ///         identifier `nextPostId` is already the doubly-linked-list
    ///         next-pointer mapping; this view is about the slot that will
    ///         be claimed next, not adjacency in the post list.
    function peekNextPostId() external view returns (uint256) {
        return postCount + 1;
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
        if (p.purged)                 revert PostIsPurged();
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
        if (p.purged)               revert PostIsPurged();

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

        // 1. reverse attacker + victim aggregates (shared with purgePost)
        _reverseAggregates(id);

        // 2. unlink from active-post linked list
        uint256 prev = prevPostId[id];
        uint256 next = nextPostId[id];
        if (prev != 0) nextPostId[prev] = next; else headPostId = next;
        if (next != 0) prevPostId[next] = prev; else tailPostId = prev;
        delete prevPostId[id];
        delete nextPostId[id];

        // 3. mark removed
        p.removed = true;

        emit PostRemoved(id, reason);
    }

    /// @dev Reverse the post's contribution to the global aggregates:
    ///      `attackerScore` decremented by `net` for each attacker,
    ///      `attackerAppearances` decremented for each attacker, and
    ///      `_victimActivePosts` decremented for each victim (with
    ///      `isVictim` flipping false on the last live post).
    ///
    ///      Called exactly once per post lifecycle change: by
    ///      `_removePost` on poster retract, or by `purgePost` on
    ///      governance purge — but never both, since `purgePost` skips
    ///      the call when the post is already `removed` (aggregates
    ///      were reversed at retract time). This is what "AlreadyPurged"
    ///      protects against on the second-purge path; "removed first
    ///      then purged" is handled by the explicit `if (!p.removed)`
    ///      guard in `purgePost`.
    function _reverseAggregates(uint256 id) internal {
        Post storage p = _posts[id];

        int256 net = int256(uint256(p.confirmations)) - int256(uint256(p.disconfirmations));

        uint256 aLen = p.attackers.length;
        for (uint256 i; i < aLen; ++i) {
            address a = p.attackers[i];
            attackerScore[a] -= net;
            unchecked { --attackerAppearances[a]; }
        }

        uint256 vLen = p.victims.length;
        for (uint256 i; i < vLen; ++i) {
            address v = p.victims[i];
            unchecked { --_victimActivePosts[v]; }
            if (_victimActivePosts[v] == 0) isVictim[v] = false;
        }
    }

    /*//////////////////////////////////////////////////////////////
                          POSTER (retract)
    //////////////////////////////////////////////////////////////*/

    function retract(uint256 postId) external {
        Post storage p = _posts[postId];
        if (p.poster == address(0))     revert PostNotFound();
        if (p.poster != msg.sender)     revert NotPoster();
        if (p.removed)                  revert PostIsRemoved();
        if (p.purged)                   revert PostIsPurged();
        _removePost(postId, RemovalReason.Retracted);
    }

    /*//////////////////////////////////////////////////////////////
                        PURGE ADMIN (governance moderation)
    //////////////////////////////////////////////////////////////*/

    /// @notice Permanently flag a post as purged by governance. Use
    ///         case: removing illegal / spam / abusive content from
    ///         the public feed. Frontends should hide purged posts
    ///         entirely; on-chain state retains the original data
    ///         (events are immutable anyway, scrubbing storage would
    ///         be symbolic) but aggregates are reversed so a purged
    ///         post no longer counts toward `attackerScore` /
    ///         `attackerAppearances` / `isVictim`.
    /// @dev    Distinct from `retract()` (poster-controlled). Purge is
    ///         the governance moderation path; retract is the poster
    ///         take-back path. The two CAN compose: a post that was
    ///         retracted by its poster can still be purged by
    ///         governance afterward (the `purged` flag is independent
    ///         of `removed`). When that happens, aggregates are NOT
    ///         double-reversed — the `if (!p.removed)` guard skips
    ///         the second reversal.
    ///
    ///         The post is NOT unlinked from the active linked list
    ///         here when it is also currently `removed` — that was
    ///         already done at retract. When the post is *only*
    ///         purged (not previously retracted), we DO unlink it,
    ///         so the active feed stops surfacing it. The `removed`
    ///         flag is intentionally left untouched: indexers and
    ///         frontends can distinguish "poster retracted" from
    ///         "governance purged" by checking both flags.
    ///
    ///         Idempotent via the `AlreadyPurged` check — calling
    ///         `purgePost` twice on the same post reverts the second
    ///         time, matching the audit-trail-preserving design.
    /// @param postId Target post id (must exist and not already be purged).
    function purgePost(uint256 postId) external onlyPurgeAdmin {
        Post storage p = _posts[postId];
        if (p.poster == address(0)) revert PostNotFound();
        if (p.purged)               revert AlreadyPurged();

        p.purged = true;

        // If the poster already retracted, aggregates were reversed
        // there and the post was already unlinked from the active
        // list — don't double-reverse, don't re-unlink.
        if (!p.removed) {
            _reverseAggregates(postId);

            // Unlink from active-post linked list. Same logic as
            // `_removePost` step 2; not extracted because there are
            // only two callers and a 7-line helper would obscure the
            // ordering with `_reverseAggregates` above.
            uint256 prev = prevPostId[postId];
            uint256 next = nextPostId[postId];
            if (prev != 0) nextPostId[prev] = next; else headPostId = next;
            if (next != 0) prevPostId[next] = prev; else tailPostId = prev;
            delete prevPostId[postId];
            delete nextPostId[postId];
        }

        emit PostPurged(postId, msg.sender);
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
        if (p.purged)                 revert PostIsPurged();

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
        if (p.purged)                 revert PostIsPurged();

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
        if (p.purged)                 revert PostIsPurged();
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
        if (p.purged)                 revert PostIsPurged();
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

    /// @notice Whether `postId` has been purged by governance. Distinct
    ///         from the `removed` flag (poster retract) returned by
    ///         `getPost`.
    /// @dev    Kept as a separate view rather than added as a 9th return
    ///         to `getPost` to avoid breaking the v1.0 ABI for indexers
    ///         and integrators destructuring the existing 8-tuple.
    /// @return purged True if `purgePost(postId)` has been called.
    function isPurged(uint256 postId) external view returns (bool) {
        return _posts[postId].purged;
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
    ///      mapping reference) → [49]; v1.2 added `whitelistRemover`
    ///      (1 slot) → [48]; v1.3 added `purgeAdmin` and `purgeRemover`
    ///      (2 slots, one address each) → [46]. The `purged` bool on
    ///      `Post` doesn't touch this gap — it packs into the existing
    ///      slot beside `removed` / `disconfirmations` /
    ///      `lastUpdatedAt`.
    uint256[46] private __gap;
}
