// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Local stand-in for the RAT token (HyperEVM 0xfdc42f844f3aa19f8fc0b2d67d3276cf1efdc4ca, 18 decimals).
contract MockRAT is ERC20 {
    constructor() ERC20("Rat Race Combat", "RAT") {}

    function mint(address to, uint256 amount) external {
        require(amount <= 10_000_000e18, "faucet max");
        _mint(to, amount);
    }
}
