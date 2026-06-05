import { Client, xrpToDrops, dropsToXrp, unixTimeToRippleTime } from "xrpl";
import crypto from "crypto";

const TESTNET_URL = "wss://s.altnet.rippletest.net:51233";

const SHIPMENT = {
  id: "FF-2026-0001",
  cargo: "Combustible Industrial (Diesel B5)",
  origin: { city: "Monterrey, NL", lat: 25.6866, lon: -100.3161 },
  destination: { city: "Ciudad de México, CDMX", lat: 19.4326, lon: -99.1332 },
  distance_km: 940,
  freight_xrp: "10",
  driver: "Carlos Ramírez",
  plate: "ABC-1234",
  timeout_hours: 48,
};

// ── PREIMAGE-SHA-256 (ASN.1 DER) ─────────────────────────────────────────────
//
//  Fulfillment : A0 22  80 20  <32-byte preimage>
//  Condition   : A0 25  80 20  <SHA256(preimage)>  81 01 20
//
//  La empresa publica Condition on-chain; el Fulfillment se revela
//  solo cuando el GPS confirma llegada, actuando como "llave" del escrow.

function buildFulfillment(preimage) {
  const buf = Buffer.alloc(36);
  buf[0] = 0xa0; buf[1] = 0x22; // PREIMAGE-SHA-256, longitud 34
  buf[2] = 0x80; buf[3] = 0x20; // campo preimage, longitud 32
  preimage.copy(buf, 4);
  return buf.toString("hex").toUpperCase();
}

function buildCondition(preimage) {
  const hash = crypto.createHash("sha256").update(preimage).digest();
  const buf = Buffer.alloc(39);
  buf[0] = 0xa0; buf[1] = 0x25; // PREIMAGE-SHA-256, longitud 37
  buf[2] = 0x80; buf[3] = 0x20; // fingerprint SHA-256, longitud 32
  hash.copy(buf, 4);
  buf[36] = 0x81; buf[37] = 0x01; buf[38] = 0x20; // max-fulfillment-length = 32
  return buf.toString("hex").toUpperCase();
}

// ── Memo helpers ──────────────────────────────────────────────────────────────

const toHex = (s) => Buffer.from(s, "utf8").toString("hex").toUpperCase();
const fromHex = (h) => Buffer.from(h, "hex").toString("utf8");

function memo(type, payload) {
  return [{
    Memo: {
      MemoType: toHex(`freightfi/${type}`),
      MemoFormat: toHex("application/json"),
      MemoData: toHex(JSON.stringify(payload)),
    },
  }];
}

// ── GPS simulation ────────────────────────────────────────────────────────────

function simulateGPSArrival() {
  return {
    event: "DESTINATION_REACHED",
    timestamp: new Date().toISOString(),
    coordinates: { lat: SHIPMENT.destination.lat, lon: SHIPMENT.destination.lon },
    location: SHIPMENT.destination.city,
    speed_kmh: 0,
    accuracy_m: 4,
    odometer_km: SHIPMENT.distance_km,
    geofence_triggered: true,
  };
}

// ── Console helpers ───────────────────────────────────────────────────────────

const W = 56;
const hr = (c = "─") => c.repeat(W);
const col = (k, v) => console.log(`  ${k.padEnd(22)}: ${v}`);
const step = (n, title) => {
  console.log("\n" + hr());
  console.log(`  PASO ${n} — ${title}`);
  console.log(hr());
};

// ── Escrow flow ───────────────────────────────────────────────────────────────

