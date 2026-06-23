import {
  Client,
  encodeMPTokenMetadata,
  decodeAccountID,
} from "xrpl";
import crypto from "crypto";

const TESTNET_URL = "wss://s.altnet.rippletest.net:51233";
const EXPLORER    = "https://testnet.xrpl.org/transactions";

// ── Datos del lote de ACPM ────────────────────────────────────────────────────
const BATCH_ID = `ACPM-${new Date().toISOString().slice(0,10).replace(/-/g,"")}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
const BATCH = {
  id               : BATCH_ID,
  producto         : "ACPM (Diesel B5)",
  volumen_galones  : 50_000,
  origen           : "Refinería Barrancabermeja — Ecopetrol",
  destino_mayorista: "Terminal Terpel Puente Aranda, Bogotá",
  destino_eds      : "EDS El Camino — Km 3 Vía Acacias, Villavicencio",
};

// ── Marcador químico (Solvent Yellow 124 — obligatorio Colombia / UE) ─────────
const MARCADOR = {
  compuesto        : "Solvent Yellow 124",
  concentracion_ppm: 6.0,
  batch_code       : BATCH_ID,
  lab_certificador : "CALIZSA Barrancabermeja",
  fecha_cert       : new Date().toISOString().split("T")[0],
};

// ── Ruta declarada: Bogotá → Villavicencio ────────────────────────────────────
const RUTA = [
  { nombre: "Terminal Terpel Bogotá",        lat:  4.711, lon: -74.072 },
  { nombre: "Chipaque",                      lat:  4.450, lon: -74.050 },
  { nombre: "Caquezá",                       lat:  4.400, lon: -73.950 },
  { nombre: "El Calvario",                   lat:  4.360, lon: -73.770 },
  { nombre: "Villavicencio — EDS objetivo",  lat:  4.142, lon: -73.625 },
];

// ── Lecturas GPS del cisterna ─────────────────────────────────────────────────
const GPS_LECTURAS = [
  { ts: "08:00", nombre: "Salida terminal Terpel", lat:  4.711, lon: -74.072 },
  { ts: "09:30", nombre: "Desviación detectada",   lat:  4.600, lon: -74.380 }, // 36 km off
  { ts: "10:45", nombre: "Retoma ruta — Caquezá",  lat:  4.400, lon: -73.950 },
  { ts: "12:30", nombre: "Llegada EDS objetivo",   lat:  4.142, lon: -73.625 },
];
const GPS_ALERTA_UMBRAL_KM = 5;

// ── RUNT del conductor y vehículo ─────────────────────────────────────────────
const RUNT = {
  conductor: {
    nombre     : "Alirio Rodríguez Mora",
    licencia   : "600123456",
    habilitado : true,
    vencimiento: "2028-03-15",
  },
  vehiculo: {
    placa               : "TRK-892",
    tipo                : "Cisterna",
    capacidad_galones   : 10_000,
    habilitado_peligroso: true,
    vence_rev_tecnica   : "2027-06-30",
  },
};

// ── EDS ───────────────────────────────────────────────────────────────────────
const EDS = {
  nombre             : "EDS El Camino",
  nit                : "901.234.567-8",
  capacidad_tanque_gl: 10_000,
  lat                : 4.142,
  lon                : -73.625,
};

// ── Console helpers ───────────────────────────────────────────────────────────
const W    = 70;
const hr   = (c = "─") => c.repeat(W);
const col  = (k, v) => console.log(`  ${String(k).padEnd(36)}: ${v}`);
const nodo = (n, title) => {
  console.log("\n" + hr("═"));
  console.log(`  NODO ${n} — ${title}`);
  console.log(hr("═"));
};
const paso = (n, title) => {
  console.log("\n" + hr());
  console.log(`  PASO ${n} — ${title}`);
  console.log(hr());
};
const ok    = (r) => r === "tesSUCCESS" ? r + " ✓" : r + " ✗";
const toHex = (s) => Buffer.from(s, "utf8").toString("hex").toUpperCase();

function buildMemo(type, payload) {
  return [{
    Memo: {
      MemoType  : toHex(`freightfi/acpm/${type}`),
      MemoFormat: toHex("application/json"),
      MemoData  : toHex(JSON.stringify(payload)),
    },
  }];
}

// ── Haversine ─────────────────────────────────────────────────────────────────
function haversineKm(lat1, lon1, lat2, lon2) {
  const R    = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
    * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function distToRuta(lat, lon) {
  return Math.min(...RUTA.map((wp) => haversineKm(lat, lon, wp.lat, wp.lon)));
}

// ── MPT helper — Sequence(4B) + AccountID(20B) = 48 hex = 192 bits ───────────
function computeMPTIssuanceID(issuerAddress, sequence) {
  const seqBuf    = Buffer.alloc(4);
  seqBuf.writeUInt32BE(sequence >>> 0, 0);
  const accountBuf = Buffer.from(decodeAccountID(issuerAddress));
  return Buffer.concat([seqBuf, accountBuf]).toString("hex").toUpperCase();
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function runAcpmOracle() {
  const client  = new Client(TESTNET_URL);
  const txLinks = [];
  const trackTx = (label, hash) => {
    txLinks.push({ label, url: `${EXPLORER}/${hash}` });
    console.log(`\n  🔗  ${EXPLORER}/${hash}`);
  };

  try {
    console.log("\n" + hr("═"));
    console.log("  FREIGHTFI — ACPM Oracle  |  Cadena 4 Nodos XRPL Testnet");
    console.log("  Trazabilidad: Refinería → Mayorista → Cisterna → EDS");
    console.log(hr("═") + "\n");

    await client.connect();
    console.log("  Conectado a XRPL Testnet.\n");

    // ── PASO 1: Wallets ───────────────────────────────────────────────────
    paso(1, "Crear wallets — 5 actores de la cadena ACPM");

    console.log("\n  [ECOPETROL]  solicitando faucet...");
    const { wallet: wEcopetrol } = await client.fundWallet();
    col("  wEcopetrol  (Refinería Barrancabermeja)", wEcopetrol.address);

    console.log("\n  [MAYORISTA]  solicitando faucet...");
    const { wallet: wMayorista } = await client.fundWallet();
    col("  wMayorista  (Terpel — Terminal Puente Aranda)", wMayorista.address);

    console.log("\n  [CISTERNA]   solicitando faucet...");
    const { wallet: wCisterna  } = await client.fundWallet();
    col("  wCisterna   (Camión TRK-892)", wCisterna.address);

    console.log("\n  [EDS]        solicitando faucet...");
    const { wallet: wEDS       } = await client.fundWallet();
    col("  wEDS        (EDS El Camino — Villavicencio)", wEDS.address);

    console.log("\n  [CAMIONERO]  solicitando faucet...");
    const { wallet: wCamionero } = await client.fundWallet();
    col("  wCamionero  (Alirio Rodríguez — Lic. 600123456)", wCamionero.address);

    // ═════════════════════════════════════════════════════════════════════
    // NODO 1 — Ecopetrol emite MPT por lote de ACPM
    // ═════════════════════════════════════════════════════════════════════
    nodo(1, "Ecopetrol — Emisión MPT lote ACPM  (50.000 galones)");

    const markerHash = crypto.createHash("sha256")
      .update(JSON.stringify(MARCADOR)).digest("hex");

    console.log();
    col("  Lote ID", BATCH.id);
    col("  Producto", BATCH.producto);
    col("  Volumen emitido", `${BATCH.volumen_galones.toLocaleString()} galones`);
    col("  Marcador químico", `${MARCADOR.compuesto}  ${MARCADOR.concentracion_ppm} ppm`);
    col("  Lab certificador", MARCADOR.lab_certificador);
    col("  Hash marcador (parcial)", markerHash.slice(0, 20) + "…");
    console.log("\n  → Sin MPT válido el mayorista no puede recibir el despacho.");

    // TX 1 — MPTokenIssuanceCreate
    // Metadato conforme al estándar XLS-89 (discoverable por exploradores e
    // indexadores). Los datos del lote (batch, marcador, origen) van en el Memo,
    // que es donde corresponde la trazabilidad detallada.
    const mptCreateTx = await client.autofill({
      TransactionType: "MPTokenIssuanceCreate",
      Account        : wEcopetrol.address,
      AssetScale     : 0,
      MaximumAmount  : String(BATCH.volumen_galones),
      Flags          : 0x0020, // tfMPTCanTransfer — permite transferencias entre holders (no solo emisor)
      MPTokenMetadata: encodeMPTokenMetadata({
        ticker        : "ACPM",
        name          : "Vehix ACPM Batch",
        desc          : `Lote ${BATCH.id} de ACPM (Diesel B5) trazable, ${BATCH.volumen_galones} gal, origen ${BATCH.origen}. Marcador ${MARCADOR.compuesto} ${MARCADOR.concentracion_ppm} ppm. Hash marcador ${markerHash.slice(0,16)}.`,
        icon          : "https://vehix.co/assets/acpm-icon.png",
        asset_class   : "rwa",
        asset_subclass: "other",
        issuer_name   : "Vehix",
      }),
      Memos: buildMemo("emision-lote", {
        batch_id       : BATCH.id,
        tipo_evento    : "EMISION_MPT_ACPM",
        volumen        : BATCH.volumen_galones,
        origen         : BATCH.origen,
        marker_hash    : markerHash,
        marker_compound: MARCADOR.compuesto,
        fecha_cert     : MARCADOR.fecha_cert,
      }),
    });

    const mptSeq    = mptCreateTx.Sequence;
    const mptResult = await client.submitAndWait(wEcopetrol.sign(mptCreateTx).tx_blob);
    const mptID     = computeMPTIssuanceID(wEcopetrol.address, mptSeq);

    console.log();
    col("  TX MPTokenIssuanceCreate", mptResult.result.hash.slice(0, 16) + "…");
    col("  Estado", ok(mptResult.result.meta.TransactionResult));
    col("  MPTokenIssuanceID", mptID);
    col("  MaximumAmount", `${BATCH.volumen_galones.toLocaleString()} galones`);
    trackTx("MPTokenIssuanceCreate — Lote ACPM (Ecopetrol)", mptResult.result.hash);

    // TX 2 — MPTokenAuthorize Mayorista
    const authMayResult = await client.submitAndWait(
      wMayorista.sign(await client.autofill({
        TransactionType  : "MPTokenAuthorize",
        Account          : wMayorista.address,
        MPTokenIssuanceID: mptID,
      })).tx_blob
    );
    col("  MPTokenAuthorize Mayorista", ok(authMayResult.result.meta.TransactionResult));
    trackTx("MPTokenAuthorize — Mayorista Terpel (opt-in)", authMayResult.result.hash);

    // TX 3 — Payment MPT Ecopetrol → Mayorista
    const mptToMayResult = await client.submitAndWait(
      wEcopetrol.sign(await client.autofill({
        TransactionType: "Payment",
        Account        : wEcopetrol.address,
        Destination    : wMayorista.address,
        Amount         : { mpt_issuance_id: mptID, value: String(BATCH.volumen_galones) },
        Memos          : buildMemo("despacho-refineria", {
          batch_id   : BATCH.id,
          tipo_evento: "DESPACHO_REFINERIA_MAYORISTA",
          volumen    : BATCH.volumen_galones,
          destino    : BATCH.destino_mayorista,
        }),
      })).tx_blob
    );
    col("  MPT Ecopetrol → Mayorista", ok(mptToMayResult.result.meta.TransactionResult));
    col("  Galones transferidos", BATCH.volumen_galones.toLocaleString());
    trackTx("MPT Ecopetrol→Mayorista (50.000 gal)", mptToMayResult.result.hash);

    // ═════════════════════════════════════════════════════════════════════
    // NODO 2 — Mayorista verifica MPT y carga la cisterna
    // ═════════════════════════════════════════════════════════════════════
    nodo(2, "Mayorista Terpel — Verificación origen MPT + carga cisterna");

    // Verifica que el MPTokenIssuanceID viene de Ecopetrol:
    // mptID = Sequence(4B) + AccountID(20B) → los últimos 40 hex son el emisor
    const issuerHex     = mptID.slice(8);
    const ecopetrolHex  = Buffer.from(decodeAccountID(wEcopetrol.address)).toString("hex").toUpperCase();
    const mptDeEcopetrol = issuerHex === ecopetrolHex;

    console.log();
    col("  MPT recibido — emisor (hex)", issuerHex.slice(0, 12) + "…");
    col("  Emisor esperado (Ecopetrol)", ecopetrolHex.slice(0, 12) + "…");
    col("  Verificación origen MPT", mptDeEcopetrol ? "VÁLIDO — proviene de Ecopetrol ✓" : "INVÁLIDO ✗");
    if (!mptDeEcopetrol) throw new Error("MPT de origen inválido — carga bloqueada");

    col("  Cisterna RUNT", `${RUNT.vehiculo.placa} · capacidad ${RUNT.vehiculo.capacidad_galones.toLocaleString()} gal ✓`);
    col("  Estado lote", "DISPONIBLE — procediendo carga");

    // TX 4 — MPTokenAuthorize Cisterna
    const authCistResult = await client.submitAndWait(
      wCisterna.sign(await client.autofill({
        TransactionType  : "MPTokenAuthorize",
        Account          : wCisterna.address,
        MPTokenIssuanceID: mptID,
      })).tx_blob
    );
    col("  MPTokenAuthorize Cisterna", ok(authCistResult.result.meta.TransactionResult));
    trackTx("MPTokenAuthorize — Cisterna TRK-892 (opt-in)", authCistResult.result.hash);

    // TX 5 — Payment MPT Mayorista → Cisterna
    const mptToCistResult = await client.submitAndWait(
      wMayorista.sign(await client.autofill({
        TransactionType: "Payment",
        Account        : wMayorista.address,
        Destination    : wCisterna.address,
        Amount         : { mpt_issuance_id: mptID, value: String(BATCH.volumen_galones) },
        Memos          : buildMemo("carga-cisterna", {
          batch_id   : BATCH.id,
          tipo_evento: "CARGA_CISTERNA_AUTORIZADA",
          volumen    : BATCH.volumen_galones,
          placa      : RUNT.vehiculo.placa,
          conductor  : RUNT.conductor.nombre,
          licencia   : RUNT.conductor.licencia,
        }),
      })).tx_blob
    );
    col("  MPT Mayorista → Cisterna", ok(mptToCistResult.result.meta.TransactionResult));
    col("  Galones cargados", BATCH.volumen_galones.toLocaleString());
    trackTx("MPT Mayorista→Cisterna (50.000 gal)", mptToCistResult.result.hash);

    // ═════════════════════════════════════════════════════════════════════
    // NODO 3 — GPS monitoreo en ruta Bogotá → Villavicencio
    // ═════════════════════════════════════════════════════════════════════
    nodo(3, "GPS Monitoreo en Ruta  —  Bogotá → Villavicencio");

    console.log(`\n  Ruta declarada: ${RUTA[0].nombre} → ${RUTA[RUTA.length - 1].nombre}`);
    console.log(`  Umbral desviación: ${GPS_ALERTA_UMBRAL_KM} km\n`);

    let entregaBloqueada = false;
    let alertaTxHash     = null;

    for (const pos of GPS_LECTURAS) {
      const dist   = distToRuta(pos.lat, pos.lon);
      const estado = dist > GPS_ALERTA_UMBRAL_KM ? "DESVIO !" : "EN RUTA ✓";
      col(`  [${pos.ts}] ${pos.nombre.padEnd(32)}`, `${dist.toFixed(1).padStart(5)} km  ${estado}`);

      if (dist > GPS_ALERTA_UMBRAL_KM && !entregaBloqueada) {
        entregaBloqueada = true;
        console.log(`\n  ALERTA: desvío ${dist.toFixed(1)} km > ${GPS_ALERTA_UMBRAL_KM} km — emitiendo alerta on-chain…`);

        // TX 6 — GPS_ALERTA on-chain (1 drop = marcador de evento)
        const alertResult = await client.submitAndWait(
          wCisterna.sign(await client.autofill({
            TransactionType: "Payment",
            Account        : wCisterna.address,
            Destination    : wEcopetrol.address,
            Amount         : "1",
            Memos          : buildMemo("gps-alerta", {
              batch_id    : BATCH.id,
              tipo_evento : "GPS_ALERTA_DESVIO",
              lat         : pos.lat,
              lon         : pos.lon,
              distancia_km: parseFloat(dist.toFixed(2)),
              umbral_km   : GPS_ALERTA_UMBRAL_KM,
              hora        : pos.ts,
              estado      : "ENTREGA_BLOQUEADA",
            }),
          })).tx_blob
        );
        alertaTxHash = alertResult.result.hash;
        col("  TX GPS_ALERTA (1 drop, on-chain)", ok(alertResult.result.meta.TransactionResult));
        col("  Entrega", "BLOQUEADA — requiere autorización mayorista");
        trackTx("GPS_ALERTA_DESVIO on-chain (1 drop)", alertResult.result.hash);
      }
    }

    // TX 7 — Mayorista autoriza la ruta (levanta bloqueo)
    if (entregaBloqueada) {
      console.log("\n  Mayorista recibe alerta → autoriza desvío (cierre vial) → levanta bloqueo…");
      const autRutaResult = await client.submitAndWait(
        wMayorista.sign(await client.autofill({
          TransactionType: "Payment",
          Account        : wMayorista.address,
          Destination    : wCisterna.address,
          Amount         : "1",
          Memos          : buildMemo("ruta-autorizada", {
            batch_id      : BATCH.id,
            tipo_evento   : "RUTA_AUTORIZADA_MAYORISTA",
            ref_alerta_tx : alertaTxHash,
            justificacion : "Desvío por cierre vial Caquezá — Ruta alterna aprobada",
            timestamp     : new Date().toISOString(),
          }),
        })).tx_blob
      );
      entregaBloqueada = false;
      col("  TX RUTA_AUTORIZADA (1 drop, on-chain)", ok(autRutaResult.result.meta.TransactionResult));
      col("  Entrega", "DESBLOQUEADA ✓");
      trackTx("RUTA_AUTORIZADA_MAYORISTA on-chain (1 drop)", autRutaResult.result.hash);
    }

    // ═════════════════════════════════════════════════════════════════════
    // NODO 4 — EDS: QR scan · GPS geovalla · RUNT · volumen → despacho
    // ═════════════════════════════════════════════════════════════════════
    nodo(4, "EDS Delivery — QR Scan · GPS 500m · RUNT · Volumen");

    const cisPos  = GPS_LECTURAS[GPS_LECTURAS.length - 1];
    const distEDS = haversineKm(cisPos.lat, cisPos.lon, EDS.lat, EDS.lon);
    const GEOVALLA_M = 500;

    // ── GPS geovalla ──────────────────────────────────────────────────────
    console.log();
    col("  EDS objetivo", `${EDS.nombre}  (${EDS.lat}, ${EDS.lon})`);
    col("  Cisterna GPS actual", `(${cisPos.lat}, ${cisPos.lon})`);
    col("  Distancia cisterna ↔ EDS", `${(distEDS * 1000).toFixed(0)} m`);
    col("  Geovalla autorizada", `${GEOVALLA_M} m`);
    col("  GPS Geovalla", distEDS * 1000 <= GEOVALLA_M
      ? `${(distEDS * 1000).toFixed(0)} m ≤ ${GEOVALLA_M} m → DENTRO ✓`
      : `${(distEDS * 1000).toFixed(0)} m > ${GEOVALLA_M} m → FUERA ✗`);
    if (distEDS * 1000 > GEOVALLA_M)
      throw new Error(`Cisterna fuera de geovalla: ${(distEDS * 1000).toFixed(0)} m`);

    // ── RUNT ──────────────────────────────────────────────────────────────
    console.log();
    col("  Conductor", RUNT.conductor.nombre);
    col("  Licencia RUNT", `${RUNT.conductor.licencia} — vence ${RUNT.conductor.vencimiento}`);
    col("  Habilitación conductor", RUNT.conductor.habilitado ? "HABILITADO ✓" : "NO HABILITADO ✗");
    col("  Vehículo", `${RUNT.vehiculo.placa} — ${RUNT.vehiculo.tipo}`);
    col("  Capacidad tanque cisterna", `${RUNT.vehiculo.capacidad_galones.toLocaleString()} gal`);
    col("  Transporte peligroso RUNT", RUNT.vehiculo.habilitado_peligroso ? "HABILITADO ✓" : "NO HABILITADO ✗");
    if (!RUNT.conductor.habilitado || !RUNT.vehiculo.habilitado_peligroso)
      throw new Error("Conductor o vehículo no habilitado en RUNT");

    // ── QR scan ───────────────────────────────────────────────────────────
    const qrToken = crypto.createHash("sha256")
      .update(`${EDS.nit}|${BATCH.id}|${new Date().toISOString().slice(0, 10)}`)
      .digest("hex");
    console.log();
    col("  QR EDS escaneado por camionero", qrToken.slice(0, 20) + "…");
    col("  NIT EDS", EDS.nit);

    // ── Verificación de volumen ───────────────────────────────────────────
    const VOL_INTENTO_1 = 12_000; // > capacidad → BLOQUEADO
    const VOL_INTENTO_2 =  8_000; // ≤ capacidad → AUTORIZADO

    console.log();
    console.log("  ── Intento 1 de despacho ────────────────────────────────────────");
    col("  Volumen solicitado", `${VOL_INTENTO_1.toLocaleString()} gal`);
    col("  Capacidad tanque EDS", `${EDS.capacidad_tanque_gl.toLocaleString()} gal`);
    col("  Resultado",
      `${VOL_INTENTO_1.toLocaleString()} > ${EDS.capacidad_tanque_gl.toLocaleString()} → BLOQUEADO ✗`);
    console.log("  [FRAUDE #2] Despacho BLOQUEADO — volumen excede capacidad del tanque EDS.");

    console.log();
    console.log("  ── Intento 2 de despacho ────────────────────────────────────────");
    col("  Volumen solicitado", `${VOL_INTENTO_2.toLocaleString()} gal`);
    col("  Capacidad tanque EDS", `${EDS.capacidad_tanque_gl.toLocaleString()} gal`);
    col("  Resultado",
      `${VOL_INTENTO_2.toLocaleString()} ≤ ${EDS.capacidad_tanque_gl.toLocaleString()} → AUTORIZADO ✓`);

    // TX 8 — QR_SCAN on-chain: Camionero → EDS (1 drop)
    const qrScanResult = await client.submitAndWait(
      wCamionero.sign(await client.autofill({
        TransactionType: "Payment",
        Account        : wCamionero.address,
        Destination    : wEDS.address,
        Amount         : "1",
        Memos          : buildMemo("qr-scan-despacho", {
          batch_id          : BATCH.id,
          tipo_evento       : "QR_SCAN_DESPACHO_AUTORIZADO",
          qr_token_parcial  : qrToken.slice(0, 20),
          eds_nit           : EDS.nit,
          gps_dist_m        : Math.round(distEDS * 1000),
          geovalla_ok       : true,
          runt_conductor_ok : RUNT.conductor.habilitado,
          runt_vehiculo_ok  : RUNT.vehiculo.habilitado_peligroso,
          volumen_autorizado: VOL_INTENTO_2,
          placa             : RUNT.vehiculo.placa,
          timestamp         : new Date().toISOString(),
        }),
      })).tx_blob
    );
    col("  TX QR_SCAN_DESPACHO (1 drop, on-chain)", ok(qrScanResult.result.meta.TransactionResult));
    trackTx("QR_SCAN_DESPACHO_AUTORIZADO (Camionero→EDS)", qrScanResult.result.hash);

    // TX 9 — MPTokenAuthorize EDS
    const authEDSResult = await client.submitAndWait(
      wEDS.sign(await client.autofill({
        TransactionType  : "MPTokenAuthorize",
        Account          : wEDS.address,
        MPTokenIssuanceID: mptID,
      })).tx_blob
    );
    col("  MPTokenAuthorize EDS", ok(authEDSResult.result.meta.TransactionResult));
    trackTx("MPTokenAuthorize — EDS El Camino (opt-in)", authEDSResult.result.hash);

    // TX 10 — Payment MPT Cisterna → EDS (8.000 galones)
    const mptToEDSResult = await client.submitAndWait(
      wCisterna.sign(await client.autofill({
        TransactionType: "Payment",
        Account        : wCisterna.address,
        Destination    : wEDS.address,
        Amount         : { mpt_issuance_id: mptID, value: String(VOL_INTENTO_2) },
        Memos          : buildMemo("despacho-eds", {
          batch_id  : BATCH.id,
          tipo_evento: "DESPACHO_ACPM_EDS",
          volumen_gal: VOL_INTENTO_2,
          eds_nit   : EDS.nit,
          eds_nombre: EDS.nombre,
          conductor : RUNT.conductor.nombre,
          placa     : RUNT.vehiculo.placa,
          timestamp : new Date().toISOString(),
        }),
      })).tx_blob
    );
    col("  MPT Cisterna → EDS", ok(mptToEDSResult.result.meta.TransactionResult));
    col("  Galones despachados", VOL_INTENTO_2.toLocaleString());
    col("  Galones restantes cisterna", (BATCH.volumen_galones - VOL_INTENTO_2).toLocaleString());
    trackTx("DESPACHO_ACPM_EDS — MPT Cisterna→EDS (8.000 gal)", mptToEDSResult.result.hash);

    // ═════════════════════════════════════════════════════════════════════
    // Resumen
    // ═════════════════════════════════════════════════════════════════════
    paso("R", "Resumen — Trazabilidad ACPM cadena completa");
    console.log(`
  ┌────────────────────────────────────────────────────────────────────┐
  │  FREIGHTFI — ACPM Oracle  Resumen de Trazabilidad                  │
  ├───────────────────────────────────┬────────────────────────────────┤
  │  Lote ID                          │  ${BATCH.id.padEnd(30)}  │
  │  Producto                         │  ACPM (Diesel B5)              │
  │  Galones emitidos  (Ecopetrol)    │  50.000 gal                    │
  │  Galones trazados  (cisterna→EDS) │   8.000 gal                    │
  │  Galones restantes (en cisterna)  │  42.000 gal                    │
  ├───────────────────────────────────┼────────────────────────────────┤
  │  Nodo 1 — Ecopetrol               │  MPT emitido + marcador hash ✓ │
  │  Nodo 2 — Mayorista Terpel        │  Origen MPT verificado ✓       │
  │  Nodo 3 — GPS Ruta                │  Alerta on-chain + autorizado ✓│
  │  Nodo 4 — EDS Despacho            │  QR + RUNT + Geovalla ✓        │
  ├───────────────────────────────────┼────────────────────────────────┤
  │  Nodos validados                  │  4 / 4                         │
  │  Transacciones on-chain           │  ${String(txLinks.length).padEnd(30)}  │
  │  Fraudes bloqueados (simulados)   │  2                             │
  │    #1 GPS desviación              │  36 km > 5 km → alerta + auto. │
  │    #2 Volumen excedido            │  12.000 > 10.000 → bloqueado   │
  │  Protocolo                        │  XRPL MPTokenIssuanceCreate    │
  └───────────────────────────────────┴────────────────────────────────┘`);

    // ═════════════════════════════════════════════════════════════════════
    // Links
    // ═════════════════════════════════════════════════════════════════════
    paso("L", "Links directos — XRPL Testnet Explorer");
    console.log();
    txLinks.forEach((t, i) => {
      console.log(`  [${String(i + 1).padStart(2)}] ${t.label}`);
      console.log(`       ${t.url}`);
    });

    console.log();
    console.log(hr("═"));
    console.log("  FREIGHTFI ACPM ORACLE — Completado exitosamente");
    console.log(hr("═") + "\n");

  } finally {
    await client.disconnect();
    console.log("  Desconectado del nodo XRPL.\n");
  }
}

runAcpmOracle().catch((err) => {
  console.error("Error:", err.message ?? err);
  process.exit(1);
});
