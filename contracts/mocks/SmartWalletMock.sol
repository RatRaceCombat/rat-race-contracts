// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IRatRaceVault {
    function deposit(uint256 gems) external;
    function withdraw(uint256 gems, uint256 nonce, uint256 deadline, bytes calldata signature, bytes calldata cosignature) external;
}

/// @dev Simulates a smart-contract wallet (Safe, AA account...) playing through the vault.
contract SmartWalletMock {
    function doDeposit(IERC20 token, IRatRaceVault vault, uint256 total, uint256 gems) external {
        token.approve(address(vault), total);
        vault.deposit(gems);
    }

    function doWithdraw(IRatRaceVault vault, uint256 gems, uint256 nonce, uint256 deadline, bytes calldata sig) external {
        vault.withdraw(gems, nonce, deadline, sig, "");
    }
}
