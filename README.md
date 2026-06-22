# Vehix — Financial & Logistics Infrastructure for Freight on the XRP Ledger

> GPS-triggered, escrow-backed freight settlement and a full financial layer for Colombian transport — built entirely on native XRP Ledger primitives.
> Originally started as **FreightFi**; evolved into **Vehix**. Built as part of an XRPL Grant application.

[![Built on XRPL](https://img.shields.io/badge/Built%20on-XRP%20Ledger-blue)]()
[![Network](https://img.shields.io/badge/Network-Testnet-green)]()
[![Modules](https://img.shields.io/badge/Modules-12%20live-success)]()
[![License](https://img.shields.io/badge/License-MIT-lightgrey)]()

---

## What is Vehix?

Vehix is an infrastructure project for the freight-transport sector in Colombia, built on the XRP Ledger. It is **not** a blockchain project that happens to touch transport — it is a transport-infrastructure project that **requires** XRPL to work.

It solves real problems that affect hundreds of thousands of truckers: 90-day payment delays, fuel-subsidy fraud, lack of insurance, and no access to credit. Every freight trip becomes verifiable on-chain value: payments, insurance, fuel-subsidy control, factoring, and carbon credits.

**Founder's vision:** technology must improve the lives of the people in the sector. The difference between a driver who gets paid in ninety days and one who gets paid in minutes is not a feature — it is a better life.

---

## Proof of code: 12 live modules (~99 Testnet transactions, all `tesSUCCESS`)

The project began as **FreightFi** (the three core modules below) and grew into the full **Vehix** platform. Every module uses native XRPL primitives — no external smart contracts.

| # | Module | File | Tx | What it does |
|---|--------|------|----|--------------|
| 1 | XRPL Connection | `index.js` | 1 | Base connection & wallet bootstrap |
| 2 | Vehix Pay (FreightFi) | `freightfi.js` | 3 | GPS-triggered freight payment |
| 3 | Pay Escrow | `escrow.js` | 4 | Conditional freight escrow (48h) |
| 4 | Oracle Multisig | `oracle-multisig.js` | 3 | 2-of-3 oracle payments |
| 5 | Pay Toll | `toll-oracle.js` | 5 | Toll payments via oracle |
| 6 | Vehix Arb | `dispute-resolution.js` | 7 | Dispute resolution |
| 7 | Vehix Factor (RADIAN) | `radian-factoring.js` | 10 | Invoice factoring (MPT) |
| 8 | Vehix Gov | `govescrow.js` | 11 | Grant-milestone escrow |
| 9 | Vehix Fuel (ACPM) | `acpm-oracle.js` | 10 | Fuel-subsidy control, 4-node oracle |
| 10 | Vehix Load | `cargo-bank.js` | 8 | Cargo bank / load board |
| 11 | Vehix Shield (SOAT) | `soat-defi.js` | 21 | Tokenized multi-fleet insurance (MPT) |
| 12 | VehixPoints (VXP) | `vehix-points.js` | 16 | Loyalty points (transferable MPT) |

**New modules (validated, ready to run on Testnet):**

| # | Module | File | What it does |
|---|--------|------|--------------|
| 13 | FOPAT Vault Oracle | `fopat-vault-oracle.js` | 25% FOPAT contribution via XLS-65 vault + 2-of-3 oracle escrow |
| 14 | Carbon MPT Settlement | `carbon-mpt-settlement.js` | Tokenizes CO2 as MPT, settles with European buyer by verified tonnage |
| - | Milestone Payment Escrow | `milestone-payment-escrow.js` | Pays the dev team by milestones via native escrow |

---

## The Problem (FreightFi core)

Cross-border freight in Latin America runs on manual, trust-based payment flows:

1. A trucking company hauls goods (fuel, produce, industrial cargo) hundreds of kilometers.
2. Payment is released days or weeks after delivery — if at all.
3. There is no tamper-proof record of when the truck arrived, what it carried, or whether payment was made.

Disputes are common. Cash-flow gaps force drivers to operate at a loss between runs. No neutral third party enforces delivery-triggers-payment.

## The Solution

Vehix uses XRPL's native **Escrow** and **Memo** features to create a trustless freight settlement layer:

- The **company** locks the freight fee in an on-chain escrow with a cryptographic condition and a 48-hour deadline.
- The **driver** claims the escrow only when a GPS oracle confirms arrival at the destination.
- If the driver never arrives, the company recovers the funds after the timeout — automatically, without intermediaries.
- Every event (shipment metadata, GPS confirmation, payment trigger) is permanently recorded as a **Memo**.

No smart contract platform required. No bridge. No external token. Pure XRPL.

---

## Architecture (core escrow flow)

```
┌──────────────────────────────────────────────────────────────────┐
│                      FreightFi / Vehix Protocol                  │
│                                                                  │
│   COMPANY (Wallet A)           DRIVER (Wallet B)                 │
│         │                              │                         │
│         │  1. EscrowCreate             │                         │
│         │  Amount: 10 XRP              │                         │
│         │  Condition: SHA256(secret)   │                         │
│         │  CancelAfter: +48h           │                         │
│         ▼                              │                         │
│  ┌─────────────────────────────────┐   │                         │
│  │   XRPL Ledger — Escrow Object   │   │                         │
│  │   Amount    : 10,000,000 drops  │   │                         │
│  │   Condition : PREIMAGE-SHA-256  │   │                         │
│  │   CancelAfter: Ripple timestamp │   │                         │
│  └─────────────────────────────────┘   │                         │
│                                        │                         │
│   GPS Oracle ──► DESTINATION_REACHED   │                         │
│                  reveals Fulfillment ──►│                         │
│                                        │  2. EscrowFinish        │
│                                        │  Fulfillment: secret    │
│                                        │  Memo: GPS payload      │
│                                        ▼                         │
│                              Driver receives 10 XRP              │
│                                                                  │
│   ── Timeout path ──────────────────────────────────────────     │
│   After CancelAfter:  Company sends EscrowCancel                 │
│                       → 10 XRP returned to Company               │
└──────────────────────────────────────────────────────────────────┘
```

---

## Core Modules (detailed)

### `index.js` — XRPL Connection & Wallet Bootstrap
Verifies connectivity to XRPL Testnet and demonstrates wallet generation via the Testnet Faucet.
- Connects to `wss://s.altnet.rippletest.net:51233` over WebSocket
- Calls `client.fundWallet()` to generate a keypair funded with 100 test XRP
- Queries `account_info` to confirm the on-ledger balance

**XRPL features:** `account_info` RPC, Testnet Faucet

### `freightfi.js` — GPS-Triggered Payment with On-Chain Audit Trail
Company pays driver on GPS confirmation, with full shipment metadata embedded in the transaction Memo.
- Creates two funded wallets (company and driver)
- Simulates a GPS arrival event (`DESTINATION_REACHED`) with full telemetry
- Constructs a `Payment` with a structured JSON Memo containing the GPS payload
- Reads the Memo back to verify on-chain integrity

**XRPL features:** `Payment` transaction, `Memos` (hex-encoded UTF-8)

### `escrow.js` — Conditional Escrow with 48-Hour Timeout
The core primitive: trustless freight payment using `EscrowCreate` / `EscrowFinish` / `EscrowCancel` backed by a **PREIMAGE-SHA-256** crypto-condition.

| Step | Action |
|------|--------|
| 1 | Create wallets via faucet |
| 2 | Generate crypto-condition (32-byte preimage → ASN.1 DER) |
| 3 | `EscrowCreate` locks 10 XRP with `Condition` + `CancelAfter` |
| 4 | Verify the live `Escrow` ledger object |
| 5 | Simulate GPS arrival with full telemetry |
| 6 | `EscrowFinish` — driver presents the Fulfillment, funds released |
| 7 | Balance audit |
| 8 | On-chain memo audit |
| 9 | Timeout path (`EscrowCancel` rules) |

**XRPL features:** `EscrowCreate`, `EscrowFinish`, `EscrowCancel`, `account_objects`, `tx`, `Memos`

---

## Why native XRPL primitives (not smart contracts)

| Feature | Why it matters |
|---------|----------------|
| Native Escrow | No smart-contract platform needed — escrow logic is enforced by the ledger itself |
| PREIMAGE-SHA-256 | Links a physical event (GPS arrival) to fund release via a cryptographic secret |
| Multisign | 2-of-3 oracle validation for anti-fraud (FOPAT, disputes) |
| MPT | Tokenized insurance, carbon credits, and loyalty points |
| Memos | Permanent, cheap on-chain audit trail (DIAN-compliant) |
| 3-4 s finality | Fast enough for real-time delivery confirmation |
| Low fees | <USD 0.01 per transaction — viable for sub-\$100 freight payments |

The advantage in numbers: zero smart-contract attack surface (no reentrancy, no flash-loan exploits), >USD 20,000 in audits avoided, and ~99.9% cheaper than the up-to-COP 45,000 per disbursement of a traditional Colombian trust.

---

## Prerequisites

| Requirement | Version |
|-------------|---------|
| Node.js | >= 18.0.0 (v22 recommended) |
| npm | >= 9.0.0 |
| Internet | Required (XRPL Testnet WebSocket) |

No XRPL account, private key, or token is needed for the core modules. Wallets are generated and funded at runtime via the public Testnet Faucet.

## Installation

```bash
git clone https://github.com/jcforonda1/fuelchain-freightfi
cd fuelchain-freightfi
npm install
```

The core dependency is `xrpl` v3. The new modules (13-14) additionally use `five-bells-condition` for crypto-conditions:

```bash
npm install xrpl five-bells-condition
```

## Running the Modules

Each module is fully self-contained:

```bash
node index.js        # 1. Connectivity check
node freightfi.js    # 2. GPS-triggered payment
node escrow.js       # 3. Conditional escrow (full flow)
# ...and so on for the other modules
```

> Each run generates fresh wallets via the Testnet Faucet. Execution takes 30-90 seconds depending on Testnet ledger close times (~3-4 s per ledger).

---

## Verifying Transactions On-Chain

Each run prints the transaction hash. Inspect it at:

```
https://testnet.xrpl.org/transactions/<HASH>
```

The Memo field is visible on the transaction detail page. Decode the hex values to retrieve the full GPS and shipment payload embedded on-chain.

---

## Technical Notes for Reviewers

**xrpl v3 API change — `unixTimeToRippleTime` takes milliseconds.** In `xrpl` v3, this function expects a Unix timestamp in **milliseconds**. Passing seconds produces a negative Ripple time the binary codec rejects.

```js
// Correct — pass milliseconds
const cancelAtMS = Date.now() + SHIPMENT.timeout_hours * 3_600_000;
CancelAfter: unixTimeToRippleTime(cancelAtMS),
```

**Memo encoding.** XRPL requires `MemoType`, `MemoFormat`, and `MemoData` to be uppercase hexadecimal strings of their UTF-8 bytes:

```js
const toHex = (str) => Buffer.from(str, "utf8").toString("hex").toUpperCase();
```

---

## Roadmap

The 12 modules prove the technology works. The grant would fund the next stage:

| Phase | Feature |
|-------|---------|
| Q3 2026 | Independent audit + pilot with 50 trucks (Bogota-Buenaventura corridor) |
| Q4 2026 | Integration with RNDC + SICOM (national logistics & fuel systems) |
| Q1 2027 | Mainnet launch + SOAT MPT with a regulated insurer |
| Q2 2027 | Opening of the financing pool |

**Resilient by design:** Vehix advances with or without this grant — it is also applying to Colombian national programs (iNNpulsa, MinTIC Digital Entrepreneurship, SENA). Whatever the funding source, resources are managed on XRPL via the same escrow and milestone-payment system.

---

## Team

**Juan Carlos Foronda Velez** — Founder & product lead. Built the complete proof of concept (12 modules on XRPL Testnet), learned to develop on XRPL from scratch, and designed Vehix around firsthand knowledge of the Colombian freight sector.

*Backend developer(s) joining under a milestone-based model.*

---

## License

MIT

---

*Colombia · 2026 · Built to improve the lives of the people who move the country.*
