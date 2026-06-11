// ─────────────────────────────────────────────────────────────────────────────
// VEHIX SHIELD SUITE — SOAT DeFi Multiflota
//
// MARCO LEGAL:
//   SOAT: Ley 33/1986 + Decreto 663/1993 + Decreto 2497/2022 + Decreto 2312/2023
//   - La Superfinanciera fija tarifas máximas anuales — Vehix NO modifica la tarifa
//   - 52% de la prima va obligatoriamente a ADRES (salud víctimas)
//   - Vehix actúa como intermediario financiero (crédito de consumo) — NO como aseguradora
//   - El MPT es tokenización del recibo RUNT — no reemplaza la póliza de la aseguradora
//   - Proyecto de ley Senador Carreño (2024) propone pago en cuotas — en trámite en Congreso
//   - Vehix implementa técnicamente lo que ese proyecto busca hacer ley
//   - Escala nacional requiere registro PSAV Superfinanciera — Mes 4 del Grant
// ─────────────────────────────────────────────────────────────────────────────

import {
  Client,
  xrpToDrops,
  dropsToXrp,
  encodeMPTokenMetadata,
  decodeAccountID,
} from "xrpl";
import crypto from "crypto";

const TESTNET_URL = "wss://s.altnet.rippletest.net:51233";
const EXPLORER    = "https://testnet.xrpl.org/transactions";

// ── Tabla de vehículos y tarifas SOAT 2026 ───────────────────────────────────

const FLOTA_SOAT = {
  moto_bajo:    { tipo: 'Motocicleta menos 100cc',  prima: 256240,  xrp: 0.0625, fletes_ano: 0,   km_ano: 8000  },
  moto_medio:   { tipo: 'Motocicleta 100-200cc',    prima: 324800,  xrp: 0.0792, fletes_ano: 0,   km_ano: 12000 },
  moto_alto:    { tipo: 'Motocicleta mas 200cc',    prima: 871500,  xrp: 0.2125, fletes_ano: 0,   km_ano: 20000 },
  motocarro:    { tipo: 'Motocarro o tricimoto',    prima: 386900,  xrp: 0.0944, fletes_ano: 24,  km_ano: 15000 },
  camion_c6:    { tipo: 'Camion carga C6',          prima: 380000,  xrp: 0.0927, fletes_ano: 48,  km_ano: 36000 },
  bus_escolar:  { tipo: 'Bus escolar o van',        prima: 946600,  xrp: 0.2309, fletes_ano: 0,   km_ano: 25000 },
  buseta:       { tipo: 'Buseta urbana',            prima: 593800,  xrp: 0.1448, fletes_ano: 0,   km_ano: 40000 },
  bus_intermu:  { tipo: 'Bus intermunicipal',       prima: 1210900, xrp: 0.2953, fletes_ano: 0,   km_ano: 80000 },
};

// ── Split legal SOAT (Decreto 663/1993) ───────────────────────────────────────

const SPLIT       = { adres: 0.52, aseguradora: 0.45, vehix_fee: 0.03 };
const CUOTAS_TOTAL = 12;

// ── Flota activa — 3 vehículos ────────────────────────────────────────────────

const FLOTA_ACTIVA = [
  {
    key        : "moto_medio",
    placa      : "ABC12D",
    propietario: "Maria Lopez Vargas",
    wallet_key : "wMoto",
    num_poliza : `SOAT-${crypto.randomBytes(3).toString("hex").toUpperCase()}-M`,
    recibo_runt: `RUNT-${crypto.randomBytes(4).toString("hex").toUpperCase()}`,
  },
  {
    key        : "camion_c6",
    placa      : "SXZ842",
    propietario: "Carlos Rueda Mora",
    wallet_key : "wCamion",
    num_poliza : `SOAT-${crypto.randomBytes(3).toString("hex").toUpperCase()}-C`,
    recibo_runt: `RUNT-${crypto.randomBytes(4).toString("hex").toUpperCase()}`,
  },
  {
    key        : "bus_escolar",
    placa      : "WTR309",
    propietario: "Transporte Andino SAS",
    wallet_key : "wBus",
    num_poliza : `SOAT-${crypto.randomBytes(3).toString("hex").toUpperCase()}-B`,
    recibo_runt: `RUNT-${crypto.randomBytes(4).toString("hex").toUpperCase()}`,
  },
];

