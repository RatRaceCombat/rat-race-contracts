// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Tests only (a copy of rat-usd-feed's): stands in for HyperCore's best-bid-offer precompile (0x...080e).
/// Its runtime code is copied to that address with hardhat_setCode; a query is abi.encode(uint32 asset),
/// with no selector.
contract MockBbo {
    mapping(uint32 => uint64[2]) private quotes;

    function set(uint32 asset, uint64 bid, uint64 ask) external {
        quotes[asset] = [bid, ask];
    }

    fallback(bytes calldata input) external returns (bytes memory) {
        uint64[2] memory q = quotes[abi.decode(input, (uint32))];
        return abi.encode(q[0], q[1]);
    }
}
