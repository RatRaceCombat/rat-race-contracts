// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev A distributor stand-in for SeasonReserveLock's tests: its RAT, its active checkpoint's totals
/// and what it paid of them (RatRaceDistributor's public getters), and a switch to make it revert.
contract OwedMock {
    address public rat;
    uint256 public withdrawTotal;
    uint256 public totalClaimed;
    uint256 public burned;
    uint256 public potPaid;
    bool public broken;
    bool public testMode; // a TEST distributor (a TEST lock needs one, a real lock never)

    constructor(address rat_) {
        rat = rat_;
    }

    /// @dev What the active checkpoint owes: everything published to wallets, nothing paid yet.
    function setOwed(uint256 o) external {
        withdrawTotal = o;
    }

    function setBroken(bool b) external {
        broken = b;
    }

    function setTestMode(bool t) external {
        testMode = t;
    }

    function active() external view returns (uint64 epoch, uint64 activeAt, bytes32 root, uint256 withdraw, uint256 burnTotal, uint256 potTotal) {
        require(!broken, "broken");
        return (1, 1, bytes32(0), withdrawTotal, 0, 0);
    }
}
