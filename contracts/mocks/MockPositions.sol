// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Local stand-in for HyperSwap's V3 positions contract, as RatPoolLock uses it: position NFTs with a pool
/// (two tokens, a fee) and a liquidity, fees owed that `collect` pays (only from the owner or an approved wallet),
/// and the decrease and burn calls guarded the same way (they must never work for anyone once a position is locked).
contract MockPositions is ERC721 {
    struct Pos {
        address token0;
        address token1;
        uint24 fee;
        uint128 liquidity;
        uint128 owed0;
        uint128 owed1;
    }

    mapping(uint256 => Pos) public pos;
    uint256 public nextId = 1;

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    constructor() ERC721("Mock Positions", "MPOS") {}

    function mint(address to, address token0, address token1, uint24 fee, uint128 liquidity) external returns (uint256 id) {
        id = nextId++;
        pos[id] = Pos(token0, token1, fee, liquidity, 0, 0);
        _safeMint(to, id);
    }

    /// @dev Fees the position earned (the tokens must be held by this contract to be paid).
    function accrue(uint256 id, uint128 a0, uint128 a1) external {
        pos[id].owed0 += a0;
        pos[id].owed1 += a1;
    }

    function positions(uint256 id)
        external
        view
        returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128)
    {
        Pos memory p = pos[id];
        return (0, address(0), p.token0, p.token1, p.fee, -887220, 887220, p.liquidity, 0, 0, p.owed0, p.owed1);
    }

    function collect(CollectParams calldata c) external payable returns (uint256 a0, uint256 a1) {
        require(_isAuthorized(ownerOf(c.tokenId), msg.sender, c.tokenId), "Not approved");
        Pos storage p = pos[c.tokenId];
        a0 = p.owed0 < c.amount0Max ? p.owed0 : c.amount0Max;
        a1 = p.owed1 < c.amount1Max ? p.owed1 : c.amount1Max;
        p.owed0 -= uint128(a0);
        p.owed1 -= uint128(a1);
        if (a0 > 0) IERC20(p.token0).transfer(c.recipient, a0);
        if (a1 > 0) IERC20(p.token1).transfer(c.recipient, a1);
    }

    function decreaseLiquidity(uint256 id, uint128 liquidity) external {
        require(_isAuthorized(ownerOf(id), msg.sender, id), "Not approved");
        pos[id].liquidity -= liquidity;
    }

    function burn(uint256 id) external {
        require(_isAuthorized(ownerOf(id), msg.sender, id), "Not approved");
        _burn(id);
    }
}