async function runEscrow() {
  const client = new Client(TESTNET_URL);

  try {
    console.log(hr("═"));
    console.log("  FREIGHTFI ESCROW — Pago condicional GPS en XRPL");
    console.log(hr("═") + "\n");

    await client.connect();
    console.log("Conectado a XRPL Testnet.\n");

    // ── 1. Wallets ────────────────────────────────────────────────────────
    step(1, "Crear y fondear wallets");

    console.log("\n  [EMPRESA] solicitando faucet...");
    const { wallet: empresa, balance: balEmpresa } = await client.fundWallet();
    col("Dirección", empresa.address);
    col("Balance inicial", `${balEmpresa} XRP`);

    console.log("\n  [CAMIONERO] solicitando faucet...");
    const { wallet: camionero, balance: balCamionero } = await client.fundWallet();
    col("Dirección", camionero.address);
    col("Balance inicial", `${balCamionero} XRP`);

    // ── 2. Crypto-condition GPS ───────────────────────────────────────────
    step(2, "Generar crypto-condition PREIMAGE-SHA-256");

    const preimage = crypto.randomBytes(32);
    const fulfillment = buildFulfillment(preimage);
    const condition = buildCondition(preimage);

    console.log();
    col("Preimage (hex, parcial)", preimage.toString("hex").slice(0, 20) + "…");
    col("Condition (parcial)", condition.slice(0, 20) + "…");
    col("Tipo", "PREIMAGE-SHA-256 · ASN.1 DER");
    console.log(`
  La empresa publica la Condition en el escrow on-chain.
  El Fulfillment permanece secreto hasta que GPS confirma
  la llegada al destino, momento en que se revela para
  desbloquear los fondos.`);

    // ── 3. EscrowCreate ───────────────────────────────────────────────────
    step(3, "EscrowCreate — empresa deposita el flete");

    // unixTimeToRippleTime en xrpl v3 recibe milisegundos (hace /1000 internamente)
    const cancelAtMS = Date.now() + SHIPMENT.timeout_hours * 3_600_000;
    const cancelAtUnix = Math.floor(cancelAtMS / 1000);
    const cancelAtISO = new Date(cancelAtMS).toISOString();

    const escrowCreateTx = {
      TransactionType: "EscrowCreate",
      Account: empresa.address,
      Amount: xrpToDrops(SHIPMENT.freight_xrp),
      Destination: camionero.address,
      CancelAfter: unixTimeToRippleTime(cancelAtMS),
      Condition: condition,
      Memos: memo("escrow-create", {
        protocol: "FreightFi/1.0",
        shipment_id: SHIPMENT.id,
        cargo: SHIPMENT.cargo,
        driver: SHIPMENT.driver,
        plate: SHIPMENT.plate,
        route: {
          origin: SHIPMENT.origin,
          destination: SHIPMENT.destination,
          distance_km: SHIPMENT.distance_km,
        },
        amount_xrp: SHIPMENT.freight_xrp,
        condition_type: "PREIMAGE-SHA-256",
        cancel_after_iso: cancelAtISO,
        timeout_hours: SHIPMENT.timeout_hours,
      }),
    };

    console.log();
    col("Monto bloqueado", `${SHIPMENT.freight_xrp} XRP`);
    col("Beneficiario", camionero.address);
    col("Condición", "PREIMAGE-SHA-256");
    col("Expira (CancelAfter)", cancelAtISO);
    console.log("\n  Firmando y enviando EscrowCreate...");

    const preparedCreate = await client.autofill(escrowCreateTx);
    const signedCreate = empresa.sign(preparedCreate);
    const createResult = await client.submitAndWait(signedCreate.tx_blob);

    const escrowSeq = createResult.result.Sequence;

    console.log();
    col("Hash EscrowCreate", createResult.result.hash);
    col("Ledger #", createResult.result.ledger_index);
    col("Estado", createResult.result.meta.TransactionResult + " ✓");
    col("OfferSequence", escrowSeq);

    // ── 4. Verificar escrow en el ledger ──────────────────────────────────
    step(4, "Verificar escrow en account_objects");

    const { result: objResult } = await client.request({
      command: "account_objects",
      account: empresa.address,
      type: "escrow",
    });

    const esc = objResult.account_objects[0];
    console.log();
    col("Tipo de objeto", esc.LedgerEntryType);
    col("Monto congelado", `${dropsToXrp(esc.Amount)} XRP`);
    col("Destination", esc.Destination);
    col("CancelAfter (Ripple)", esc.CancelAfter);
    col("Condition (parcial)", esc.Condition.slice(0, 20) + "…");
    console.log("\n  Los fondos están congelados en el ledger.");
    console.log("  Sin el Fulfillment correcto, nadie puede acceder a ellos.");

    // ── 5. Evento GPS ─────────────────────────────────────────────────────
    step(5, "Simulación GPS: camión llega al destino");

    const gps = simulateGPSArrival();
    console.log();
    col("Evento", gps.event);
    col("Timestamp GPS", gps.timestamp);
    col("Coordenadas", `${gps.coordinates.lat}, ${gps.coordinates.lon}`);
    col("Velocidad", `${gps.speed_kmh} km/h`);
    col("Geocerca", "ACTIVADA → se libera el Fulfillment");

    // ── 6. EscrowFinish ───────────────────────────────────────────────────
    step(6, "EscrowFinish — camionero reclama el flete");

    // Fee especial requerido por el ledger para EscrowFinish con Fulfillment:
    //   fee = 12 + 320 × ceil(fulfillment_bytes / 16)  drops
    const fulfillmentBytes = fulfillment.length / 2; // hex string → bytes
    const escrowFinishFee = String(12 + 320 * Math.ceil(fulfillmentBytes / 16));

    const escrowFinishTx = {
      TransactionType: "EscrowFinish",
      Account: camionero.address,
      Owner: empresa.address,
      OfferSequence: escrowSeq,
      Condition: condition,
      Fulfillment: fulfillment,
      Fee: escrowFinishFee,
      Memos: memo("escrow-finish", {
        protocol: "FreightFi/1.0",
        shipment_id: SHIPMENT.id,
        action: "ESCROW_CLAIMED",
        gps_confirmation: gps,
        offer_sequence: escrowSeq,
        claimed_by: camionero.address,
      }),
    };

    console.log();
    col("Fulfillment (parcial)", fulfillment.slice(0, 20) + "…");
    col("Fee EscrowFinish", `${dropsToXrp(escrowFinishFee)} XRP`);
    console.log("\n  Camionero firma el EscrowFinish con el Fulfillment GPS...");

    const preparedFinish = await client.autofill(escrowFinishTx);
    preparedFinish.Fee = escrowFinishFee; // conservar fee calculado manualmente
    const signedFinish = camionero.sign(preparedFinish);
    const finishResult = await client.submitAndWait(signedFinish.tx_blob);

    const finishMeta = finishResult.result.meta;
    console.log();
    col("Hash EscrowFinish", finishResult.result.hash);
    col("Ledger #", finishResult.result.ledger_index);
    col("Estado", finishMeta.TransactionResult + " ✓");

    // ── 7. Balances finales ───────────────────────────────────────────────
    step(7, "Balances post-escrow");

    const [infoE, infoC] = await Promise.all([
      client.request({ command: "account_info", account: empresa.address, ledger_index: "validated" }),
      client.request({ command: "account_info", account: camionero.address, ledger_index: "validated" }),
    ]);

    const finalEmpresa = dropsToXrp(infoE.result.account_data.Balance);
    const finalCamionero = dropsToXrp(infoC.result.account_data.Balance);

    console.log();
    console.log("  EMPRESA:");
    col("  Inicio", `${balEmpresa} XRP`);
    col("  Final", `${finalEmpresa} XRP   (−${SHIPMENT.freight_xrp} flete −fee escrow)`);
    console.log("\n  CAMIONERO:");
    col("  Inicio", `${balCamionero} XRP`);
    col("  Final", `${finalCamionero} XRP  (+${SHIPMENT.freight_xrp} flete −fee finish)`);

    // ── 8. Verificar memos on-chain ───────────────────────────────────────
    step(8, "Auditoría: verificar memos on-chain");

    const [txCreate, txFinish] = await Promise.all([
      client.request({ command: "tx", transaction: createResult.result.hash }),
      client.request({ command: "tx", transaction: finishResult.result.hash }),
    ]);

    for (const [label, tx] of [["EscrowCreate", txCreate], ["EscrowFinish", txFinish]]) {
      const raw = tx.result.Memos?.[0]?.Memo;
      if (raw) {
        const data = JSON.parse(fromHex(raw.MemoData));
        console.log(`\n  [${label}] MemoType: ${fromHex(raw.MemoType)}`);
        console.log(
          JSON.stringify(data, null, 4)
            .split("\n")
            .map((l) => "    " + l)
            .join("\n")
        );
      }
    }

    // ── 9. Ruta de cancelación (timeout 48h) ──────────────────────────────
    step(9, "Ruta alternativa: EscrowCancel si timeout (48h)");

    console.log(`
  Si el GPS no confirma llegada antes de:
    ${cancelAtISO}

  La empresa (u otra cuenta) ejecuta:

    {
      TransactionType : "EscrowCancel",
      Account         : empresa.address,
      Owner           : empresa.address,
      OfferSequence   : ${escrowSeq},
    }

  Reglas del ledger XRPL:
  ✓  Solo ejecutable DESPUÉS de CancelAfter
  ✓  Devuelve los ${SHIPMENT.freight_xrp} XRP íntegros a la empresa
  ✓  Cualquier cuenta puede enviar la cancelación
  ✗  Imposible cancelar si ya fue reclamado con EscrowFinish
  ✗  Imposible reclamar con EscrowFinish después de CancelAfter`);

    console.log("\n" + hr("═"));
    console.log("  FREIGHTFI ESCROW — Flujo completado exitosamente");
    console.log(hr("═") + "\n");

  } finally {
    await client.disconnect();
    console.log("Desconectado del nodo XRPL.\n");
  }
}

runEscrow().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
