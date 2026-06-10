import {
  Client,
  xrpToDrops,
  unixTimeToRippleTime,
} from "xrpl";
import crypto from "crypto";

const TESTNET_URL = "wss://s.altnet.rippletest.net:51233";
const EXPLORER    = "https://testnet.xrpl.org/transactions";

// ── Parámetros del viaje ──────────────────────────────────────────────────────

const COP_PER_XRP = 200_000; // 1 XRP = $200.000 COP (tasa simulada)
const TRIP_ID     = `VX-TRIP-${Date.now()}`;

const VIAJE = {
  id        : TRIP_ID,
  origen    : "Medellín, Antioquia",
  destino   : "Bogotá, Cundinamarca",
  peso_ton  : 20,
  tipo_carga: "Carga general seca",
  sice_tac  : "GT-20-BOG-2026",
  flete_cop : 3_500_000,
  flete_xrp : 3_500_000 / COP_PER_XRP, // 17.5 XRP
  timeout_h : 48,
};

// ── Distribución del flete ────────────────────────────────────────────────────

const PILA_PCT    = 0.060;  // 6%   — salud + pensión + ARL
const VEHIX_PCT   = 0.015;  // 1.5% — fee plataforma
const CARRIER_PCT = 1 - PILA_PCT - VEHIX_PCT; // 92.5%

const carrier_xrp = +(VIAJE.flete_xrp * CARRIER_PCT).toFixed(6); // 16.1875
const pila_xrp    = +(VIAJE.flete_xrp * PILA_PCT).toFixed(6);    // 1.05
const vehix_xrp   = +(VIAJE.flete_xrp * VEHIX_PCT).toFixed(6);   // 0.2625

// ── RNDC (manifiesto de carga) ────────────────────────────────────────────────

const RNDC = {
  numero_manifiesto: `RNDC-${TRIP_ID}`,
  origen           : VIAJE.origen,
  destino          : VIAJE.destino,
  peso_kg          : VIAJE.peso_ton * 1_000,
  tipo_carga       : VIAJE.tipo_carga,
  sice_tac         : VIAJE.sice_tac,
  fecha_despacho   : new Date().toISOString().split("T")[0],
};
const rndc_hash = crypto.createHash("sha256").update(JSON.stringify(RNDC)).digest("hex");
const pila_pin  = crypto.randomBytes(4).toString("hex").toUpperCase();

// ── Score historial del carrier ───────────────────────────────────────────────

const CARRIER_SCORE = {
  tipo_evento          : "SCORE_HISTORIAL_CARRIER",
  viajes_completados   : 23,
  viajes_exitosos      : 22,
  calificacion_promedio: 4.8,
  score_vehix          : 94,
  tasa_cumplimiento    : "95.6%",
  sice_tac_habilitado  : true,
  ultimo_viaje         : "MED-CAL-2026-0521",
};

// ── Eventos GPS: Medellín → Bogotá ────────────────────────────────────────────

const GPS_EVENTS = [
  {
    seq   : 1,
    evento: "SALIDA_ORIGEN",
    nombre: "Terminal de Transportes Medellín",
    lat   :  6.2518,
    lon   : -75.5636,
    hora  : "06:00",
  },
  {
    seq   : 2,
    evento: "EN_RUTA_AUTOPISTA",
    nombre: "Autopista Medellín–Bogotá Km 156",
    lat   :  5.6833,
    lon   : -74.9833,
    hora  : "10:30",
  },
  {
    seq   : 3,
    evento: "LLEGADA_DESTINO",
    nombre: "Terminal Bogotá — Geovalla 500 m activa",
    lat   :  4.6534,
    lon   : -74.1033,
    hora  : "14:45",
  },
];

// ── Console helpers ───────────────────────────────────────────────────────────

