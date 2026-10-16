// Shared public ABI. Never contains signer keys or backend-only configuration.

/**
 * A Vault copy's id in the collection (RatRaceSuits): VAULT_ID_BASE + the suit's id.
 */
export const VAULT_ID_BASE = 1_000_000;
export const vaultIdOf = (skinId) => VAULT_ID_BASE + Number(skinId);
/** The suit of a collection id: { skin, vault }, or null for an id that is not a suit. */
export const suitOfId = (id) => (Number.isInteger(id) && id >= VAULT_ID_BASE ? { skin: id - VAULT_ID_BASE, vault: true } : Number.isInteger(id) && id >= 0 ? { skin: id, vault: false } : null);
export const SKINS_ABI = [
  'function rat() view returns(address)', 'function usdc() view returns(address)',
  'function rewards() view returns(address)', 'function quoteSigner() view returns(address)', 'function claimSigner() view returns(address)',
  'function minter() view returns(address)', 'function treasury() view returns(address)',
  'function suits() view returns(address)', // (the permanent collection, RatRaceSuits: its vaultTransfersOpen() switch)
  'function buyback() view returns(address)', 'function buybackBps() view returns(uint16)',
  'function paused() view returns(bool)', 'function quoteVersion() view returns(uint256)',
  'function editions(uint256) view returns(uint64 maxSupply,uint64 minted,uint128 priceUsdc,bool usdcSale,bool ratSale,uint128 minRatPrice)',
  'function balanceOfBatch(address[],uint256[]) view returns(uint256[])',
  'function usedOrders(bytes32) view returns(bool)',
  'function buyUsdc(uint256,uint256)',
  'function buyRat((address player,uint256 id,uint256 amount,address referrer,bytes32 orderId,uint256 deadline,uint256 version),bytes)',
  // suits bought with in-game RAT: the game's minter reserves them, the player claims them
  'function reserved(uint256) view returns(uint256)',
  'function minted(uint256) view returns(uint256)',
  'function remaining(uint256) view returns(uint256)',
  'function claimUsed(bytes32) view returns(bool)',
  'function reserveGame(uint256[],uint256[])',
  'function releaseGame(uint256[],uint256[])',
  'function claim(address,uint256,uint256,bytes32,uint256,bytes)',
  'function revokeClaim(bytes32)',
  'event ClaimRevoked(bytes32 indexed claimId,address by)',
  'event RatBought(address indexed player,uint256 indexed id,bytes32 indexed orderId,uint256 paid,uint256 burned,uint256 recycled,uint256 teamPaid,address referrer,uint256 referralPaid)',
  'event Bought(address indexed player,uint256 indexed id,uint256 paid,uint256 toBuyback)',
  'event GameReserved(uint256 indexed id,uint256 amount,uint256 reserved)',
  'event GameReleased(uint256 indexed id,uint256 amount,uint256 reserved)',
  'event Claimed(bytes32 indexed claimId,address indexed to,uint256 indexed id,uint256 amount)',
  'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
  'event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)', // (the collection's, read by the shop's tick)
];
export const RAT_QUOTE_TYPES = { RatQuote: [
  { name:'player',type:'address' }, { name:'id',type:'uint256' },
  { name:'amount',type:'uint256' }, { name:'referrer',type:'address' },
  { name:'orderId',type:'bytes32' }, { name:'deadline',type:'uint256' },
  { name:'version',type:'uint256' },
] };
/** The voucher a player claims a suit bought in the game with (signed by the claim signer, never the quote signer). */
export const CLAIM_TYPES = { Claim: [
  { name:'to',type:'address' }, { name:'id',type:'uint256' },
  { name:'amount',type:'uint256' }, { name:'claimId',type:'bytes32' },
  { name:'deadline',type:'uint256' },
] };