const FECHA_EMISION  = new Date().toISOString().split("T")[0];
const FECHA_VENCE    = new Date(Date.now() + 365 * 86_400_000).toISOString().split("T")[0];

// ── Console helpers ───────────────────────────────────────────────────────────

const W    = 72;
const hr   = (c = "─") => c.repeat(W);
const col  = (k, v) => console.log(`  ${String(k).padEnd(38)}: ${v}`);
const paso = (n, title) => {
  console.log("\n" + hr());
  console.log(`  PASO ${n} — ${title}`);
  console.log(hr());
};
const ok      = (r) => r === "tesSUCCESS" ? r + " ✓" : r + " ✗";
const fmt_cop = (n) => `$${n.toLocaleString("es-CO")} COP`;
const toHex   = (s) => Buffer.from(s, "utf8").toString("hex").toUpperCase();

function buildMemo(type, payload) {
  return [{
    Memo: {
      MemoType  : toHex(`freightfi/soat/${type}`),
      MemoFormat: toHex("application/json"),
      MemoData  : toHex(JSON.stringify(payload)),
    },
  }];
}

function computeMPTIssuanceID(issuerAddress, sequence) {
  const seqBuf = Buffer.alloc(4);
  seqBuf.writeUInt32BE(sequence >>> 0, 0);
  const accountBuf = Buffer.from(decodeAccountID(issuerAddress));
  return Buffer.concat([seqBuf, accountBuf]).toString("hex").toUpperCase();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function runSoatDeFi() {
  const client  = new Client(TESTNET_URL);
  const txLinks = [];

  const trackTx = (label, hash) => {
    txLinks.push({ label, url: `${EXPLORER}/${hash}` });
    console.log(`\n  🔗  ${EXPLORER}/${hash}`);
  };

  try {
    console.log("\n" + hr("═"));
    console.log("  VEHIX SHIELD SUITE — SOAT DeFi Multiflota  |  XRPL Testnet");
    console.log("  3 vehículos · Split 52/45/3 · MPT recibo RUNT · 12 cuotas");
    console.log(hr("═") + "\n");

    await client.connect();
    console.log("  Conectado a XRPL Testnet.\n");

    // ─────────────────────────────────────────────────────────────────────
    // PASO 1 — Wallets (7 actores)
    // ─────────────────────────────────────────────────────────────────────
    paso(1, "Crear wallets — 7 actores del ecosistema SOAT-DeFi");

    console.log("\n  [ASEGURADORA]  solicitando faucet...");
    const { wallet: wAseguradora } = await client.fundWallet();
    col("  wAseguradora  (Liberty Seguros — emisor SOAT)", wAseguradora.address);

    console.log("\n  [ADRES]        solicitando faucet...");
    const { wallet: wADRES       } = await client.fundWallet();
    col("  wADRES        (Min. Salud — 52% prima obligatorio)", wADRES.address);

    console.log("\n  [VEHIX POOL]   solicitando faucet...");
    const { wallet: wVehixPool   } = await client.fundWallet();
    col("  wVehixPool    (DeFi Pool financiador de SOAT)", wVehixPool.address);

    console.log("\n  [VEHIX FEE]    solicitando faucet...");
    const { wallet: wVehixFee    } = await client.fundWallet();
    col("  wVehixFee     (Vehix Fee Collector — 3%)", wVehixFee.address);

    console.log("\n  [MOTO]         solicitando faucet...");
    const { wallet: wMoto        } = await client.fundWallet();
    col("  wMoto         (Propietario ABC12D — moto 100-200cc)", wMoto.address);

    console.log("\n  [CAMION]       solicitando faucet...");
    const { wallet: wCamion      } = await client.fundWallet();
    col("  wCamion       (Propietario SXZ842 — camion C6)", wCamion.address);

    console.log("\n  [BUS]          solicitando faucet...");
    const { wallet: wBus         } = await client.fundWallet();
    col("  wBus          (Propietario WTR309 — bus escolar)", wBus.address);

    const ownerWallets = { wMoto, wCamion, wBus };

    // ─────────────────────────────────────────────────────────────────────
    // PASO 2 — VehixPool financia SOAT · split atómico 52 / 45 / 3
    // ─────────────────────────────────────────────────────────────────────
    paso(2, "VehixPool financia SOAT — split atomico 52% ADRES + 45% Aseg. + 3% Fee");

    console.log(`
  Marco legal del split (Decreto 663/1993 + Decreto 2497/2022):
    52% prima → ADRES        (salud de victimas de accidente de transito)
    45% prima → Aseguradora  (tarifa maxima fijada por Superfinanciera)
     3% prima → VehixFee     (intermediacion financiera — credito de consumo)

  El propietario NO tiene la prima completa — VehixPool adelanta el pago.
  P.L. Senador Carreno 2024 propone pago en cuotas — en tramite en Congreso.
  Vehix implementa tecnicamente lo que ese proyecto busca hacer ley.
`);

    const mptIDs    = {};
    let totalDrops  = 0;
    let totalCopAcc = 0;

    for (const vehiculo of FLOTA_ACTIVA) {
      const cfg = FLOTA_SOAT[vehiculo.key];

      // Calcular drops exactos evitando deriva de punto flotante
      const prima_drops = Math.round(cfg.xrp * 1_000_000);
      const adres_drops = Math.round(prima_drops * SPLIT.adres);
      const aseg_drops  = Math.round(prima_drops * SPLIT.aseguradora);
      const fee_drops   = prima_drops - adres_drops - aseg_drops;  // resto exacto

      const adres_cop = Math.round(cfg.prima * SPLIT.adres);
      const aseg_cop  = Math.round(cfg.prima * SPLIT.aseguradora);
      const fee_cop   = cfg.prima - adres_cop - aseg_cop;

      console.log(`\n  ── ${cfg.tipo.padEnd(26)} | Placa ${vehiculo.placa} ──────────────────`);
      col("  Propietario", vehiculo.propietario);
      col("  Poliza n°", vehiculo.num_poliza);
      col("  Prima total  (SOAT 2026)", `${fmt_cop(cfg.prima)}  /  ${cfg.xrp} XRP`);
      col("  → ADRES      52%", `${fmt_cop(adres_cop)}  /  ${dropsToXrp(adres_drops)} XRP`);
      col("  → Aseguradora 45%", `${fmt_cop(aseg_cop)}  /  ${dropsToXrp(aseg_drops)} XRP`);
      col("  → VehixFee    3%", `${fmt_cop(fee_cop)}  /  ${dropsToXrp(fee_drops)} XRP`);

      // TX A — VehixPool → ADRES (52%)
      const txAdres = await client.submitAndWait(
        wVehixPool.sign(await client.autofill({
          TransactionType: "Payment",
          Account        : wVehixPool.address,
          Destination    : wADRES.address,
          Amount         : String(adres_drops),
          Memos          : buildMemo("pago-adres", {
            tipo_evento  : "SOAT_PAGO_ADRES",
            placa        : vehiculo.placa,
            tipo_vehiculo: cfg.tipo,
            num_poliza   : vehiculo.num_poliza,
            prima_cop    : cfg.prima,
            adres_pct    : "52%",
            adres_cop    : adres_cop,
            base_legal   : "Decreto 663/1993 — 52% prima obligatorio a ADRES",
            financiador  : "VehixPool",
            cuotas_plan  : CUOTAS_TOTAL,
          }),
        })).tx_blob
      );
      col("  TX ADRES", ok(txAdres.result.meta.TransactionResult));
      trackTx(`SOAT_PAGO_ADRES — ${vehiculo.placa} (52% prima → ADRES)`, txAdres.result.hash);

      // TX B — VehixPool → Aseguradora (45%)
      const txAseg = await client.submitAndWait(
        wVehixPool.sign(await client.autofill({
          TransactionType: "Payment",
          Account        : wVehixPool.address,
          Destination    : wAseguradora.address,
          Amount         : String(aseg_drops),
          Memos          : buildMemo("pago-aseguradora", {
            tipo_evento  : "SOAT_PAGO_ASEGURADORA",
            placa        : vehiculo.placa,
            tipo_vehiculo: cfg.tipo,
            num_poliza   : vehiculo.num_poliza,
            prima_cop    : cfg.prima,
            aseg_pct     : "45%",
            aseg_cop     : aseg_cop,
            vigencia     : `${FECHA_EMISION} / ${FECHA_VENCE}`,
            financiador  : "VehixPool",
          }),
        })).tx_blob
      );
      col("  TX Aseguradora", ok(txAseg.result.meta.TransactionResult));
      trackTx(`SOAT_PAGO_ASEGURADORA — ${vehiculo.placa} (45% prima → Aseguradora)`, txAseg.result.hash);

      // TX C — VehixPool → VehixFee (3%)
      const txFee = await client.submitAndWait(
        wVehixPool.sign(await client.autofill({
          TransactionType: "Payment",
          Account        : wVehixPool.address,
          Destination    : wVehixFee.address,
          Amount         : String(fee_drops),
          Memos          : buildMemo("pago-fee", {
            tipo_evento  : "SOAT_PAGO_VEHIX_FEE",
            placa        : vehiculo.placa,
            tipo_vehiculo: cfg.tipo,
            num_poliza   : vehiculo.num_poliza,
            fee_pct      : "3%",
            fee_cop      : fee_cop,
            concepto     : "Intermediacion financiera credito consumo",
            nota_legal   : "Vehix intermediario financiero — NO aseguradora",
          }),
        })).tx_blob
      );
      col("  TX VehixFee", ok(txFee.result.meta.TransactionResult));
      trackTx(`SOAT_PAGO_VEHIX_FEE — ${vehiculo.placa} (3% prima → VehixFee)`, txFee.result.hash);

      mptIDs[vehiculo.placa] = null;  // se llena en paso 3
      totalDrops  += prima_drops;
      totalCopAcc += cfg.prima;
    }

    console.log(`\n  ── Resumen pool multiflota ─────────────────────────────────────────`);
    col("  Total prima financiada (COP)", fmt_cop(totalCopAcc));
    col("  Total prima financiada (XRP)", `${dropsToXrp(totalDrops)} XRP`);
    col("  Total ADRES (salud victimas)", `${dropsToXrp(Math.round(totalDrops * SPLIT.adres))} XRP`);
    col("  Total Aseguradora", `${dropsToXrp(Math.round(totalDrops * SPLIT.aseguradora))} XRP`);
    col("  Total VehixFee", `${dropsToXrp(Math.round(totalDrops * SPLIT.vehix_fee))} XRP`);
    col("  Pagos emitidos (3 vehiculos × 3)", String(FLOTA_ACTIVA.length * 3));

    // ─────────────────────────────────────────────────────────────────────
    // PASO 3 — Aseguradora emite MPT-SOAT · tokenización recibo RUNT
    // ─────────────────────────────────────────────────────────────────────
    paso(3, "Aseguradora emite MPT-SOAT — tokenizacion recibo RUNT por vehiculo");

    console.log(`
  El MPT es tokenizacion del recibo RUNT — NO reemplaza la poliza fisica
  de la aseguradora. Opera como comprobante on-chain inmutable verificable
  por Transito, Policia y RUNT mediante hash SHA-256 del numero de recibo.
`);

    for (const vehiculo of FLOTA_ACTIVA) {
      const cfg         = FLOTA_SOAT[vehiculo.key];
      const ownerWallet = ownerWallets[vehiculo.wallet_key];

      const runtHash = crypto.createHash("sha256")
        .update(`${vehiculo.recibo_runt}|${vehiculo.placa}|${FECHA_EMISION}`)
        .digest("hex");

      console.log(`\n  ── MPT-SOAT placa ${vehiculo.placa} (${cfg.tipo}) ────────────────────────`);
      col("  Recibo RUNT", vehiculo.recibo_runt);
      col("  runt_hash (parcial)", runtHash.slice(0, 20) + "…");
      col("  Vigencia poliza", `${FECHA_EMISION} → ${FECHA_VENCE}`);
      col("  Prima tokenizada (COP)", fmt_cop(cfg.prima));

      // TX D — MPTokenIssuanceCreate (Aseguradora)
      const mptCreateTx = await client.autofill({
        TransactionType : "MPTokenIssuanceCreate",
        Account         : wAseguradora.address,
        AssetScale      : 0,
        MaximumAmount   : "1",
        Flags           : 0x0020,  // tfMPTCanTransfer — Aseguradora transfiere al propietario
        MPTokenMetadata : encodeMPTokenMetadata({
          placa          : vehiculo.placa,
          tipo_vehiculo  : cfg.tipo,
          num_poliza     : vehiculo.num_poliza,
          recibo_runt    : vehiculo.recibo_runt,
          runt_hash      : runtHash,
          prima_cop      : cfg.prima,
          prima_xrp      : cfg.xrp,
          fecha_emision  : FECHA_EMISION,
          fecha_vence    : FECHA_VENCE,
          propietario    : vehiculo.propietario,
          estado         : "VIGENTE",
          nota_legal     : "MPT tokenizacion recibo RUNT - no reemplaza poliza aseguradora",
        }),
        Memos: buildMemo("mpt-soat-create", {
          tipo_evento : "EMISION_MPT_SOAT_RUNT",
          placa       : vehiculo.placa,
          num_poliza  : vehiculo.num_poliza,
          runt_hash   : runtHash.slice(0, 20),
          financiador : "VehixPool",
        }),
      });
      const mptSeq    = mptCreateTx.Sequence;
      const mptResult = await client.submitAndWait(wAseguradora.sign(mptCreateTx).tx_blob);
      const mptID     = computeMPTIssuanceID(wAseguradora.address, mptSeq);

      col("  TX MPTokenIssuanceCreate", mptResult.result.hash.slice(0, 16) + "…");
      col("  Estado", ok(mptResult.result.meta.TransactionResult));
      col("  MPTokenIssuanceID", mptID);
      trackTx(`MPTokenIssuanceCreate SOAT — ${vehiculo.placa} (recibo RUNT tokenizado)`, mptResult.result.hash);

      // TX E — MPTokenAuthorize propietario (opt-in)
      const authResult = await client.submitAndWait(
        ownerWallet.sign(await client.autofill({
          TransactionType  : "MPTokenAuthorize",
          Account          : ownerWallet.address,
          MPTokenIssuanceID: mptID,
        })).tx_blob
      );
      col("  MPTokenAuthorize propietario", ok(authResult.result.meta.TransactionResult));
      trackTx(`MPTokenAuthorize — ${vehiculo.placa} propietario opt-in`, authResult.result.hash);

      // TX F — Aseguradora transfiere MPT al propietario (entrega poliza digital)
      const mptTransfer = await client.submitAndWait(
        wAseguradora.sign(await client.autofill({
          TransactionType: "Payment",
          Account        : wAseguradora.address,
          Destination    : ownerWallet.address,
          Amount         : { mpt_issuance_id: mptID, value: "1" },
          Memos          : buildMemo("mpt-soat-entrega", {
            tipo_evento : "ENTREGA_MPT_SOAT_PROPIETARIO",
            placa       : vehiculo.placa,
            num_poliza  : vehiculo.num_poliza,
            propietario : vehiculo.propietario,
            runt_hash   : runtHash.slice(0, 20),
            vigencia    : `${FECHA_EMISION} / ${FECHA_VENCE}`,
            estado      : "VIGENTE",
          }),
        })).tx_blob
      );
      col("  MPT entregado a propietario", ok(mptTransfer.result.meta.TransactionResult));
      col("  Titular on-chain", ownerWallet.address.slice(0, 14) + "…");
      trackTx(`MPT SOAT → propietario ${vehiculo.placa} (poliza digital vigente)`, mptTransfer.result.hash);

      mptIDs[vehiculo.placa] = mptID;
    }

    // ─────────────────────────────────────────────────────────────────────
    // PASO 4 — Propietarios repagan cuota 1/12 a VehixPool
    // ─────────────────────────────────────────────────────────────────────
    paso(4, `Repago cuota 1/${CUOTAS_TOTAL} — propietarios pagan a VehixPool`);

    console.log(`
  VehixPool otorgo credito de consumo (prima completa adelantada).
  Propietarios repagan en ${CUOTAS_TOTAL} cuotas mensuales iguales.
  Simulacion: cuota 1 de ${CUOTAS_TOTAL} por cada vehiculo de la flota.
  P.L. Senador Carreno 2024 busca hacer esto ley — Vehix ya lo opera on-chain.
`);

    for (const vehiculo of FLOTA_ACTIVA) {
      const cfg         = FLOTA_SOAT[vehiculo.key];
      const ownerWallet = ownerWallets[vehiculo.wallet_key];
      const prima_drops = Math.round(cfg.xrp * 1_000_000);
      const cuota_drops = Math.round(prima_drops / CUOTAS_TOTAL);
      const cuota_cop   = Math.round(cfg.prima / CUOTAS_TOTAL);

      console.log(`\n  ── Cuota ${vehiculo.placa} (${cfg.tipo}) ────────────────────────────────`);
      col("  Prima financiada total", `${fmt_cop(cfg.prima)}  /  ${cfg.xrp} XRP`);
      col(`  Cuota 1/${CUOTAS_TOTAL} (mensual)`, `${fmt_cop(cuota_cop)}  /  ${dropsToXrp(cuota_drops)} XRP`);

      const txCuota = await client.submitAndWait(
        ownerWallet.sign(await client.autofill({
          TransactionType: "Payment",
          Account        : ownerWallet.address,
          Destination    : wVehixPool.address,
          Amount         : String(cuota_drops),
          Memos          : buildMemo("repago-cuota", {
            tipo_evento  : "SOAT_REPAGO_CUOTA",
            placa        : vehiculo.placa,
            tipo_vehiculo: cfg.tipo,
            num_poliza   : vehiculo.num_poliza,
            mpt_id       : (mptIDs[vehiculo.placa] ?? "").slice(0, 16),
            cuota_num    : 1,
            cuotas_total : CUOTAS_TOTAL,
            cuota_cop    : cuota_cop,
            saldo_cop    : cfg.prima - cuota_cop,
            nota         : "PL Senador Carreno 2024 — SOAT en cuotas",
          }),
        })).tx_blob
      );
      col(`  TX cuota 1/${CUOTAS_TOTAL}`, ok(txCuota.result.meta.TransactionResult));
      col("  Saldo pendiente", `${fmt_cop(cfg.prima - cuota_cop)}  (${CUOTAS_TOTAL - 1} cuotas restantes)`);
      trackTx(`SOAT_REPAGO_CUOTA 1/${CUOTAS_TOTAL} — ${vehiculo.placa} → VehixPool`, txCuota.result.hash);
    }

    // ─────────────────────────────────────────────────────────────────────
    // PASO R — Resumen
    // ─────────────────────────────────────────────────────────────────────
    paso("R", "Resumen — Vehix Shield Suite SOAT DeFi Multiflota");

    const m  = FLOTA_SOAT.moto_medio;
    const c  = FLOTA_SOAT.camion_c6;
    const b  = FLOTA_SOAT.bus_escolar;

    const cop_m  = String(m.prima.toLocaleString("es-CO")).padEnd(9);
    const cop_c  = String(c.prima.toLocaleString("es-CO")).padEnd(9);
    const cop_b  = String(b.prima.toLocaleString("es-CO")).padEnd(9);
    const cop_tot = String(totalCopAcc.toLocaleString("es-CO")).padEnd(9);
    const xrp_tot = String(dropsToXrp(totalDrops)).padEnd(8);
    const tx_tot  = String(txLinks.length).padEnd(5);

    console.log(`
  ┌────────────────────────────────────────────────────────────────────────┐
  │  VEHIX SHIELD SUITE — SOAT DeFi Multiflota  Resumen                   │
  ├──────────────────────────────────────────┬─────────────────────────────┤
  │  Vehiculos financiados                   │  3                          │
  │    ABC12D  Motocicleta 100-200cc         │  $${cop_m} / ${String(m.xrp).padEnd(6)} XRP  │
  │    SXZ842  Camion carga C6               │  $${cop_c} / ${String(c.xrp).padEnd(6)} XRP  │
  │    WTR309  Bus escolar                   │  $${cop_b} / ${String(b.xrp).padEnd(6)} XRP  │
  ├──────────────────────────────────────────┼─────────────────────────────┤
  │  Total prima financiada (COP)            │  $${cop_tot}                │
  │  Total prima financiada (XRP)            │  ${xrp_tot} XRP             │
  ├──────────────────────────────────────────┼─────────────────────────────┤
  │  Split legal ejecutado (on-chain)        │                             │
  │    52% → ADRES  (salud victimas)         │  Ley 33/1986                │
  │    45% → Aseguradora                     │  Superfinanciera — tarifa   │
  │     3% → VehixFee                        │  Intermediacion financiera  │
  ├──────────────────────────────────────────┼─────────────────────────────┤
  │  MPT-SOAT emitidos (recibo RUNT)         │  3  (uno por vehiculo)      │
  │  Cuotas simuladas                        │  3  (cuota 1 de 12)         │
  │  Transacciones on-chain                  │  ${tx_tot}                  │
  ├──────────────────────────────────────────┼─────────────────────────────┤
  │  Marco regulatorio                       │  Ley 33/1986                │
  │                                          │  Decreto 663/1993           │
  │                                          │  Decreto 2497/2022          │
  │                                          │  Decreto 2312/2023          │
  │  P.L. Carreno 2024 (en tramite Congreso) │  Vehix implementa cuotas   │
  │  Registro PSAV Superfinanciera           │  Mes 4 del Grant            │
  └──────────────────────────────────────────┴─────────────────────────────┘`);

    // ─────────────────────────────────────────────────────────────────────
    // PASO L — Links directos al explorer
    // ─────────────────────────────────────────────────────────────────────
    paso("L", "Links directos — XRPL Testnet Explorer");
    console.log();
    txLinks.forEach((t, i) => {
      console.log(`  [${String(i + 1).padStart(2)}] ${t.label}`);
      console.log(`       ${t.url}`);
    });

    console.log();
    console.log(hr("═"));
    console.log("  VEHIX SHIELD SUITE SOAT DeFi — Completado exitosamente");
    console.log(hr("═") + "\n");

  } finally {
    await client.disconnect();
    console.log("  Desconectado del nodo XRPL.\n");
  }
}

runSoatDeFi().catch((err) => {
  console.error("Error:", err.message ?? err);
  process.exit(1);
});
