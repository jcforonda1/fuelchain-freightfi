import {
  Client,
  Wallet,
  xrpToDrops,
  dropsToXrp,
  unixTimeToRippleTime,
  multisign,
} from "xrpl";
import crypto from "crypto";

const TESTNET_URL = "wss://s.altnet.rippletest.net:51233";
const EXPLORER    = "https://testnet.xrpl.org/transactions";

const TRIP = {
  id           : "FF-TRIP-2026-0042",
  cargo        : "Combustible Industrial (Diesel B5)",
  origin       : "Monterrey, NL",
  destination  : "Ciudad de México, CDMX",
  freight_xrp  : "10",
  timeout_hours: 48,
};

// ── Console helpers ───────────────────────────────────────────────────────────

const W    = 62;
const hr   = (c = "─") => c.repeat(W);
const col    = (k, v) => console.log(`  ${String(k).padEnd(28)}: ${v}`);
const status = (r) => r === "tesSUCCESS" ? r + " ✓" : r + " ✗";
const step = (n, title) => {
  console.log("\n" + hr());
  console.log(`  PASO ${n} — ${title}`);
  console.log(hr());
};

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

// ── Oracle simulators ─────────────────────────────────────────────────────────

function simulateOracleGPS(tripId) {
  const event = {
    oracle           : "GPS",
    event            : "DESTINATION_REACHED",
    trip_id          : tripId,
    timestamp        : new Date().toISOString(),
    coordinates      : { lat: 19.4326, lon: -99.1332 },
    location         : TRIP.destination,
    speed_kmh        : 0,
    accuracy_m       : 4,
    geofence_triggered: true,
  };
  return {
    event,
    hash: crypto.createHash("sha256").update(JSON.stringify(event)).digest("hex"),
  };
}

