import { Client, xrpToDrops, dropsToXrp, unixTimeToRippleTime } from "xrpl";
import crypto from "crypto";

const TESTNET_URL = "wss://s.altnet.rippletest.net:51233";
const EXPLORER    = "https://testnet.xrpl.org/transactions";

// ── Tasa simulada y ruta ──────────────────────────────────────────────────────

const COP_PER_XRP = 200_000; // 1 XRP = $200.000 COP (simulado)

const ROUTE = {
  id         : "BOG-VVC-2026-001",
  origin     : { city: "Bogotá, DC",          lat:  4.7110, lon: -74.0721 },
  destination: { city: "Villavicencio, Meta", lat:  4.1420, lon: -73.6266 },
  distance_km: 117,
  freight_cop: 3_500_000,
  fee_pct    : 0.015,   // 1.5 % FuelChain
  buffer_pct : 0.20,    // buffer peajes
};

// ── Peajes reales ANI  ────────────────────────────────────────────────────────
// actual_cop = lo que el oráculo GPS detecta que cobró el peaje en el momento
// tariff_cop = tarifa oficial INVIAS 2025 categoría C6

const TOLLS = [
  {
    id        : "ANI_042_PIPIRAL",
    name      : "Peaje Pipiral",
    lat       :  4.2847, lon: -73.8519,
    km        :  82,
    category  : "C6",
    tariff_cop: 147_000,
    actual_cop: 161_500,   // ⚠️  cobró $14.500 extra — detectado por GPS oracle
  },
  {
    id        : "ANI_015_BOQUERÓN",
    name      : "Peaje Boquerón",
    lat       :  4.5216, lon: -73.9843,
    km        :  38,
    category  : "C6",
    tariff_cop:  89_000,
    actual_cop:  89_000,
  },
  {
    id        : "ANI_031_CHIRAJARA",
    name      : "Peaje Chirajara",
    lat       :  4.3512, lon: -73.8123,
    km        :  65,
    category  : "C6",
    tariff_cop: 112_000,
    actual_cop: 112_000,
  },
];

const GEOFENCE_KM = 0.5; // radio geocerca por peaje

// ── Helpers de moneda ─────────────────────────────────────────────────────────

const copToXrp   = (cop) => (cop / COP_PER_XRP).toFixed(6);
const fmt_cop    = (n)   => `$${n.toLocaleString("es-CO")} COP`;
const fmt_xrp    = (x)   => `${parseFloat(x).toFixed(4)} XRP`;

// ── Console helpers ───────────────────────────────────────────────────────────

const W    = 64;
const hr   = (c = "─") => c.repeat(W);
const col  = (k, v) => console.log(`  ${String(k).padEnd(32)}: ${v}`);
const step = (n, title) => {
  console.log("\n" + hr());
  console.log(`  PASO ${n} — ${title}`);
  console.log(hr());
};
const ok = (r) => r === "tesSUCCESS" ? r + " ✓" : r + " ✗";

// ── Memo helpers ──────────────────────────────────────────────────────────────

const toHex   = (s) => Buffer.from(s, "utf8").toString("hex").toUpperCase();
const fromHex = (h) => Buffer.from(h, "hex").toString("utf8");

function buildMemo(type, payload) {
  return [{
    Memo: {
      MemoType  : toHex(`freightfi/${type}`),
      MemoFormat: toHex("application/json"),
      MemoData  : toHex(JSON.stringify(payload)),
    },
  }];
}

// ── Haversine ─────────────────────────────────────────────────────────────────

function haversineKm(a, b) {
  const R    = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const h    = Math.sin(dLat / 2) ** 2 +
               Math.cos(a.lat * Math.PI / 180) *
               Math.cos(b.lat * Math.PI / 180) *
               Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(h));
}

// ── Simulación GPS — cruce de peajes ─────────────────────────────────────────

