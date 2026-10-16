# Rat Race Combat: smart contracts

The HyperEVM contracts behind $RAT, the token of the free-to-play game [Rat Race Combat](https://ratracecombat.com).
Published so anyone can check what they do. The deployed contracts are verified on HyperEVMScan, and the game's
economy page lists their addresses.

| Contract | What it does |
| --- | --- |
| `RatRaceDistributor` | Pays the RAT players withdraw from the game, against signed checkpoints, with daily caps and a guardian that can only slow things down. |
| `RatRacePot` | The Big Cheese pot: filled by what comes back to the game (half the withdrawal fees, part of suit sales), paid out to players. |
| `RatRaceLaunch` | Deploys the distributor and the pot together, linked, in one transaction. |
| `SeasonReserveLock` | Holds the RAT of the seasons after the first. It can only ever send them to the distributor. |
| `FoundersVesting` | A founder's vested RAT: OpenZeppelin VestingWallet, no admin, no revoke. Locked from the deploy; the founder starts the 12 months once, at least 30 days ahead. |
| `FoundersSaleLock` | The founders' RAT for sale: released level by level up a public price grid from $0.025, only once HyperCore's live best bid (read on chain) reaches a level, at most 2,000 RAT an hour and 10,000 a day. Any recovery is announced 30 days ahead in public. `levels(from, count)` reads the grid. |
| `RatRaceHolds` | Staking months: stake RAT, earn the month's Vault suits, get the RAT back intact. |
| `RatRaceSuits`, `RatRaceHolderSuits`, `RatRaceSkins` | The cosmetic suit NFTs and their shop. Cosmetic only: no suit changes what a player earns. |
| `RatPoolLock` | Locks HyperSwap liquidity positions, permanently or with a 14-day public notice. |
| `RatRaceVault` | Not deployed: paid rooms are off. |

Every function says in its NatSpec who can call it, after which delay and within which limits (`@custom:security`).
A contract whose time rules or amounts differ from the real ones reports `testMode() == true` for good.

```sh
npm install && npx hardhat test
```

The tests that run these contracts against the game server's own code (its checkpoint signing, its ledger) and the
deploy scripts that read the game's catalogue stay in the game's private repository.

## License

MIT (see `LICENSE`). The software is provided as is, without warranty of any kind. RAT is a crypto-asset on an open
market: its price can go down as well as up.
