// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Stands for RatRaceDistributor in the pot's tests: its pot() names the pot it pays, and it plays
/// the potTotal of a checkpoint (publish, then activate: the pot gets what potTotal says beyond potPaid).
contract PotLinkMock {
    struct Checkpoint {
        uint64 epoch;
        uint64 activeAt;
        bytes32 root;
        uint256 withdrawTotal;
        uint256 burnTotal;
        uint256 potTotal;
    }

    address public pot;
    IERC20 public rat;
    uint256 public potPaid;
    Checkpoint public active;
    Checkpoint public pending;
    bool public testMode; // a TEST distributor (a TEST pot needs one, a real pot never)

    constructor(address pot_) {
        pot = pot_;
    }

    function setRat(IERC20 rat_) external {
        rat = rat_;
    }

    function setTestMode(bool t) external {
        testMode = t;
    }

    function publish(uint256 potTotal) external {
        pending = Checkpoint(active.epoch + 1, uint64(block.timestamp), bytes32(0), 0, 0, potTotal);
    }

    function activate() external {
        uint256 n = pending.potTotal - potPaid;
        active = pending;
        delete pending;
        potPaid = active.potTotal;
        if (n != 0) rat.transfer(pot, n);
    }
}
