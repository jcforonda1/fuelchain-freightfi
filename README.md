# FreightFi — Decentralized Freight Payment Settlement on XRPL

> Proof-of-concept for GPS-triggered, escrow-backed freight payments on the XRP Ledger Testnet.  
> Built as part of an XRPL Grant application.

---

## The Problem

Cross-border freight in Latin America runs on manual, trust-based payment flows:

1. A trucking company hauls goods (fuel, produce, industrial cargo) hundreds of kilometers.
2. Payment is released days or weeks after delivery — if at all.
3. There is no tamper-proof record of when the truck arrived, what it carried, or whether payment was made.

Disputes are common. Cash-flow gaps force drivers to operate at a loss between runs. No neutral third party enforces delivery-triggers-payment.

## The Solution

FreightFi uses XRPL's native **Escrow** and **Memo** features to create a trustless freight settlement layer:

- The **company** locks the freight fee in an on-chain escrow with a cryptographic condition and a 48-hour deadline.
- The **driver** claims the escrow only when a GPS oracle confirms arrival at the destination.
- If the driver never arrives, the company recovers the funds after the timeout — automatically, without intermediaries.
- Every event (shipment metadata, GPS confirmation, payment trigger) is permanently recorded as a **Memo** attached to each transaction.

No smart contract platform required. No bridge. No token. Pure XRPL.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                      FreightFi Protocol                          │
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

## Modules

### `index.js` — XRPL Connection & Wallet Bootstrap

The entry point. Verifies connectivity to XRPL Testnet and demonstrates wallet generation via the Testnet Faucet.

**What it does:**
- Connects to `wss://s.altnet.rippletest.net:51233` over WebSocket
- Calls `client.fundWallet()` to generate a keypair and fund it with 100 test XRP
- Queries `account_info` to confirm the on-ledger balance in drops and XRP

**XRPL features used:** `account_info` RPC, Testnet Faucet

---

### `freightfi.js` — GPS-Triggered Direct Payment with On-Chain Audit Trail

Simulates the basic freight settlement flow: company pays driver on GPS confirmation, with full shipment metadata embedded in the transaction Memo.

**What it does:**
1. Creates two funded wallets: **EMPRESA** (company) and **CAMIONERO** (driver)
2. Defines a shipment: cargo, route, distance, driver, plate, freight amount
3. Simulates a GPS arrival event (`DESTINATION_REACHED`) with timestamp, coordinates, speed, odometer, and geofence trigger
4. Constructs a `Payment` transaction with a structured JSON Memo containing the full GPS payload
5. Submits and confirms on the ledger, then reads the Memo back to verify on-chain integrity

**XRPL features used:** `Payment` transaction, `Memos` (MemoType / MemoFormat / MemoData in hex-encoded UTF-8)

**Memo structure:**
```json
{
  "protocol": "FreightFi/1.0",
  "shipment_id": "FF-2026-0001",
  "cargo": "Combustible Industrial (Diesel B5)",
  "route": { "origin": {...}, "destination": {...}, "distance_km": 940 },
  "gps_confirmation": {
    "event": "DESTINATION_REACHED",
    "timestamp": "2026-06-05T02:10:32.274Z",
    "coordinates": { "lat": 19.4326, "lon": -99.1332 },
    "speed_kmh": 0,
    "geofence_triggered": true
  },
  "payment_trigger": "GPS_ARRIVAL_CONFIRMED"
}
```

---

### `escrow.js` — Conditional Escrow with 48-Hour Timeout

The core FreightFi primitive. Implements trustless freight payment using XRPL's native `EscrowCreate` / `EscrowFinish` / `EscrowCancel` transactions backed by a **PREIMAGE-SHA-256** crypto-condition.

**What it does:**