const W    = 70;
const hr   = (c = "─") => c.repeat(W);
const col  = (k, v) => console.log(`  ${String(k).padEnd(34)}: ${v}`);
const paso = (n, title) => {
  console.log("\n" + hr());
  console.log(`  PASO ${n} — ${title}`);
  console.log(hr());
};
const ok     = (r) => r === "tesSUCCESS" ? r + " ✓" : r + " ✗";
const toHex  = (s) => Buffer.from(s, "utf8").toString("hex").toUpperCase();
const copFmt = (xrp) =>
  `$${Math.round(xrp * COP_PER_XRP).toLocaleString("es-CO")} COP`;

function buildMemo(type, payload) {
  return [{
    Memo: {
      MemoType  : toHex(`freightfi/cargo/${type}`),
      MemoFormat: toHex("application/json"),
      MemoData  : toHex(JSON.stringify(payload)),
    },
  }];
}

// ── Payment helpers ───────────────────────────────────────────────────────────

async function payXRP(client, from, to, xrp, type, data) {
  return client.submitAndWait(
    from.sign(await client.autofill({
      TransactionType: "Payment",
      Account        : from.address,
      Destination    : to.address,
      Amount         : xrpToDrops(String(xrp)),
      Memos          : buildMemo(type, data),
    })).tx_blob
  );
}

