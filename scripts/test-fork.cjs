const { spawnSync } = require('node:child_process');
const path = require('node:path');

if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error('Use Node 22 or newer for the HyperEVM fork tests');
  process.exit(1);
}
const cli = require.resolve('hardhat/internal/cli/cli');
const result = spawnSync(process.execPath, ['--use-system-ca', cli, '--config', 'hardhat.config.cjs', 'test'], {
  cwd: path.join(__dirname, '..'), stdio: 'inherit',
  env: { ...process.env, FORK_RPC_URL: process.env.FORK_RPC_URL || 'https://rpc.hyperliquid.xyz/evm' },
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