| Step | Action | Detail |
|------|--------|--------|
| 1 | Create wallets | EMPRESA and CAMIONERO funded via faucet |
| 2 | Generate crypto-condition | 32-byte random preimage → ASN.1 DER Fulfillment + Condition |
| 3 | `EscrowCreate` | Locks 10 XRP on-chain with `Condition` + `CancelAfter = now + 48h` |
| 4 | `account_objects` | Verifies the live `Escrow` ledger object |
| 5 | Simulate GPS arrival | `DESTINATION_REACHED` event with full telemetry |
| 6 | `EscrowFinish` | Driver presents the Fulfillment → funds released, GPS payload stored in Memo |
| 7 | Balance audit | Confirms EMPRESA paid flete + fee; CAMIONERO received flete minus finish fee |
| 8 | On-chain memo audit | Both transaction Memos decoded and printed from the ledger |
| 9 | Timeout path | Shows exact `EscrowCancel` structure and ledger enforcement rules |

**XRPL features used:** `EscrowCreate`, `EscrowFinish`, `EscrowCancel`, `account_objects` RPC, `tx` RPC, `Memos`

**Crypto-condition encoding (no external library — pure Node.js `crypto`):**

```
Fulfillment (36 bytes):
  A0 22        ← PREIMAGE-SHA-256 tag + inner length (34)
  80 20        ← preimage field tag + length (32)
  <32-byte random preimage>

Condition (39 bytes):
  A0 25        ← PREIMAGE-SHA-256 tag + inner length (37)
  80 20        ← fingerprint tag + length (32)
  <SHA-256(preimage)>
  81 01 20     ← max-fulfillment-length = 32
```

**EscrowFinish fee formula** (enforced by the ledger):
```
fee_drops = 12 + 320 × ⌈fulfillment_bytes / 16⌉
          = 12 + 320 × ⌈36 / 16⌉
          = 12 + 320 × 3
          = 972 drops  (0.000972 XRP)
```

**Timeout / cancellation rules (enforced by the XRPL ledger, not by code):**
- `EscrowCancel` can only succeed **after** `CancelAfter`
- `EscrowFinish` can only succeed **before** `CancelAfter`
- These two paths are mutually exclusive — the ledger guarantees it

---

## Prerequisites

| Requirement | Version |
|-------------|---------|
| Node.js | ≥ 18.0.0 |
| npm | ≥ 9.0.0 |
| Internet | Required (XRPL Testnet WebSocket) |

No XRPL account, private key, or token is needed. All wallets are generated and funded at runtime via the public Testnet Faucet.

---

## Installation

```bash
git clone https://github.com/YOUR_USERNAME/fuelchain-freightfi
cd fuelchain-freightfi
npm install
```

The only dependency is `xrpl` v3 (23 packages total, no native addons):

```json
{
  "dependencies": {
    "xrpl": "^3.0.0"
  }
}
```

---

## Running the Modules

Each module is fully self-contained. Run them independently in order:

### 1. Connectivity check

```bash
node index.js
# or
npm start
```

**Expected output:**
```
Conectando a XRPL Testnet...
Conexion establecida.

Generando wallet de prueba (faucet)...
=== WALLET GENERADA ===
Direccion:  rXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
Balance:    100 XRP
=======================

Balance confirmado en ledger: 100 XRP (100000000 drops)
```

---

### 2. GPS-triggered payment

```bash
node freightfi.js
# or
npm run freightfi
```

**Expected output (abbreviated):**
```
  PASO 5 — Enviando pago EMPRESA → CAMIONERO
  Hash            : 5140F144F8FB...
  Estado          : tesSUCCESS ✓
  Monto flete     : 10 XRP

  PASO 7 — Verificar memo registrado on-chain
  MemoType        : freightfi/gps-delivery
  MemoData: { "shipment_id": "FF-2026-0001", "gps_confirmation": {...} }
```

---

### 3. Conditional escrow (full flow)

```bash
node escrow.js
# or
npm run escrow
```

