# ramp-receipts

A Soroban contract that publicly records ramp deliveries Rampart has verified on
Stellar. It holds no funds and moves none.

| | |
|---|---|
| Testnet | [`CDJK4Y5OLDZJE566HEYRVGBXT4E56EQC2VT6ZP25436M2BX2YRVWKUYT`](https://stellar.expert/explorer/testnet/contract/CDJK4Y5OLDZJE566HEYRVGBXT4E56EQC2VT6ZP25436M2BX2YRVWKUYT) |
| WASM SHA-256 | `b2eaeb0668f3a439c6da91b59d7be7d272beb8696c0cbafeef266261ca6b1221` (built by CI) |

## Interface

| Function | Who | What |
|---|---|---|
| `record(attester, receipt_id, wallet, direction, provider, asset, amount, tx_hash)` | attester | Write a receipt. `receipt_id` = SHA-256 of the session id; `asset` = Stellar Asset Contract address; `amount` in stroops |
| `mark_refunded(attester, receipt_id, refund_tx_hash?)` | attester | `Delivered` → `Refunded` |
| `get(receipt_id)` · `receipt_for_tx(tx_hash)` | anyone | Read a receipt / find one by its delivery transaction |
| `add_attester` · `remove_attester` · `is_attester` | admin | Manage who can write |
| `set_admin(new_admin)` | admin + new admin | Hand over the admin role |
| `upgrade(wasm_hash)` | admin | Replace the code, keeping storage |

**Rules:** each receipt is written once; one transaction backs at most one
receipt; amounts must be positive. The errors are `NotAttester`,
`AlreadyRecorded`, `TxAlreadyUsed`, `NotFound`, `AlreadyRefunded` and
`InvalidAmount`.

## Build, test, deploy

```sh
cargo test
stellar contract build      # target/wasm32v1-none/release/ramp_receipts.wasm

stellar contract deploy --wasm target/wasm32v1-none/release/ramp_receipts.wasm \
  --source admin --network testnet -- --admin <ADMIN_G...>
stellar contract invoke --id <C...> --source admin --network testnet -- \
  add_attester --attester <ATTESTER_G...>
```

Then set `RECEIPTS_CONTRACT_ID` and `RECEIPTS_ATTESTER_SECRET` in the service.
The attester account pays the fees, so keep it funded.
