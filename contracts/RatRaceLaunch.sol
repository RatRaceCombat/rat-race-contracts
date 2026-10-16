// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {RatRaceDistributor} from "./RatRaceDistributor.sol";
import {RatRacePot} from "./RatRacePot.sol";

/**
 * @title RatRaceLaunch
 * @notice Deploys RatRaceDistributor and RatRacePot together, linked, in one transaction.
 *
 * Its constructor creates the distributor (its first contract, nonce 1) naming the pot's address to
 * come (its second, nonce 2), then the pot naming the distributor, then confirms the link on the
 * distributor (confirmPot). If any step fails nothing is deployed. It keeps no power over either:
 * both take their owner from the arguments, and this contract only records their addresses.
 * Glossary (the same verbs mean different things across the Rat Race contracts: `release` sends RAT or copies
 * to one destination each, and a change waiting in public is schedule/execute, propose/apply or announce/add):
 * this one has no such verb: it only deploys the distributor and the pot, linked.
 * @custom:security Who: anyone deploys it, once, with the parameters; afterwards it has no function that changes anything. Delay: none. Limits: the checkpoint key, the pot's draw key and the sentinel must be different keys. Checks: it refuses a real distributor with a test pot or the reverse (testMode must match), and checks both link to each other.
 */
contract RatRaceLaunch {
    struct Params {
        address owner; // the owner of both (the Safe; the Trezor until it is handed over)
        IERC20 rat;
        address signer; // the game's checkpoint key (the distributor)
        address guardian; // the guardian of both
        address sentinel; // the distributor's watcher bot (pause and veto only), or address 0
        RatRaceDistributor.Timings distTimings; // its time rules: realTimings() for production (testMode false)
        RatRacePot.Timings potTimings; // the pot's time rules: its real ones for production
        uint64 delay;
        uint256 maxStepWithdraw;
        uint256 maxStepSettle;
        uint256 maxBounty;
        uint256 outflowCap;
        uint256 burnCap;
        address potSigner; // the game's draw key (the pot): never the checkpoint key
        uint256 nightBps; // the 9 PM Manager's share of the pot a day
        uint256 monthBps; // the month's top 10's share of the pot
    }

    /// @notice The withdrawal contract this launch created.
    /// @custom:security Who: set once at deploy. Delay: none. Limits: none. Checks: linked both ways with `pot`.
    RatRaceDistributor public immutable distributor;
    /// @notice The Big Cheese pot this launch created: it only ever sends RAT back to `distributor`.
    /// @custom:security Who: set once at deploy. Delay: none. Limits: none. Checks: linked both ways with `distributor`.
    RatRacePot public immutable pot;
    /// @notice True when both contracts are a test deployment (short time rules); false when both are real. Never mixed.
    /// @custom:security Who: set once at deploy. Delay: none. Limits: none. Checks: the launch reverts if the two disagree.
    bool public immutable testMode; // both a test deployment (short time rules), or both real: never mixed

    event Launched(address distributor, address pot, bool testMode);

    error SameKey();
    error NotLinked();
    error MixedTimings();

    constructor(Params memory p) {
        if (p.potSigner == p.signer || (p.sentinel != address(0) && (p.sentinel == p.signer || p.sentinel == p.potSigner))) revert SameKey();
        // a contract's nonce starts at 1: the distributor is created at nonce 1, the pot at nonce 2
        address potAt = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xd6), bytes1(0x94), address(this), bytes1(0x02))))));
        RatRaceDistributor d = new RatRaceDistributor(
            p.owner, p.rat, p.signer, p.guardian, p.sentinel, potAt,
            RatRaceDistributor.Limits(p.delay, p.maxStepWithdraw, p.maxStepSettle, p.maxBounty, p.outflowCap, p.burnCap),
            p.distTimings
        );
        RatRacePot q = new RatRacePot(p.owner, p.rat, address(d), p.potSigner, p.guardian, p.nightBps, p.monthBps, p.potTimings);
        if (address(q) != potAt) revert NotLinked();
        d.confirmPot();
        if (!d.potLinked() || q.distributor() != address(d) || d.pot() != address(q)) revert NotLinked();
        // a real distributor with a test pot (or the other way) would pass for real with quick changes
        bool test = d.testMode();
        if (q.testMode() != test) revert MixedTimings();
        distributor = d;
        pot = q;
        testMode = test;
        emit Launched(address(d), address(q), test);
    }
}
