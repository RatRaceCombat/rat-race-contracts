// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Stands for RatRacePot in the distributor's tests: it names its distributor (RatRaceDistributor.confirmPot).
contract PotStub {
    address public distributor;

    function setDistributor(address d) external {
        distributor = d;
    }
}
