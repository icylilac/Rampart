//! Ramp receipts: a public, append-only record of ramp deliveries that
//! Ricerca Ramp has verified on Stellar.
//!
//! The contract holds no funds and never moves any; the ramp stays
//! non-custodial. After a live session completes and its delivery transaction
//! is checked against Horizon, the service's attester key records a receipt
//! here: which session, which wallet, which asset (its Stellar Asset Contract
//! address), how much arrived and in which transaction. A wallet, project or
//! auditor can then look the delivery up on-chain instead of trusting the
//! service's database.
//!
//! - Only attesters the admin added can record or update receipts.
//! - A receipt is written once; it can only move from `Delivered` to
//!   `Refunded`, mirroring the session lifecycle (`COMPLETED -> REFUNDED`).
//! - One Stellar transaction backs at most one receipt, so the same payment
//!   can't be claimed as the delivery of two sessions.
#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, BytesN, Env,
    Symbol,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// The caller isn't one of the admin's attesters.
    NotAttester = 1,
    /// A receipt for this session already exists.
    AlreadyRecorded = 2,
    /// Another session's receipt already uses this delivery transaction.
    TxAlreadyUsed = 3,
    /// No receipt for this session.
    NotFound = 4,
    /// The receipt is already refunded.
    AlreadyRefunded = 5,
    /// Amounts are in stroops and must be positive.
    InvalidAmount = 6,
}

/// Which way the money moved.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Direction {
    /// Fiat to crypto: the asset was delivered to the user's wallet.
    On,
    /// Crypto to fiat: the wallet paid the asset to the provider or anchor.
    Off,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReceiptStatus {
    Delivered,
    /// Refunded by the provider; holds the refund's transaction, if any.
    Refunded(Option<BytesN<32>>),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Receipt {
    /// The attester that recorded it.
    pub attester: Address,
    /// The user's Stellar account.
    pub wallet: Address,
    pub direction: Direction,
    /// Provider name, e.g. `STRIPE`, `MOONPAY`, `ANCHOR`.
    pub provider: Symbol,
    /// Stellar Asset Contract address of the delivered asset.
    pub asset: Address,
    /// Delivered amount verified on Stellar, in stroops (7 decimals).
    pub amount: i128,
    /// The Stellar transaction that delivered it.
    pub tx_hash: BytesN<32>,
    pub status: ReceiptStatus,
    /// Ledger timestamp when the receipt was recorded.
    pub recorded_at: u64,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Instance storage: who manages attesters and upgrades.
    Admin,
    Attester(Address),
    /// Receipt by receipt id (SHA-256 of the session id).
    Receipt(BytesN<32>),
    /// Receipt id by delivery transaction hash.
    Tx(BytesN<32>),
}

const DAY_IN_LEDGERS: u32 = 17280;
const TTL_THRESHOLD: u32 = DAY_IN_LEDGERS * 30;
const TTL_EXTEND: u32 = DAY_IN_LEDGERS * 180;

#[contract]
pub struct RampReceipts;

fn admin(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .expect("admin is set by the constructor")
}

fn bump(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND);
}

fn require_attester(env: &Env, attester: &Address) -> Result<(), Error> {
    attester.require_auth();
    let key = DataKey::Attester(attester.clone());
    if !env.storage().persistent().get(&key).unwrap_or(false) {
        return Err(Error::NotAttester);
    }
    bump(env, &key);
    Ok(())
}

#[contractimpl]
impl RampReceipts {
    /// Sets the admin, who adds and removes attesters and upgrades the
    /// contract. Runs once, at deploy.
    pub fn __constructor(env: Env, admin: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    pub fn admin(env: Env) -> Address {
        admin(&env)
    }

    /// Hands the admin role to another account. Both must sign, so the role
    /// can't be given to an address nobody controls.
    pub fn set_admin(env: Env, new_admin: Address) {
        admin(&env).require_auth();
        new_admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        env.events()
            .publish((symbol_short!("admin"),), new_admin);
    }

    pub fn add_attester(env: Env, attester: Address) {
        admin(&env).require_auth();
        let key = DataKey::Attester(attester.clone());
        env.storage().persistent().set(&key, &true);
        bump(&env, &key);
        env.events()
            .publish((symbol_short!("attester"), symbol_short!("added")), attester);
    }

    /// Stops an attester recording new receipts. Receipts it already recorded stay.
    pub fn remove_attester(env: Env, attester: Address) {
        admin(&env).require_auth();
        env.storage()
            .persistent()
            .remove(&DataKey::Attester(attester.clone()));
        env.events()
            .publish((symbol_short!("attester"), symbol_short!("removed")), attester);
    }

    pub fn is_attester(env: Env, attester: Address) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::Attester(attester))
            .unwrap_or(false)
    }

    /// Records a verified delivery. `receipt_id` is the SHA-256 of the
    /// session id; `amount` is in stroops.
    #[allow(clippy::too_many_arguments)]
    pub fn record(
        env: Env,
        attester: Address,
        receipt_id: BytesN<32>,
        wallet: Address,
        direction: Direction,
        provider: Symbol,
        asset: Address,
        amount: i128,
        tx_hash: BytesN<32>,
    ) -> Result<Receipt, Error> {
        require_attester(&env, &attester)?;
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let key = DataKey::Receipt(receipt_id.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::AlreadyRecorded);
        }
        let tx_key = DataKey::Tx(tx_hash.clone());
        if env.storage().persistent().has(&tx_key) {
            return Err(Error::TxAlreadyUsed);
        }

        let receipt = Receipt {
            attester,
            wallet: wallet.clone(),
            direction,
            provider,
            asset,
            amount,
            tx_hash,
            status: ReceiptStatus::Delivered,
            recorded_at: env.ledger().timestamp(),
        };
        env.storage().persistent().set(&key, &receipt);
        env.storage().persistent().set(&tx_key, &receipt_id);
        bump(&env, &key);
        bump(&env, &tx_key);
        env.events().publish(
            (symbol_short!("receipt"), symbol_short!("recorded"), receipt_id),
            (wallet, receipt.amount),
        );
        Ok(receipt)
    }

    /// Marks a delivered receipt refunded, with the refund's transaction if
    /// it happened on Stellar.
    pub fn mark_refunded(
        env: Env,
        attester: Address,
        receipt_id: BytesN<32>,
        refund_tx_hash: Option<BytesN<32>>,
    ) -> Result<Receipt, Error> {
        require_attester(&env, &attester)?;
        let key = DataKey::Receipt(receipt_id.clone());
        let mut receipt: Receipt = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)?;
        if receipt.status != ReceiptStatus::Delivered {
            return Err(Error::AlreadyRefunded);
        }
        receipt.status = ReceiptStatus::Refunded(refund_tx_hash);
        env.storage().persistent().set(&key, &receipt);
        bump(&env, &key);
        env.events().publish(
            (symbol_short!("receipt"), symbol_short!("refunded"), receipt_id),
            receipt.wallet.clone(),
        );
        Ok(receipt)
    }

    pub fn get(env: Env, receipt_id: BytesN<32>) -> Option<Receipt> {
        env.storage().persistent().get(&DataKey::Receipt(receipt_id))
    }

    /// The receipt id a delivery transaction backs, if any.
    pub fn receipt_for_tx(env: Env, tx_hash: BytesN<32>) -> Option<BytesN<32>> {
        env.storage().persistent().get(&DataKey::Tx(tx_hash))
    }

    /// Replaces the contract's code; storage is kept. Admin only.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        admin(&env).require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }
}

#[cfg(test)]
mod test;
