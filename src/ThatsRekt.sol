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

    /// @notice Governance Safe multisig. Hardcoded for cross-chain bytecode
    ///         determinism. THIS PLACEHOLDER MUST BE REPLACED WITH THE REAL
    ///         SAFE ADDRESS BEFORE ANY MAINNET / L2 DEPLOY. The deploy script
    ///         enforces this with a runtime check.
    address public constant GOVERNANCE = 0x000000000000000000000000000000000000ABcD;

    /// @notice (downvotes - upvotes) >= this triggers auto-removal at end of vote().
    uint256 public constant REMOVAL_THRESHOLD = 3;

    /// @notice Hard cap on attackers.length + victims.length per post.
    uint256 public constant MAX_ADDRESSES_PER_POST = 32;

    /// @notice Pagination cap for view helpers (eth_call gas budget).
    uint256 public constant MAX_VIEW_LIMIT = 100;

    /*//////////////////////////////////////////////////////////////
                                  STRUCTS
    //////////////////////////////////////////////////////////////*/

    struct Post {
        address  poster;
        uint64   timestamp;
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
        uint64          timestamp,
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

    enum RemovalReason { AutoDownvote, PosterRetract }
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

    /*//////////////////////////////////////////////////////////////
                                CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor() Ownable(GOVERNANCE) {}

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

    function addWhitelisted(address /*account*/) external onlyOwner {
        // implemented in Phase 2
    }

    function removeWhitelisted(address /*account*/) external onlyOwner {
        // implemented in Phase 2
    }

    /*//////////////////////////////////////////////////////////////
                          WHITELISTED (post + vote)
    //////////////////////////////////////////////////////////////*/

    function post(
        address[] calldata /*attackers_*/,
        address[] calldata /*victims_*/,
        string   calldata /*note*/
    ) external onlyWhitelisted returns (uint256 /*id*/) {
        // implemented in Phase 3
    }

    function vote(uint256 /*postId*/, int8 /*direction*/) external onlyWhitelisted {
        // implemented in Phase 5
    }

    /*//////////////////////////////////////////////////////////////
                          POSTER (retract)
    //////////////////////////////////////////////////////////////*/

    function retract(uint256 /*postId*/) external {
        // implemented in Phase 7
    }

    /*//////////////////////////////////////////////////////////////
                                  READS
    //////////////////////////////////////////////////////////////*/

    function getPost(uint256 /*id*/) external view returns (
        address  /*poster*/,
        uint64   /*timestamp*/,
        uint32   /*upvotes*/,
        uint32   /*downvotes*/,
        bool     /*removed*/,
        address[] memory /*attackers_*/,
        address[] memory /*victims_*/
    ) {
        // implemented in Phase 3 (storage read) and Phase 9 (full surface)
    }

    function attackerReport(address /*a*/) external view returns (int256 /*score*/, uint256 /*appearances*/) {
        // implemented in Phase 9
    }

    function recentActivePosts(uint256 /*limit*/) external view returns (uint256[] memory /*ids*/) {
        // implemented in Phase 9
    }

    function activePostsBefore(uint256 /*beforeId*/, uint256 /*limit*/) external view returns (uint256[] memory /*ids*/) {
        // implemented in Phase 9
    }
}
