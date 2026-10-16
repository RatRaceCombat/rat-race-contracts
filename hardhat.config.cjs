require('@nomicfoundation/hardhat-ethers');
require('@nomicfoundation/hardhat-chai-matchers');
const networkFlag = process.argv.indexOf('--network');
const selectedNetwork = (networkFlag >= 0 ? process.argv[networkFlag + 1] : process.env.HARDHAT_NETWORK) || 'hardhat';
// Keep production wallets out of testnets and local forks, even after .env is created.
const envFile = /testnet/i.test(selectedNetwork) ? '.env.testnet'
  : ['hardhat', 'localhost'].includes(selectedNetwork) ? '.env.local' : '.env';
require('dotenv').config({ path: require('path').join(__dirname, envFile) });

const accounts = process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: '0.8.24',
    settings: { optimizer: { enabled: true, runs: 500 }, evmVersion: 'cancun' },
  },
  networks: {
    hardhat: {
      chainId: 31337,
      ...(process.env.FORK_RPC_URL ? {
        forking: {
          url: process.env.FORK_RPC_URL,
          ...(process.env.FORK_BLOCK_NUMBER ? { blockNumber: Number(process.env.FORK_BLOCK_NUMBER) } : {}),
        },
      } : {}),
    },
    localhost: { url: process.env.LOCAL_RPC_URL || 'http://127.0.0.1:8545', chainId: 31337 },
    // Hyperliquid HyperEVM
    hyperevmTestnet: { url: process.env.HYPEREVM_TESTNET_RPC || 'https://rpc.hyperliquid-testnet.xyz/evm', chainId: 998, accounts },
    hyperevm: { url: process.env.HYPEREVM_RPC || 'https://rpc.hyperliquid.xyz/evm', chainId: 999, accounts },
    // Circle Arc: USDC is the gas coin; USDC ERC-20 interface at 0x3600000000000000000000000000000000000000 (6 decimals)
    arcTestnet: { url: process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network', chainId: 5042002, accounts },
  },
};
