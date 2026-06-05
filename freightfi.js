import { Client, Wallet, xrpToDrops, dropsToXrp } from "xrpl";

const TESTNET_URL = "wss://s.altnet.rippletest.net:51233";

// XRPL exige que MemoType, MemoFormat y MemoData sean hex en mayúsculas
const toHex = (str) => Buffer.from(str, "utf8").toString("hex").toUpperCase();
const fromHex = (hex) => Buffer.from(hex, "hex").toString("utf8");

// ─── Definición del envío ────────────────────────────────────────────────────

const SHIPMENT = {
  id: "FF-2026-0001",
  cargo: "Combustible Industrial (Diesel B5)",
  origin: { city: "Monterrey, NL", lat: 25.6866, lon: -100.3161 },
  destination: { city: "Ciudad de México, CDMX", lat: 19.4326, lon: -99.1332 },
  distance_km: 940,
  freight_xrp: "10",
  driver: "Carlos Ramírez",
  plate: "ABC-1234",
};

// ─── Simulación GPS ──────────────────────────────────────────────────────────

function simulateGPSArrival() {
  return {
    event: "DESTINATION_REACHED",
    timestamp: new Date().toISOString(),
    coordinates: {
      lat: SHIPMENT.destination.lat,
      lon: SHIPMENT.destination.lon,
    },
    location: SHIPMENT.destination.city,
    speed_kmh: 0,
    accuracy_m: 4,
    odometer_km: SHIPMENT.distance_km,
    geofence_triggered: true,
  };
}

// ─── Helpers de consola ──────────────────────────────────────────────────────

const hr = (char = "─", len = 50) => char.repeat(len);
const log = (label, value) =>
  console.log(`  ${label.padEnd(16)}: ${value}`);

// ─── Flujo principal ─────────────────────────────────────────────────────────