function simulateTollCrossings() {
  return TOLLS.map((toll) => {
    // GPS del camión en el momento del cruce (±~50 m de ruido)
    const gps = {
      lat: toll.lat + (Math.random() - 0.5) * 0.001,
      lon: toll.lon + (Math.random() - 0.5) * 0.001,
    };
    const dist_km    = haversineKm(gps, { lat: toll.lat, lon: toll.lon });
    const geofence   = dist_km < GEOFENCE_KM;
    const delta_cop  = toll.actual_cop - toll.tariff_cop;

    return {
      toll_id     : toll.id,
      toll_name   : toll.name,
      km_route    : toll.km,
      timestamp   : new Date().toISOString(),
      gps,
      dist_km     : dist_km.toFixed(4),
      geofence_hit: geofence,
      tariff_cop  : toll.tariff_cop,
      actual_cop  : toll.actual_cop,
      delta_cop,
      overcharge  : delta_cop > 0,
      hash        : crypto
        .createHash("sha256")
        .update(JSON.stringify({ id: toll.id, actual_cop: toll.actual_cop, ts: new Date().toISOString() }))
        .digest("hex"),
    };
  });
}

// ── Cálculo de liquidación ────────────────────────────────────────────────────

function calcSettlement(crossings) {
  const total_tariff_cop   = TOLLS.reduce((s, t) => s + t.tariff_cop, 0);
  const buffer_cop         = Math.round(total_tariff_cop * ROUTE.buffer_pct);
  const total_actual_cop   = crossings.reduce((s, c) => s + c.actual_cop, 0);
  const total_delta_cop    = total_actual_cop - total_tariff_cop;
  const buffer_used_cop    = Math.max(0, total_delta_cop);
  const buffer_unused_cop  = Math.max(0, buffer_cop - buffer_used_cop);

  const fee_cop            = Math.round(ROUTE.freight_cop * ROUTE.fee_pct);
  const freight_net_cop    = ROUTE.freight_cop - fee_cop;
  const driver_cop         = freight_net_cop + buffer_used_cop;

  const escrow_total_cop   = ROUTE.freight_cop + buffer_cop;

  // ARBITRATION si el cobro extra supera el buffer del 20 %
  const arbitration        = total_delta_cop > buffer_cop;

  return {
    total_tariff_cop, buffer_cop,
    total_actual_cop, total_delta_cop,
    buffer_used_cop, buffer_unused_cop,
    fee_cop, freight_net_cop,
    driver_cop, escrow_total_cop, arbitration,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function runTollOracle() {
  const client = new Client(TESTNET_URL);

  try {
    console.log("\n" + hr("═"));
    console.log("  FREIGHTFI — Toll Oracle · Buffer 20 %  |  Bogotá → Villavicencio");
    console.log(hr("═") + "\n");

    await client.connect();
    console.log("  Conectado a XRPL Testnet.\n");

    // ── PASO 1: Wallets ───────────────────────────────────────────────────
    step(1, "Crear wallets  (cargador · conductor · oracle · FuelChain)");

    console.log("\n  [CARGADOR]  solicitando faucet...");
    const { wallet: wCargador  } = await client.fundWallet();
    col("  wCargador  (genera la carga)", wCargador.address);

    console.log("\n  [CONDUCTOR] solicitando faucet...");
    const { wallet: wDriver    } = await client.fundWallet();
    col("  wDriver    (camionero)", wDriver.address);

    console.log("\n  [ORACLE]    solicitando faucet...");
    const { wallet: wOracle    } = await client.fundWallet();
    col("  wOracle    (GPS oracle + destino escrow)", wOracle.address);

    console.log("\n  [FUELCHAIN] solicitando faucet...");
    const { wallet: wFuelChain } = await client.fundWallet();
    col("  wFuelChain (fee 1.5 %)", wFuelChain.address);

    // ── PASO 2: Presupuesto de peajes y buffer 20 % ───────────────────────
    step(2, "Presupuesto de peajes  —  buffer 20 %");

    const total_tariff_cop = TOLLS.reduce((s, t) => s + t.tariff_cop, 0);
    const buffer_cop       = Math.round(total_tariff_cop * ROUTE.buffer_pct);
    const escrow_total_cop = ROUTE.freight_cop + buffer_cop;
    const escrow_total_xrp = copToXrp(escrow_total_cop);

    console.log();
    for (const t of TOLLS) {
      col(`  ${t.id}  (C6)`, fmt_cop(t.tariff_cop));
    }
    col("  ─────────────────────────────", "");
    col("  Total peajes proyectado", fmt_cop(total_tariff_cop));
    col("  Buffer 20 %", fmt_cop(buffer_cop));
    console.log();
    col("  Flete base", fmt_cop(ROUTE.freight_cop));
    col("  + Buffer peajes", fmt_cop(buffer_cop));
    col("  = Total escrow", fmt_cop(escrow_total_cop));
    col("  = Total escrow XRP", `${fmt_xrp(escrow_total_xrp)}  (1 XRP = ${COP_PER_XRP.toLocaleString("es-CO")} COP)`);

    // ── PASO 3: EscrowCreate ──────────────────────────────────────────────
    step(3, `EscrowCreate  —  flete + buffer  (${fmt_xrp(escrow_total_xrp)})`);

    const cancelAtMS    = Date.now() + 48 * 3_600_000;
    const finishAfterMs = Date.now() + 30_000; // 30 s → evita tecNO_PERMISSION

    const escrowCreateTx = {
      TransactionType: "EscrowCreate",
      Account        : wCargador.address,
      Amount         : xrpToDrops(escrow_total_xrp),
      Destination    : wOracle.address,
      FinishAfter    : unixTimeToRippleTime(finishAfterMs),
      CancelAfter    : unixTimeToRippleTime(cancelAtMS),
      Memos          : buildMemo("toll-escrow-create", {
        protocol        : "FreightFi/2.0",
        route_id        : ROUTE.id,
        freight_cop     : ROUTE.freight_cop,
        buffer_cop,
        buffer_pct      : 20,
        total_tariff_cop,
        escrow_total_cop,
        tolls           : TOLLS.map(t => ({ id: t.id, tariff_cop: t.tariff_cop })),
        cop_per_xrp     : COP_PER_XRP,
      }),
    };

    const preparedCreate = await client.autofill(escrowCreateTx);
    const signedCreate   = wCargador.sign(preparedCreate);
    const createResult   = await client.submitAndWait(signedCreate.tx_blob);
    const escrowSeq      = preparedCreate.Sequence;

    console.log();
    col("  Hash EscrowCreate", createResult.result.hash);
    col("  Estado", ok(createResult.result.meta.TransactionResult));
    col("  Monto bloqueado", `${fmt_xrp(escrow_total_xrp)}`);
    col("  Destino (oracle)", wOracle.address.slice(0, 14) + "…");
    col("  OfferSequence", escrowSeq);
    col("  CancelAfter", new Date(cancelAtMS).toISOString());
    console.log(`\n  🔗  ${EXPLORER}/${createResult.result.hash}`);

    // Esperar que FinishAfter pase en el ledger
    const waitMs = Math.max(0, finishAfterMs - Date.now()) + 4_000;
    col("\n  Esperando FinishAfter", `${Math.ceil(waitMs / 1000)} s…`);
    await new Promise((r) => setTimeout(r, waitMs));

    // ── PASO 4: GPS oracle — cruces de peaje ──────────────────────────────
    step(4, "GPS Oracle — 3 estaciones de peaje cruzadas");

    const crossings = simulateTollCrossings();

    console.log();
    for (const c of crossings) {
      console.log(`  ▸ ${c.toll_id}  (km ${c.km_route})`);
      col("    GPS lat / lon", `${c.gps.lat.toFixed(5)}, ${c.gps.lon.toFixed(5)}`);
      col("    Dist. al peaje", `${c.dist_km} km  ${c.geofence_hit ? "✓ GEOCERCA HIT" : "✗ fuera de geocerca"}`);
      col("    Tarifa ANI (C6)", fmt_cop(c.tariff_cop));
      col("    Cobro detectado", fmt_cop(c.actual_cop));
      if (c.overcharge) {
        col("    Delta cobro extra", `+${fmt_cop(c.delta_cop)}  ⚠️`);
      }
      col("    Hash evento GPS", c.hash.slice(0, 20) + "…");
      console.log();
    }

    // ── PASO 5: Liquidación ───────────────────────────────────────────────
    step(5, "Liquidación  —  distribución del escrow");

    const S = calcSettlement(crossings);

    console.log();
    col("  Flete base", fmt_cop(ROUTE.freight_cop));
    col("  Fee FuelChain (1.5 %)", `- ${fmt_cop(S.fee_cop)}`);
    col("  Flete neto conductor", fmt_cop(S.freight_net_cop));
    console.log();
    col("  Total peajes proyectado", fmt_cop(S.total_tariff_cop));
    col("  Total peajes real", fmt_cop(S.total_actual_cop));
    col("  Delta total (cobro extra)", `+${fmt_cop(S.total_delta_cop)}`);
    col("  Buffer disponible (20 %)", fmt_cop(S.buffer_cop));

    if (S.arbitration) {
      // ── ARBITRATION_FLAG ──────────────────────────────────────────────
      console.log("\n" + hr("!"));
      console.log(`  ⚠️  ARBITRATION_FLAG`);
      console.log(`  Delta ${fmt_cop(S.total_delta_cop)} SUPERA el buffer ${fmt_cop(S.buffer_cop)}.`);
      console.log(`  El escrow NO se libera automáticamente.`);
      console.log(`  Requiere mediación manual o resolución en cadena.`);
      console.log(hr("!"));

      console.log(`\n  🔗  EscrowCreate (fondos retenidos):`);
      console.log(`      ${EXPLORER}/${createResult.result.hash}`);

      console.log("\n" + hr("═"));
      console.log("  ARBITRATION_FLAG — flujo detenido, fondos seguros en escrow");
      console.log(hr("═") + "\n");
      return;
    }

    // Delta dentro del buffer → liquidación automática
    col("  Buffer usado (cubre delta)", fmt_cop(S.buffer_used_cop));
    col("  Buffer no usado → cargador", fmt_cop(S.buffer_unused_cop));
    console.log();
    col("  ── Distribución ──────────────────", "");
    col("  Conductor recibe", `${fmt_cop(S.driver_cop)}  (flete neto + delta)`);
    col("  Cargador recibe (refund)", fmt_cop(S.buffer_unused_cop));
    col("  FuelChain recibe (fee)", fmt_cop(S.fee_cop));
    col("  Suma", fmt_cop(S.driver_cop + S.buffer_unused_cop + S.fee_cop));
    console.log(`\n  ✓ Delta dentro del buffer 20 % → LIQUIDACIÓN AUTOMÁTICA`);

    // ── PASO 6: EscrowFinish ──────────────────────────────────────────────
    step(6, "EscrowFinish  —  oracle libera el escrow");

    const finishMemo = buildMemo("toll-escrow-finish", {
      protocol    : "FreightFi/2.0",
      route_id    : ROUTE.id,
      crossings   : crossings.map(c => ({
        id        : c.toll_id,
        actual_cop: c.actual_cop,
        delta_cop : c.delta_cop,
        hash      : c.hash.slice(0, 16),  // short hash en memo
      })),
      settlement  : {
        driver_cop       : S.driver_cop,
        buffer_unused_cop: S.buffer_unused_cop,
        fee_cop          : S.fee_cop,
      },
      timestamp_utc    : new Date().toISOString(),
      arbitration_flag : false,
    });

    const preparedFinish = await client.autofill({
      TransactionType: "EscrowFinish",
      Account        : wOracle.address,
      Owner          : wCargador.address,
      OfferSequence  : escrowSeq,
      Memos          : finishMemo,
    });
    const signedFinish  = wOracle.sign(preparedFinish);
    const finishResult  = await client.submitAndWait(signedFinish.tx_blob);

    console.log();
    col("  Hash EscrowFinish", finishResult.result.hash);
    col("  Estado", ok(finishResult.result.meta.TransactionResult));
    col("  Ledger #", finishResult.result.ledger_index);
    col("  Fondos en oracle", `${fmt_xrp(escrow_total_xrp)} → distribución`);
    console.log(`\n  🔗  ${EXPLORER}/${finishResult.result.hash}`);

    // ── PASO 7: Distribución atómica (3 pagos) ────────────────────────────
    step(7, "Distribución  —  3 pagos desde oracle");

    const driver_xrp = copToXrp(S.driver_cop);
    const refund_xrp = copToXrp(S.buffer_unused_cop);
    const fee_xrp    = copToXrp(S.fee_cop);

    async function pay(from, dest, xrp, memoType, memoPayload) {
      const tx = await client.autofill({
        TransactionType: "Payment",
        Account        : from.address,
        Destination    : dest.address,
        Amount         : xrpToDrops(xrp),
        Memos          : buildMemo(memoType, memoPayload),
      });
      return client.submitAndWait(from.sign(tx).tx_blob);
    }

    const pay1 = await pay(wOracle, wDriver, driver_xrp, "toll-pay-driver", {
      route_id       : ROUTE.id,
      freight_net_cop: S.freight_net_cop,
      delta_cop      : S.total_delta_cop,
      total_cop      : S.driver_cop,
    });

    const pay2 = await pay(wOracle, wCargador, refund_xrp, "toll-refund-buffer", {
      route_id         : ROUTE.id,
      buffer_unused_cop: S.buffer_unused_cop,
    });

    const pay3 = await pay(wOracle, wFuelChain, fee_xrp, "toll-fee-fuelchain", {
      route_id: ROUTE.id,
      fee_cop : S.fee_cop,
      fee_pct : ROUTE.fee_pct * 100,
    });

    console.log();
    col("  [1] Conductor", `${fmt_cop(S.driver_cop)} = ${fmt_xrp(driver_xrp)}`);
    col("    Hash", pay1.result.hash);
    col("    Estado", ok(pay1.result.meta.TransactionResult));
    console.log(`    🔗  ${EXPLORER}/${pay1.result.hash}\n`);

    col("  [2] Cargador (refund buffer)", `${fmt_cop(S.buffer_unused_cop)} = ${fmt_xrp(refund_xrp)}`);
    col("    Hash", pay2.result.hash);
    col("    Estado", ok(pay2.result.meta.TransactionResult));
    console.log(`    🔗  ${EXPLORER}/${pay2.result.hash}\n`);

    col("  [3] FuelChain (fee 1.5 %)", `${fmt_cop(S.fee_cop)} = ${fmt_xrp(fee_xrp)}`);
    col("    Hash", pay3.result.hash);
    col("    Estado", ok(pay3.result.meta.TransactionResult));
    console.log(`    🔗  ${EXPLORER}/${pay3.result.hash}`);

    // ── PASO 8: Resumen de transacciones ──────────────────────────────────
    step(8, "Resumen  —  Links XRPL Testnet Explorer");

    console.log(`
  [1] EscrowCreate  (${fmt_xrp(escrow_total_xrp)} = flete + buffer 20 %):
      ${EXPLORER}/${createResult.result.hash}

  [2] EscrowFinish  (oracle libera):
      ${EXPLORER}/${finishResult.result.hash}

  [3] Pago conductor  (${fmt_xrp(driver_xrp)} = flete neto + delta):
      ${EXPLORER}/${pay1.result.hash}

  [4] Refund buffer → cargador  (${fmt_xrp(refund_xrp)}):
      ${EXPLORER}/${pay2.result.hash}

  [5] Fee FuelChain 1.5 %  (${fmt_xrp(fee_xrp)}):
      ${EXPLORER}/${pay3.result.hash}
`);

    // Verificar memo EscrowFinish on-chain
    const { result: txFin } = await client.request({
      command: "tx", transaction: finishResult.result.hash,
    });
    const raw = txFin.Memos?.[0]?.Memo;
    if (raw) {
      const data = JSON.parse(fromHex(raw.MemoData));
      console.log("  Memo EscrowFinish on-chain:");
      console.log(
        JSON.stringify(data, null, 2)
          .split("\n").map(l => "    " + l).join("\n")
      );
    }

    console.log("\n" + hr("═"));
    console.log("  FREIGHTFI TOLL ORACLE — Completado exitosamente");
    console.log(hr("═") + "\n");

  } finally {
    await client.disconnect();
    console.log("  Desconectado del nodo XRPL.\n");
  }
}

runTollOracle().catch((err) => {
  console.error("Error:", err.message ?? err);
  process.exit(1);
});
