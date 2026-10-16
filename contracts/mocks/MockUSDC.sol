// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @dev Test USDC for local chains and testnets: 6 decimals, EIP-2612 permit, open faucet.
contract MockUSDC is ERC20, ERC20Permit {
    uint256 public constant FAUCET_MAX = 10_000e6;

    constructor() ERC20("USD Coin", "USDC") ERC20Permit("USD Coin") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Anyone can mint test dollars (never deploy this on mainnet).
    function mint(address to, uint256 amount) external {
        require(amount <= FAUCET_MAX, "faucet max");
        _mint(to, amount);
    }
}