async function runFreightFi() {
  const client = new Client(TESTNET_URL);

  try {
    console.log(hr("═"));
    console.log("  FREIGHTFI — Pago de flete con confirmación GPS en XRPL");
    console.log(hr("═"));
    console.log();

    console.log("Conectando a XRPL Testnet...");
    await client.connect();
    console.log("Conexión establecida.\n");

    // ── 1. Crear wallets ──────────────────────────────────────────────────
    console.log(hr());
    console.log("  PASO 1 — Crear wallets");
    console.log(hr());

    console.log("\n  Fondeando wallet EMPRESA (faucet)...");
    const { wallet: empresa, balance: balEmpresa } = await client.fundWallet();
    log("Dirección", empresa.address);
    log("Balance inicial", `${balEmpresa} XRP`);

    console.log("\n  Fondeando wallet CAMIONERO (faucet)...");
    const { wallet: camionero, balance: balCamionero } = await client.fundWallet();
    log("Dirección", camionero.address);
    log("Balance inicial", `${balCamionero} XRP`);

    // ── 2. Datos del envío ────────────────────────────────────────────────
    console.log("\n" + hr());
    console.log("  PASO 2 — Datos del envío");
    console.log(hr());
    log("ID", SHIPMENT.id);
    log("Cargo", SHIPMENT.cargo);
    log("Origen", SHIPMENT.origin.city);
    log("Destino", SHIPMENT.destination.city);
    log("Distancia", `${SHIPMENT.distance_km} km`);
    log("Conductor", SHIPMENT.driver);
    log("Placa", SHIPMENT.plate);
    log("Flete", `${SHIPMENT.freight_xrp} XRP`);

    // ── 3. Evento GPS de llegada ──────────────────────────────────────────
    console.log("\n" + hr());
    console.log("  PASO 3 — Simulación GPS: llegada al destino");
    console.log(hr());

    const gps = simulateGPSArrival();
    log("Evento", gps.event);
    log("Timestamp", gps.timestamp);
    log("Coordenadas", `${gps.coordinates.lat}, ${gps.coordinates.lon}`);
    log("Ubicación", gps.location);
    log("Velocidad", `${gps.speed_kmh} km/h`);
    log("Geocerca", gps.geofence_triggered ? "ACTIVADA ✓" : "inactiva");

    // ── 4. Construir memo ─────────────────────────────────────────────────
    console.log("\n" + hr());
    console.log("  PASO 4 — Construir memo on-chain");
    console.log(hr());

    const memoPayload = {
      protocol: "FreightFi/1.0",
      shipment_id: SHIPMENT.id,
      cargo: SHIPMENT.cargo,
      route: {
        origin: SHIPMENT.origin,
        destination: SHIPMENT.destination,
        distance_km: SHIPMENT.distance_km,
      },
      driver: SHIPMENT.driver,
      vehicle_plate: SHIPMENT.plate,
      gps_confirmation: gps,
      payment_trigger: "GPS_ARRIVAL_CONFIRMED",
      amount_xrp: SHIPMENT.freight_xrp,
      payer: empresa.address,
      payee: camionero.address,
    };

    const memos = [
      {
        Memo: {
          MemoType: toHex("freightfi/gps-delivery"),
          MemoFormat: toHex("application/json"),
          MemoData: toHex(JSON.stringify(memoPayload)),
        },
      },
    ];

    console.log("  Memo serializado y codificado en hex.");
    console.log(`  Tamaño del payload: ${JSON.stringify(memoPayload).length} bytes`);

    // ── 5. Enviar transacción ─────────────────────────────────────────────
    console.log("\n" + hr());
    console.log("  PASO 5 — Enviar pago EMPRESA → CAMIONERO");
    console.log(hr());

    const payment = {
      TransactionType: "Payment",
      Account: empresa.address,
      Destination: camionero.address,
      Amount: xrpToDrops(SHIPMENT.freight_xrp),
      Memos: memos,
    };

    console.log(`\n  Preparando transacción...`);
    const prepared = await client.autofill(payment);
    const signed = empresa.sign(prepared);

    console.log(`  Firmando con clave de EMPRESA...`);
    console.log(`  Enviando al ledger y esperando validación...\n`);
    const result = await client.submitAndWait(signed.tx_blob);

    const meta = result.result.meta;
    const txHash = result.result.hash;
    const ledgerIndex = result.result.ledger_index;
    const fee = dropsToXrp(result.result.Fee);
    const txResult = meta.TransactionResult;

    console.log(hr("═"));
    console.log("  TRANSACCIÓN CONFIRMADA EN EL LEDGER");
    console.log(hr("═"));
    log("Hash", txHash);
    log("Ledger #", ledgerIndex);
    log("Estado", txResult === "tesSUCCESS" ? "tesSUCCESS ✓" : txResult);
    log("Fee pagado", `${fee} XRP`);
    log("Monto flete", `${SHIPMENT.freight_xrp} XRP`);

    // ── 6. Balances finales ───────────────────────────────────────────────
    console.log("\n" + hr());
    console.log("  PASO 6 — Balances post-transacción");
    console.log(hr());

    const [infoEmpresa, infoCamionero] = await Promise.all([
      client.request({
        command: "account_info",
        account: empresa.address,
        ledger_index: "validated",
      }),
      client.request({
        command: "account_info",
        account: camionero.address,
        ledger_index: "validated",
      }),
    ]);

    const saldoEmpresa = dropsToXrp(infoEmpresa.result.account_data.Balance);
    const saldoCamionero = dropsToXrp(infoCamionero.result.account_data.Balance);

    console.log();
    log("EMPRESA", `${saldoEmpresa} XRP  (inicial: ${balEmpresa})`);
    log("CAMIONERO", `${saldoCamionero} XRP  (inicial: ${balCamionero})`);

    // ── 7. Verificar memo on-chain ────────────────────────────────────────
    console.log("\n" + hr());
    console.log("  PASO 7 — Verificar memo registrado on-chain");
    console.log(hr());

    const txInfo = await client.request({
      command: "tx",
      transaction: txHash,
    });

    const rawMemo = txInfo.result.Memos?.[0]?.Memo;
    if (rawMemo) {
      const decodedType = fromHex(rawMemo.MemoType);
      const decodedFormat = fromHex(rawMemo.MemoFormat);
      const decodedData = JSON.parse(fromHex(rawMemo.MemoData));

      console.log();
      log("MemoType", decodedType);
      log("MemoFormat", decodedFormat);
      console.log("\n  MemoData (payload completo):");
      console.log(JSON.stringify(decodedData, null, 4)
        .split("\n")
        .map((l) => "    " + l)
        .join("\n"));
    }

    console.log("\n" + hr("═"));
    console.log("  FREIGHTFI — Flujo completado exitosamente");
    console.log(hr("═"));
    console.log();

  } finally {
    await client.disconnect();
    console.log("Desconectado del nodo XRPL.\n");
  }
}

runFreightFi().catch((err) => {
  console.error("Error fatal:", err.message);
  process.exit(1);
});
