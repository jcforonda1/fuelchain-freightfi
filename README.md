# Vehix

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