function simulateOraclePuerto(tripId) {
  const event = {
    oracle           : "PUERTO",
    event            : "CARGO_RECEIVED",
    trip_id          : tripId,
    timestamp        : new Date().toISOString(),
    location         : "Terminal Logística CDMX",
    document_verified: true,
    seal_intact      : true,
    manifest_ref     : `MANIF-${tripId}`,
  };
  return {
    event,
    hash: crypto.createHash("sha256").update(JSON.stringify(event)).digest("hex"),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function runOracleMultisig() {
  const client = new Client(TESTNET_URL);

  try {
    console.log("\n" + hr("═"));
    console.log("  FREIGHTFI — Oracle Multisig 2-de-3 en XRPL Testnet");
    console.log(hr("═") + "\n");

    await client.connect();
    console.log("  Conectado a XRPL Testnet.\n");

    // ── PASO 1: Fondear wallets ────────────────────────────────────────────
    step(1, "Crear y fondear wallets (cuenta escrow + 3 oráculos)");

    console.log("\n  [VIAJE]  solicitando faucet...");
    const { wallet: wViaje  } = await client.fundWallet();
    col("  wViaje (escrow account)", wViaje.address);

    console.log("\n  [GPS]    solicitando faucet...");
    const { wallet: wGPS    } = await client.fundWallet();
    col("  wGPS   (oráculo)", wGPS.address);

    console.log("\n  [PUERTO] solicitando faucet...");
    const { wallet: wPuerto } = await client.fundWallet();
    col("  wPuerto (oráculo)", wPuerto.address);

    console.log("\n  [DIAN]   solicitando faucet...");
    const { wallet: wDIAN   } = await client.fundWallet();
    col("  wDIAN  (oráculo)", wDIAN.address);

    console.log("\n  [CARRIER] solicitando faucet...");
    const { wallet: wCarrier } = await client.fundWallet();
    col("  wCarrier (destino flete)", wCarrier.address);

    // ── PASO 2: SignerListSet ─────────────────────────────────────────────
    step(2, "SignerListSet en wViaje  —  quórum 2-de-3, weight 1 c/u");

    const signerListTx = {
      TransactionType: "SignerListSet",
      Account        : wViaje.address,
      SignerQuorum   : 2,
      SignerEntries  : [
        { SignerEntry: { Account: wGPS.address,    SignerWeight: 1 } },
        { SignerEntry: { Account: wPuerto.address,  SignerWeight: 1 } },
        { SignerEntry: { Account: wDIAN.address,   SignerWeight: 1 } },
      ],
    };

    const preparedSL  = await client.autofill(signerListTx);
    const signedSL    = wViaje.sign(preparedSL);
    const slResult    = await client.submitAndWait(signedSL.tx_blob);

    console.log();
    col("  Hash", slResult.result.hash);
    col("  Estado", status(slResult.result.meta.TransactionResult));
    col("  SignerQuorum", "2");
    col("  Firmantes registrados", "GPS(1) · PUERTO(1) · DIAN(1)");
    console.log(`\n  🔗  ${EXPLORER}/${slResult.result.hash}`);

    // ── PASO 3: EscrowCreate ──────────────────────────────────────────────
    step(3, `EscrowCreate  —  ${TRIP.freight_xrp} XRP bloqueados · CancelAfter 48 h`);

    const cancelAtMS   = Date.now() + TRIP.timeout_hours * 3_600_000;
    const cancelAtISO  = new Date(cancelAtMS).toISOString();
    // FinishAfter debe ser > close_time del ledger que valida EscrowCreate.
    // 30s garantiza que el ledger lo incluya antes de que expire y que
    // EscrowFinish se envíe después de que FinishAfter pase.
    const finishAfterMs = Date.now() + 30_000;

    const escrowCreateTx = {
      TransactionType: "EscrowCreate",
      Account        : wViaje.address,
      Amount         : xrpToDrops(TRIP.freight_xrp),
      Destination    : wCarrier.address,
      FinishAfter    : unixTimeToRippleTime(finishAfterMs),
      CancelAfter    : unixTimeToRippleTime(cancelAtMS),
      Memos          : buildMemo("escrow-create", {
        protocol     : "FreightFi/2.0",
        trip_id      : TRIP.id,
        cargo        : TRIP.cargo,
        route        : `${TRIP.origin} → ${TRIP.destination}`,
        amount_xrp   : TRIP.freight_xrp,
        signer_quorum: "2-de-3",
        oracles      : ["GPS", "PUERTO", "DIAN"],
        cancel_after_iso: cancelAtISO,
      }),
    };

    const preparedCreate = await client.autofill(escrowCreateTx);
    const signedCreate   = wViaje.sign(preparedCreate);
    const createResult   = await client.submitAndWait(signedCreate.tx_blob);
    const escrowSeq      = preparedCreate.Sequence; // OfferSequence para EscrowFinish

    console.log();
    col("  Hash EscrowCreate", createResult.result.hash);
    col("  Estado", status(createResult.result.meta.TransactionResult));
    col("  Monto bloqueado", `${TRIP.freight_xrp} XRP`);
    col("  Destino", wCarrier.address.slice(0, 14) + "…");
    col("  OfferSequence", escrowSeq);
    col("  CancelAfter", cancelAtISO);
    console.log(`\n  🔗  ${EXPLORER}/${createResult.result.hash}`);

    // Esperar hasta que FinishAfter pase en el ledger antes de llamar EscrowFinish
    const waitMs = Math.max(0, finishAfterMs - Date.now()) + 4_000;
    if (waitMs > 0) {
      col("  Esperando FinishAfter", `${Math.ceil(waitMs / 1000)}s…`);
      await new Promise((r) => setTimeout(r, waitMs));
    }

    // ── PASO 4: Oráculos confirman llegada ────────────────────────────────
    step(4, "Simulación: GPS + Puerto firman llegada  (DIAN no participa)");

    const gps       = simulateOracleGPS(TRIP.id);
    const puerto    = simulateOraclePuerto(TRIP.id);
    const pilaPin   = crypto.randomBytes(4).toString("hex").toUpperCase();

    console.log();
    col("  GPS · evento", gps.event.event);
    col("  GPS · timestamp", gps.event.timestamp);
    col("  oracle_gps_hash (parcial)", gps.hash.slice(0, 20) + "…");
    console.log();
    col("  Puerto · evento", puerto.event.event);
    col("  Puerto · timestamp", puerto.event.timestamp);
    col("  oracle_port_hash (parcial)", puerto.hash.slice(0, 20) + "…");
    console.log();
    col("  DIAN", "Sin firma  (quórum 2-de-3 ya alcanzado)");
    col("  PILA PIN simulado", pilaPin);
    console.log("\n  Quórum 2-de-3 alcanzado → construyendo EscrowFinish multisig.");

    // ── PASO 5: EscrowFinish con multisig ─────────────────────────────────
    step(5, "EscrowFinish — SigningPubKey vacío · authorizeMultisign · multisign");

    const memoPayload = {
      protocol        : "FreightFi/2.0",
      trip_id         : TRIP.id,
      oracle_gps_hash : gps.hash,
      oracle_port_hash: puerto.hash,
      timestamp_utc   : new Date().toISOString(),
      pila_pin        : pilaPin,
      signers         : ["GPS", "PUERTO"],
      quorum          : "2-de-3",
    };

    // Tx base: SigningPubKey vacío indica que será firmada por multisig
    const escrowFinishTx = {
      TransactionType: "EscrowFinish",
      Account        : wViaje.address,
      Owner          : wViaje.address,
      OfferSequence  : escrowSeq,
      SigningPubKey  : "",
      Memos          : buildMemo("escrow-finish", memoPayload),
    };

    // autofill rellena Sequence, LastLedgerSequence, Fee base
    const preparedFinish = await client.autofill(escrowFinishTx);
    // Reimponer SigningPubKey vacío y fee multisig: (N_signers + 1) × 12 drops
    preparedFinish.SigningPubKey = "";
    preparedFinish.Fee           = "36"; // (2 + 1) × 12 drops

    // authorizeMultisign: cada oráculo firma la tx de forma independiente
    const gpsBlob    = wGPS.sign(preparedFinish,    true).tx_blob; // authorizeMultisign GPS
    const puertoBlob = wPuerto.sign(preparedFinish, true).tx_blob; // authorizeMultisign Puerto

    console.log();
    col("  SigningPubKey", '""  (multisig mode)');
    col("  authorizeMultisign GPS",    gpsBlob.slice(0, 18)    + "…");
    col("  authorizeMultisign Puerto", puertoBlob.slice(0, 18) + "…");

    // multisign: combina ambas firmas en una sola tx válida
    const combinedBlob = multisign([gpsBlob, puertoBlob]);
    col("  multisign() → blob combinado", combinedBlob.slice(0, 18) + "…");

    console.log("\n  Enviando EscrowFinish multisig al ledger...");
    const finishResult = await client.submitAndWait(combinedBlob);

    console.log();
    col("  Hash EscrowFinish", finishResult.result.hash);
    col("  Estado", status(finishResult.result.meta.TransactionResult));
    col("  Ledger #", finishResult.result.ledger_index);
    console.log(`\n  🔗  ${EXPLORER}/${finishResult.result.hash}`);

    // ── Verificar memos on-chain ──────────────────────────────────────────
    const { result: txFinish } = await client.request({
      command    : "tx",
      transaction: finishResult.result.hash,
    });
    const raw = txFinish.Memos?.[0]?.Memo;
    if (raw) {
      const data = JSON.parse(fromHex(raw.MemoData));
      console.log("\n  Memo on-chain verificado:");
      console.log(
        JSON.stringify(data, null, 2)
          .split("\n")
          .map((l) => "    " + l)
          .join("\n")
      );
    }

    // ── PASO 6: Links directos al Explorer ───────────────────────────────
    step(6, "Links directos — XRPL Testnet Explorer");

    console.log(`
  [1] SignerListSet (registro oráculos 2-de-3):
      ${EXPLORER}/${slResult.result.hash}

  [2] EscrowCreate (${TRIP.freight_xrp} XRP bloqueados · CancelAfter 48 h):
      ${EXPLORER}/${createResult.result.hash}

  [3] EscrowFinish (multisig GPS + Puerto):
      ${EXPLORER}/${finishResult.result.hash}
`);

    console.log(hr("═"));
    console.log("  FREIGHTFI ORACLE MULTISIG — Completado exitosamente");
    console.log(hr("═") + "\n");

  } finally {
    await client.disconnect();
    console.log("  Desconectado del nodo XRPL.\n");
  }
}

runOracleMultisig().catch((err) => {
  console.error("Error:", err.message ?? err);
  process.exit(1);
});
