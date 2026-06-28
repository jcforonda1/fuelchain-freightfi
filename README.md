# Vehix

**Financial and logistics infrastructure for freight transport on the XRP Ledger.**

Freight settlement backed by escrow and GPS activation, plus a complete financial layer for Colombian freight transport, built entirely on native XRP Ledger primitives. Originally called **FreightFi**, it evolved into **Vehix**. Developed as part of an XRPL ecosystem application.

`Built on XRPL` · `Testnet` · `Native primitives`

> Versión en español más abajo · [Ir a la versión en español](#vehix-español)

---

## What is Vehix?

Vehix is an infrastructure project for the freight transport sector in Colombia, built on the XRP Ledger. It is not a blockchain project that happens to relate to transport — it is a transport infrastructure project that uses XRPL to function.

It solves real problems affecting hundreds of thousands of truck drivers: 90-day payment delays, fuel subsidy fraud, lack of insurance, and lack of access to credit. Each freight trip becomes verifiable value on-chain: payments, insurance, fuel subsidy control, factoring, and carbon credits.

**Founder's vision:** technology must improve the lives of the people in the sector. The difference between a driver who gets paid in ninety days and one who gets paid in minutes is not a system feature — it is a better quality of life.

---

## Code proof: 13 active modules (~101 transactions on Testnet, all tesSUCCESS)

The project began as FreightFi (the three core modules) and grew into the complete Vehix platform. Each module uses native XRPL primitives, with no external smart contracts.

| # | Module | File | Tx | What it does |
|---|--------|------|----|--------------|
| 1 | XRPL Connection | index.js | 1 | Base connection and wallet bootstrap |
| 2 | Freight Payment (FreightFi) | freightfi.js | 3 | GPS-activated freight payment |
| 3 | Escrow Payment | escrow.js | 4 | Conditional freight escrow (48 h) |
| 4 | Multisig Oracle | oracle-multisig.js | 3 | 2-of-3 oracle payments |
| 5 | Toll Payment | toll-oracle.js | 5 | Oracle-based toll payments |
| 6 | Vehix Arb | dispute-resolution.js | 7 | Dispute resolution |
| 7 | Vehix Factor (RADIAN) | radian-factoring.js | 10 | Invoice factoring (MPT) |
| 8 | Vehix Gov | govescrow.js | 11 | Grant milestone escrow |
| 9 | Vehix Fuel (ACPM) | acpm-oracle.js | 10 | Fuel subsidy control, 4-node oracle |
| 10 | Vehix Cargo | cargo-bank.js | 8 | Cargo bank / load board |
| 11 | Vehix Shield (SOAT) | soat-defi.js | 21 | Tokenized multi-fleet insurance (MPT) |
| 12 | Vehix Points (VXP) | vehix-points.js | 16 | Loyalty points (transferable MPT) |
| 13 | Vehix FOPAT | fopat-vault-oracle.cjs | 2 | Driver protection fund — escrow disbursement + 2-of-3 oracle multisig |

### About module 13 (Vehix FOPAT)

The **Driver Protection Fund** (Fondo de Protección al Transportador) is designed to respect the Colombian legal framework. Instead of taking deposits from the public (which would require a financial license), the model operates through already-authorized solidarity-sector cooperatives, which take deposits from and lend exclusively to their members. The module demonstrates the disbursement of the contribution as an advance credit (not deposit-taking) via native escrow, released with 2-of-3 multisig (anti-fraud) and full traceability in the Memos (national ID, plate, vehicle registry, tax report).

---

## Other modules (validated)

| # | Module | File | What it does |
|---|--------|------|--------------|
| 14 | Carbon MPT Settlement | carbon-mpt-settlement.cjs | Tokenizes CO2 as MPT and settles with the European buyer via verified tonnage |
| - | Milestone Payment | milestone-payment-escrow.cjs | Pays the development team by milestones via native escrow |

---

## Technical stack

- **Blockchain:** XRP Ledger (Testnet)
- **Native primitives:** EscrowCreate/EscrowFinish, SignerListSet (multisig), MPT (Multi-Purpose Tokens), Memos, crypto-conditions (PREIMAGE-SHA-256)
- **Language:** Node.js
- **Libraries:** xrpl, five-bells-condition

---

## Legal note

Modules involving financial flows (FOPAT, factoring, credit) run on Testnet with fictitious funds, as a technical demonstration. Any operation with real money must first be validated by a professional in Colombian financial and cooperative law. This repository is a technical proof of concept.

---
---

<a name="vehix-español"></a>

# Vehix (Español)

**Infraestructura financiera y logística para el transporte de carga en el XRP Ledger.**

Liquidación de fletes con respaldo de depósito en garantía y activación por GPS, más una capa financiera completa para el transporte colombiano, construida íntegramente sobre las primitivas nativas del XRP Ledger. Originalmente llamada **FreightFi**, evolucionó a **Vehix**. Desarrollada como parte de una solicitud al ecosistema XRPL.

`Construido sobre XRPL` · `Red de pruebas (Testnet)` · `Primitivas nativas`

---

## ¿Qué es Vehix?

Vehix es un proyecto de infraestructura para el sector del transporte de carga en Colombia, construido sobre el XRP Ledger. No es un proyecto blockchain que casualmente se relaciona con el transporte, sino un proyecto de infraestructura de transporte que usa XRPL para funcionar.

Resuelve problemas reales que afectan a cientos de miles de camioneros: retrasos de 90 días en los pagos, fraude en los subsidios al combustible, falta de seguro y falta de acceso al crédito. Cada viaje de carga se convierte en valor verificable en la cadena: pagos, seguros, control de subsidios al combustible, factoring y créditos de carbono.

**Visión del fundador:** la tecnología debe mejorar la vida de las personas del sector. La diferencia entre un conductor que cobra en noventa días y otro que cobra en minutos no es una característica del sistema: es una mejor calidad de vida.

---

## Prueba de código: 13 módulos activos (~101 transacciones en Testnet, todas tesSUCCESS)

El proyecto comenzó como FreightFi (los tres módulos principales) y evolucionó hasta la plataforma completa Vehix. Cada módulo usa primitivas nativas del XRPL, sin contratos inteligentes externos.

| # | Módulo | Archivo | Tx | Qué hace |
|---|--------|---------|----|----------|
| 1 | Conexión XRPL | index.js | 1 | Conexión base y arranque de la billetera |
| 2 | Pago de fletes (FreightFi) | freightfi.js | 3 | Pago de fletes activado por GPS |
| 3 | Depósito en garantía | escrow.js | 4 | Depósito de garantía de flete condicional (48 h) |
| 4 | Oráculo multifirma | oracle-multisig.js | 3 | Pagos de oráculo 2 de 3 |
| 5 | Pago de peaje | toll-oracle.js | 5 | Pagos de peaje mediante oráculo |
| 6 | Vehix Arb | dispute-resolution.js | 7 | Resolución de disputas |
| 7 | Vehix Factor (RADIAN) | radian-factoring.js | 10 | Factoring de facturas (MPT) |
| 8 | Vehix Gov | govescrow.js | 11 | Depósito en garantía por hitos de subvención |
| 9 | Vehix Fuel (ACPM) | acpm-oracle.js | 10 | Control de subsidios al combustible, oráculo de 4 nodos |
| 10 | Vehix Cargo | cargo-bank.js | 8 | Banco de carga / tablero de carga |
| 11 | Vehix Shield (SOAT) | soat-defi.js | 21 | Seguro multiflota tokenizado (MPT) |
| 12 | Vehix Points (VXP) | vehix-points.js | 16 | Puntos de fidelidad (MPT transferibles) |
| 13 | Vehix FOPAT | fopat-vault-oracle.cjs | 2 | Fondo de protección al transportador — desembolso vía escrow + multifirma 2 de 3 |

### Sobre el módulo 13 (Vehix FOPAT)

El **Fondo de Protección al Transportador** está diseñado respetando el marco legal colombiano. En lugar de captar dinero del público (lo que requeriría licencia financiera), el modelo opera a través de cooperativas del sector solidario ya autorizadas, que captan y prestan exclusivamente entre sus asociados. El módulo demuestra el desembolso del aporte como crédito por adelantado (no captación) vía escrow nativo, liberado con multifirma 2 de 3 (anti-fraude) y trazabilidad completa en los Memos (cédula, placa, RUNT, DIAN).

---

## Otros módulos (validados)

| # | Módulo | Archivo | Qué hace |
|---|--------|---------|----------|
| 14 | Liquidación MPT de carbono | carbon-mpt-settlement.cjs | Tokeniza el CO2 como MPT y liquida con el comprador europeo mediante tonelaje verificado |
| - | Pago por hitos | milestone-payment-escrow.cjs | Paga al equipo de desarrollo por hitos mediante escrow nativo |

---

## Stack técnico

- **Blockchain:** XRP Ledger (Testnet)
- **Primitivas nativas:** EscrowCreate/EscrowFinish, SignerListSet (multifirma), MPT (Multi-Purpose Tokens), Memos, condiciones criptográficas (PREIMAGE-SHA-256)
- **Lenguaje:** Node.js
- **Librerías:** xrpl, five-bells-condition

---

## Nota legal

Los módulos que involucran flujos financieros (FOPAT, factoring, crédito) operan en la red de pruebas con dinero ficticio, como demostración técnica. Cualquier operación con dinero real debe ser validada previamente por un profesional en derecho financiero y cooperativo colombiano. Este repositorio es una prueba de concepto técnica.