async function payDrop(client, from, to, type, data) {
  return client.submitAndWait(
    from.sign(await client.autofill({
      TransactionType: "Payment",
      Account        : from.address,
      Destination    : to.address,
      Amount         : "1",  // 1 drop = marcador on-chain
      Memos          : buildMemo(type, data),
    })).tx_blob
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function runCargoBank() {
  const client  = new Client(TESTNET_URL);
  const txLinks = [];

  const track = (label, hash) => {
    txLinks.push({ label, url: `${EXPLORER}/${hash}` });
    console.log(`\n  🔗  ${EXPLORER}/${hash}`);
  };

  try {
    console.log("\n" + hr("═"));
    console.log("  FREIGHTFI — Cargo Bank  |  Vehix Load on-chain XRPL Testnet");
    console.log("  Ruta: Medellín → Bogotá  ·  20 ton  ·  RNDC + PILA on-chain");
    console.log(hr("═") + "\n");

    await client.connect();
    console.log("  Conectado a XRPL Testnet.\n");

    // ── PASO 1: Wallets ───────────────────────────────────────────────────
    paso(1, "Crear wallets — Generador · Carrier · Vehix · PILA");

    console.log("\n  [GENERADOR] solicitando faucet...");
    const { wallet: wGenerador } = await client.fundWallet();
    col("  wGenerador  (Shipper — dueño de la carga)", wGenerador.address);

    console.log("\n  [CARRIER]   solicitando faucet...");
    const { wallet: wCarrier   } = await client.fundWallet();
    col("  wCarrier    (Propietario camión / conductor)", wCarrier.address);

    console.log("\n  [VEHIX]     solicitando faucet...");
    const { wallet: wVehix     } = await client.fundWallet();
    col("  wVehix      (Fee collector — plataforma Vehix)", wVehix.address);

    console.log("\n  [PILA]      solicitando faucet...");
    const { wallet: wPILA      } = await client.fundWallet();
    col("  wPILA       (Seguridad social del conductor)", wPILA.address);

    // ── PASO 2: Publicar oferta + EscrowCreate ────────────────────────────
    paso(2, "Publicar oferta + EscrowCreate  —  flete bloqueado 48 h");

    console.log();
    col("  Trip ID", VIAJE.id);
    col("  Ruta", `${VIAJE.origen} → ${VIAJE.destino}`);
    col("  Peso", `${VIAJE.peso_ton} toneladas`);
    col("  Tipo de carga", VIAJE.tipo_carga);
    col("  SICE-TAC mínimo", VIAJE.sice_tac);
    col("  Flete total", `${VIAJE.flete_xrp} XRP  =  ${copFmt(VIAJE.flete_xrp)}`);
    col("  Distribución", `Carrier ${CARRIER_PCT*100}% · PILA ${PILA_PCT*100}% · Vehix ${VEHIX_PCT*100}%`);
    col("  hash_rndc (parcial)", rndc_hash.slice(0, 20) + "…");
    col("  CancelAfter", `${VIAJE.timeout_h} h — si nadie llega, fondos regresan`);

    const finishAfterMs = Date.now() + 30_000;
    const cancelAfterMs = Date.now() + VIAJE.timeout_h * 3_600_000;

    const preparedEscrow = await client.autofill({
      TransactionType: "EscrowCreate",
      Account        : wGenerador.address,
      Amount         : xrpToDrops(String(VIAJE.flete_xrp)),
      Destination    : wVehix.address,
      FinishAfter    : unixTimeToRippleTime(finishAfterMs),
      CancelAfter    : unixTimeToRippleTime(cancelAfterMs),
      Memos          : buildMemo("oferta-viaje", {
        trip_id    : VIAJE.id,
        tipo_evento: "OFERTA_VIAJE_PUBLICADA",
        origen     : VIAJE.origen,
        destino    : VIAJE.destino,
        peso_ton   : VIAJE.peso_ton,
        tipo_carga : VIAJE.tipo_carga,
        sice_tac   : VIAJE.sice_tac,
        flete_xrp  : VIAJE.flete_xrp,
        hash_rndc  : rndc_hash,
        timeout_h  : VIAJE.timeout_h,
      }),
    });
    const escrowSeq    = preparedEscrow.Sequence;
    const escrowResult = await client.submitAndWait(wGenerador.sign(preparedEscrow).tx_blob);

    console.log();
    col("  Hash EscrowCreate", escrowResult.result.hash);
    col("  Estado", ok(escrowResult.result.meta.TransactionResult));
    col("  Flete bloqueado", `${VIAJE.flete_xrp} XRP → Vehix (intermediario escrow)`);
    col("  OfferSequence", escrowSeq);
    track("EscrowCreate — oferta publicada (17.5 XRP bloqueados)", escrowResult.result.hash);

    // ── PASO 3: Matching + Score on-chain del carrier ─────────────────────
    paso(3, "Matching + Score on-chain del carrier");

    console.log("\n  Carrier consulta la oferta y publica su score en Vehix…");

    const histResult = await payDrop(client, wCarrier, wVehix, "historial-carrier", {
      ...CARRIER_SCORE,
      carrier_address: wCarrier.address,
      timestamp      : new Date().toISOString(),
    });

    const sc = CARRIER_SCORE;
    console.log();
    col("  TX Score on-chain", ok(histResult.result.meta.TransactionResult));
    col("  Viajes completados", `${sc.viajes_completados}  (${sc.viajes_exitosos} exitosos)`);
    col("  Calificación promedio", `${sc.calificacion_promedio} ★`);
    col("  Score Vehix", `${sc.score_vehix} / 100`);
    col("  Tasa cumplimiento", sc.tasa_cumplimiento);
    col("  SICE-TAC habilitado", sc.sice_tac_habilitado ? "SÍ ✓" : "NO ✗");
    col("  Umbral mínimo Vehix", "Score ≥ 70 para aceptar el viaje");
    col("  Decisión",
      sc.score_vehix >= 70
        ? "CARRIER APROBADO — acepta el viaje ✓"
        : "CARRIER RECHAZADO ✗");
    track("Score historial carrier on-chain (1 drop)", histResult.result.hash);

    // ── PASO 4: GPS en ruta — 3 eventos on-chain ─────────────────────────
    paso(4, "GPS en ruta — 3 eventos on-chain  (1 drop c/u, carrier → generador)");

    console.log();

    for (const ev of GPS_EVENTS) {
      // Esperar FinishAfter ANTES del GPS de llegada para habilitar EscrowFinish
      if (ev.seq === 3) {
        const waitMs = Math.max(0, finishAfterMs - Date.now()) + 4_000;
        if (waitMs > 0) {
          col("  Esperando FinishAfter", `${Math.ceil(waitMs / 1000)}s…`);
          await new Promise((r) => setTimeout(r, waitMs));
        }
        console.log();
        console.log("  GPS 3 — LLEGADA detectada → activa EscrowFinish.");
      }

      const gpsResult = await payDrop(client, wCarrier, wGenerador, "gps-evento", {
        trip_id    : VIAJE.id,
        tipo_evento: ev.evento,
        nombre     : ev.nombre,
        lat        : ev.lat,
        lon        : ev.lon,
        hora_ruta  : ev.hora,
        secuencia  : ev.seq,
        timestamp  : new Date().toISOString(),
      });

      col(`  GPS ${ev.seq} [${ev.hora}] ${ev.evento.padEnd(22)}`, ok(gpsResult.result.meta.TransactionResult));
      col(`        ${ev.nombre}`, `(${ev.lat}, ${ev.lon})`);
      track(`GPS ${ev.seq} — ${ev.evento} (1 drop)`, gpsResult.result.hash);
      console.log();
    }

    // ── PASO 5: EscrowFinish + split atómico ──────────────────────────────
    paso(5, "EscrowFinish  +  distribución  —  Carrier · PILA · Vehix fee");

    // EscrowFinish — Generador confirma entrega del cargo
    const finishTx = await client.autofill({
      TransactionType: "EscrowFinish",
      Account        : wGenerador.address,
      Owner          : wGenerador.address,
      OfferSequence  : escrowSeq,
      Memos          : buildMemo("cargo-entregado", {
        trip_id     : VIAJE.id,
        tipo_evento : "CARGO_ENTREGADO_ESCROW_FINISH",
        hash_rndc   : rndc_hash,
        gps_llegada : {
          lat : GPS_EVENTS[2].lat,
          lon : GPS_EVENTS[2].lon,
          hora: GPS_EVENTS[2].hora,
        },
        timestamp   : new Date().toISOString(),
        pila_pin    : pila_pin,
        distribucion: {
          carrier_xrp,
          pila_xrp,
          vehix_xrp,
        },
      }),
    });
    const finishResult = await client.submitAndWait(wGenerador.sign(finishTx).tx_blob);

    console.log();
    col("  Hash EscrowFinish", finishResult.result.hash);
    col("  Estado", ok(finishResult.result.meta.TransactionResult));
    col("  Fondos liberados a Vehix", `${VIAJE.flete_xrp} XRP — procediendo split`);
    col("  PILA PIN simulado", pila_pin);
    col("  hash_rndc on-chain", rndc_hash.slice(0, 20) + "…");
    track("EscrowFinish — cargo entregado (RNDC + PILA PIN on-chain)", finishResult.result.hash);

    // Split: Vehix distribuye los fondos recibidos
    console.log("\n  Vehix distribuye fondos del escrow…\n");

    const r1 = await payXRP(client, wVehix, wCarrier, carrier_xrp, "pago-carrier", {
      trip_id    : VIAJE.id,
      tipo_evento: "PAGO_CARRIER_FLETE_NETO",
      monto_xrp  : carrier_xrp,
      monto_cop  : carrier_xrp * COP_PER_XRP,
      porcentaje : `${CARRIER_PCT * 100}%`,
      pila_pin   : pila_pin,
      concepto   : "Flete neto conductor",
    });
    col("  Carrier recibe", `${carrier_xrp} XRP  =  ${copFmt(carrier_xrp)}`);
    col("  Estado", ok(r1.result.meta.TransactionResult));
    track(`Pago Carrier — ${carrier_xrp} XRP (92.5% flete neto)`, r1.result.hash);

    const r2 = await payXRP(client, wVehix, wPILA, pila_xrp, "pago-pila-automatico", {
      trip_id    : VIAJE.id,
      tipo_evento: "PAGO_PILA_AUTOMATICO",
      monto_xrp  : pila_xrp,
      monto_cop  : pila_xrp * COP_PER_XRP,
      porcentaje : `${PILA_PCT * 100}%`,
      pila_pin   : pila_pin,
      concepto   : "Salud + Pensión + ARL conductor independiente",
    });
    col("  PILA recibe (automático)", `${pila_xrp} XRP  =  ${copFmt(pila_xrp)}`);
    col("  Estado", ok(r2.result.meta.TransactionResult));
    track(`Pago PILA automático — ${pila_xrp} XRP (6%)`, r2.result.hash);

    console.log();
    col("  Vehix retiene fee", `${vehix_xrp} XRP  =  ${copFmt(vehix_xrp)}  (1.5% — sin TX adicional)`);

    // ── PASO 6: Tabla resumen ─────────────────────────────────────────────
    paso(6, "Tabla resumen — viaje publicado → pagado");

    const p = (s, n) => String(s).padEnd(n);
    const xfmt = (x) => String(x).padEnd(8);
    const cfmt = (x) => copFmt(x).padEnd(22);

    console.log(`
  ┌──────────────────────────────────────────────────────────────────────┐
  │  FREIGHTFI Cargo Bank — Vehix Load                                   │
  │  Trip: ${p(VIAJE.id, 58)}  │
  ├──────────────────────────────────────────────────────────────────────┤
  │  Estado:  [PUBLICADO] → [ACEPTADO] → [EN RUTA] → [ENTREGADO/PAGADO] │
  │  Ruta  :  ${p(VIAJE.origen,22)} → ${p(VIAJE.destino,22)}  │
  │  Peso  :  ${p(VIAJE.peso_ton+" toneladas",58)}  │
  │  RNDC  :  ${p(rndc_hash.slice(0,20)+"…",58)}  │
  │  PILA PIN: ${p(pila_pin,57)}  │
  ├───────────────────────┬──────────────┬──────────────────────────────┤
  │  Concepto             │  XRP         │  COP equivalente             │
  ├───────────────────────┼──────────────┼──────────────────────────────┤
  │  Flete total          │  ${xfmt(VIAJE.flete_xrp)} XRP  │  ${cfmt(VIAJE.flete_xrp)}  │
  │  Carrier  (92.5%)     │  ${xfmt(carrier_xrp)} XRP  │  ${cfmt(carrier_xrp)}  │
  │  PILA     (6%)        │  ${xfmt(pila_xrp)} XRP  │  ${cfmt(pila_xrp)}  │
  │  Vehix fee (1.5%)     │  ${xfmt(vehix_xrp)} XRP  │  ${cfmt(vehix_xrp)}  │
  ├───────────────────────┴──────────────┴──────────────────────────────┤
  │  GPS eventos on-chain   : 3 / 3 ✓   (salida · autopista · llegada) │
  │  Transacciones totales  : ${p(txLinks.length,3)}                                    │
  │  EscrowCancel 48h       : Si carrier no llega → fondos a Generador  │
  └──────────────────────────────────────────────────────────────────────┘`);

    // ── PASO 7: Links ─────────────────────────────────────────────────────
    paso(7, "Links directos — XRPL Testnet Explorer");
    console.log();
    txLinks.forEach((t, i) => {
      console.log(`  [${String(i + 1).padStart(2)}] ${t.label}`);
      console.log(`       ${t.url}`);
    });

    console.log();
    console.log(hr("═"));
    console.log("  FREIGHTFI CARGO BANK — Completado exitosamente");
    console.log(hr("═") + "\n");

  } finally {
    await client.disconnect();
    console.log("  Desconectado del nodo XRPL.\n");
  }
}

runCargoBank().catch((err) => {
  console.error("Error:", err.message ?? err);
  process.exit(1);
});