**Expected output (abbreviated):**
```
  PASO 3 — EscrowCreate
  Hash EscrowCreate  : CA6F239A400B...
  Estado             : tesSUCCESS ✓

  PASO 4 — Verificar escrow en account_objects
  Tipo de objeto     : Escrow
  Monto congelado    : 10 XRP

  PASO 6 — EscrowFinish
  Hash EscrowFinish  : 0B152845ABC7...
  Estado             : tesSUCCESS ✓

  PASO 7 — Balances post-escrow
  EMPRESA  : 89.999988 XRP  (−10 flete −fee escrow)
  CAMIONERO: 109.999028 XRP (+10 flete −fee finish)
```

> **Note:** Each run generates fresh wallets via the Testnet Faucet. Execution takes 30–90 seconds depending on Testnet ledger close times (~3–4 s per ledger).

---

## Verifying Transactions On-Chain

All transactions can be verified on the XRPL Testnet Block Explorer.

Each run prints the transaction hash. To inspect it:

```
https://testnet.xrpl.org/transactions/<HASH>
```

The Memo field is visible under the transaction detail page. Decode the hex values to retrieve the full GPS and shipment payload embedded on-chain.

---

## Technical Notes for Reviewers

### xrpl v3 API change: `unixTimeToRippleTime` takes milliseconds

In `xrpl` v3, `unixTimeToRippleTime(timestamp)` expects a Unix timestamp in **milliseconds** (it divides by 1000 internally). Previous versions accepted seconds. Passing seconds produces a negative Ripple time that the binary codec rejects with:

```
Error: Invalid UInt32: -XXXXXXXXX must be >= 0 and <= 4294967295
```

**Fix applied in `escrow.js`:**
```js
// Correct — pass milliseconds
const cancelAtMS = Date.now() + SHIPMENT.timeout_hours * 3_600_000;
CancelAfter: unixTimeToRippleTime(cancelAtMS),

// Wrong — would pass seconds and produce a negative Ripple time
// CancelAfter: unixTimeToRippleTime(Math.floor(Date.now() / 1000) + 172800),
```

### Crypto-condition: no external dependencies

The PREIMAGE-SHA-256 condition/fulfillment encoding uses only Node.js built-in `crypto`. The ASN.1 DER structure is hand-crafted per [RFC 8032 / draft-thomas-crypto-conditions](https://tools.ietf.org/html/draft-thomas-crypto-conditions). No `five-bells-condition` or similar package is required.

### Memo encoding

XRPL requires `MemoType`, `MemoFormat`, and `MemoData` to be uppercase hexadecimal strings of their UTF-8 byte representation:

```js
const toHex = (str) => Buffer.from(str, "utf8").toString("hex").toUpperCase();
```

---

## Project Structure

```
fuelchain-freightfi/
├── index.js        ← Module 1: XRPL connectivity + wallet bootstrap
├── freightfi.js    ← Module 2: GPS-triggered Payment + on-chain Memo
├── escrow.js       ← Module 3: Conditional EscrowCreate/Finish/Cancel
├── package.json
└── README.md
```

---

## Roadmap

This proof-of-concept demonstrates the core on-chain primitives. The following extensions are planned for the full grant deliverable:

| Phase | Feature |
|-------|---------|
| v0.2 | Real GPS integration via IoT device or mobile SDK (replace simulation) |
| v0.3 | Multi-stop routes with partial escrow releases at each checkpoint |
| v0.4 | Dispute resolution path: third-party oracle signs the Fulfillment |
| v0.5 | Frontend dashboard for companies and drivers to monitor shipment state |
| v1.0 | Mainnet deployment with XRP as settlement currency for Mexico–US corridor |

---

## Why XRPL

| Feature | Why it matters for FreightFi |
|---------|------------------------------|
| Native Escrow | No smart contract platform needed — escrow logic is enforced by the ledger itself |
| PREIMAGE-SHA-256 | Links a physical event (GPS arrival) to fund release via a cryptographic secret |
| Memos | Permanent, cheap on-chain audit trail for every shipment and delivery event |
| 3–4 s finality | Fast enough for real-time delivery confirmation |
| Low fees | ~0.001 XRP per transaction — viable for sub-$100 freight payments |
| Testnet Faucet | Frictionless development and reviewer experience with no setup required |

---

## License

MIT
