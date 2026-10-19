extern crate std;

use super::*;
use soroban_sdk::testutils::{Address as _, AuthorizedFunction, Events, Ledger};
use soroban_sdk::{symbol_short, vec, IntoVal};

struct Setup {
    env: Env,
    client: RampReceiptsClient<'static>,
    admin: Address,
    attester: Address,
    wallet: Address,
    asset: Address,
}

fn setup() -> Setup {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_760_000_000);
    let admin = Address::generate(&env);
    let attester = Address::generate(&env);
    let id = env.register(RampReceipts, (&admin,));
    let client = RampReceiptsClient::new(&env, &id);
    client.add_attester(&attester);
    let wallet = Address::generate(&env);
    let asset = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    Setup { env, client, admin, attester, wallet, asset }
}

fn id(env: &Env, n: u8) -> BytesN<32> {
    BytesN::from_array(env, &[n; 32])
}

impl Setup {
    fn record(&self, receipt: u8, tx: u8) -> Result<Receipt, Error> {
        self.client
            .try_record(
                &self.attester,
                &id(&self.env, receipt),
                &self.wallet,
                &Direction::On,
                &symbol_short!("STRIPE"),
                &self.asset,
                &250_000_000,
                &id(&self.env, tx),
            )
            .map(|r| r.unwrap())
            .map_err(|e| e.unwrap())
    }
}

#[test]
fn records_a_delivery_and_finds_it_by_session_and_by_tx() {
    let s = setup();
    let receipt = s.record(1, 101).unwrap();
    assert_eq!(receipt.status, ReceiptStatus::Delivered);
    assert_eq!(receipt.amount, 250_000_000);
    assert_eq!(receipt.recorded_at, 1_760_000_000);
    assert_eq!(receipt.attester, s.attester);
    assert_eq!(s.client.get(&id(&s.env, 1)), Some(receipt));
    assert_eq!(s.client.receipt_for_tx(&id(&s.env, 101)), Some(id(&s.env, 1)));
    assert_eq!(s.client.get(&id(&s.env, 2)), None);
    assert_eq!(s.client.receipt_for_tx(&id(&s.env, 102)), None);
}

#[test]
fn record_needs_the_attesters_signature() {
    let s = setup();
    s.record(1, 101).unwrap();
    let auths = s.env.auths();
    assert_eq!(auths.len(), 1);
    let (who, invocation) = &auths[0];
    assert_eq!(who, &s.attester);
    assert!(matches!(
        &invocation.function,
        AuthorizedFunction::Contract((_, name, _)) if *name == Symbol::new(&s.env, "record")
    ));
}

#[test]
fn only_attesters_can_record() {
    let s = setup();
    let stranger = Address::generate(&s.env);
    let err = s
        .client
        .try_record(
            &stranger,
            &id(&s.env, 1),
            &s.wallet,
            &Direction::On,
            &symbol_short!("STRIPE"),
            &s.asset,
            &1,
            &id(&s.env, 101),
        )
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::NotAttester);

    s.client.remove_attester(&s.attester);
    assert!(!s.client.is_attester(&s.attester));
    assert_eq!(s.record(1, 101).unwrap_err(), Error::NotAttester);
}

#[test]
fn a_receipt_is_written_once() {
    let s = setup();
    s.record(1, 101).unwrap();
    assert_eq!(s.record(1, 102).unwrap_err(), Error::AlreadyRecorded);
}

#[test]
fn one_transaction_backs_one_receipt() {
    let s = setup();
    s.record(1, 101).unwrap();
    assert_eq!(s.record(2, 101).unwrap_err(), Error::TxAlreadyUsed);
}

#[test]
fn amount_must_be_positive() {
    let s = setup();
    for amount in [0_i128, -5] {
        let err = s
            .client
            .try_record(
                &s.attester,
                &id(&s.env, 1),
                &s.wallet,
                &Direction::Off,
                &symbol_short!("ANCHOR"),
                &s.asset,
                &amount,
                &id(&s.env, 101),
            )
            .unwrap_err()
            .unwrap();
        assert_eq!(err, Error::InvalidAmount);
    }
}

#[test]
fn refund_moves_delivered_to_refunded_once() {
    let s = setup();
    s.record(1, 101).unwrap();
    let refunded = s.client.mark_refunded(&s.attester, &id(&s.env, 1), &Some(id(&s.env, 201)));
    assert_eq!(refunded.status, ReceiptStatus::Refunded(Some(id(&s.env, 201))));
    assert_eq!(s.client.get(&id(&s.env, 1)).unwrap().status, refunded.status);
    // The delivery facts don't change.
    assert_eq!(refunded.tx_hash, id(&s.env, 101));
    assert_eq!(refunded.amount, 250_000_000);

    let again = s
        .client
        .try_mark_refunded(&s.attester, &id(&s.env, 1), &None)
        .unwrap_err()
        .unwrap();
    assert_eq!(again, Error::AlreadyRefunded);
    let missing = s
        .client
        .try_mark_refunded(&s.attester, &id(&s.env, 9), &None)
        .unwrap_err()
        .unwrap();
    assert_eq!(missing, Error::NotFound);
}

#[test]
fn removed_attesters_receipts_stay() {
    let s = setup();
    s.record(1, 101).unwrap();
    s.client.remove_attester(&s.attester);
    assert!(s.client.get(&id(&s.env, 1)).is_some());
}

#[test]
fn attester_management_needs_the_admin() {
    let s = setup();
    let other = Address::generate(&s.env);
    s.client.add_attester(&other);
    let auths = s.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, s.admin);
    assert!(s.client.is_attester(&other));
}

#[test]
#[should_panic]
fn attester_management_fails_without_the_admin() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let id = env.register(RampReceipts, (&admin,));
    let client = RampReceiptsClient::new(&env, &id);
    client.add_attester(&Address::generate(&env));
}

#[test]
fn set_admin_needs_both_accounts() {
    let s = setup();
    let next = Address::generate(&s.env);
    s.client.set_admin(&next);
    let signers: std::vec::Vec<Address> = s.env.auths().into_iter().map(|(a, _)| a).collect();
    assert_eq!(signers, std::vec![s.admin.clone(), next.clone()]);
    assert_eq!(s.client.admin(), next);
}

#[test]
fn record_emits_an_event() {
    let s = setup();
    s.record(1, 101).unwrap();
    let last = s.env.events().all().last().unwrap();
    assert_eq!(
        last.1,
        vec![
            &s.env,
            symbol_short!("receipt").into_val(&s.env),
            symbol_short!("recorded").into_val(&s.env),
            id(&s.env, 1).into_val(&s.env),
        ]
    );
}
