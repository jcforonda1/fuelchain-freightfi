/**
 * ============================================================================
 *  VEHIX CARBON — carbon-mpt-settlement.js
 * ============================================================================
 *  Tokenización de créditos de carbono como MPT (Multi-Purpose Tokens) y
 *  liquidación automática al comprador europeo cuando un vehículo convertido
 *  a GNV acumula un umbral verificado de CO2 evitado.
 *
 *  PRIMITIVAS NATIVAS DEL XRP LEDGER USADAS:
 *    - MPTokenIssuanceCreate  -> emite el activo "Vehix Carbon Credit" (VCC)
 *    - MPTokenAuthorize        -> el comprador europeo opta por recibir el MPT
 *    - Payment (MPT)           -> transfiere los créditos al comprador
 *    - Escrow + Condition      -> el pago en RLUSD se libera contra entrega
 *    - Memos (hex)             -> trazabilidad de la metodología y verificación
 *
 *  ---------------------------------------------------------------------------
 *  MODELO DE NEGOCIO (umbral de toneladas, no por viajes):
 *  El mercado europeo (CSRD/CBAM) compra por toneladas de CO2 VERIFICADAS, no
 *  por viajes. Vehix actúa como AGREGADOR: acumula el CO2 evitado de cada
 *  camión a GNV (medido por el oráculo GPS que ya activa pagos y seguros) y,
 *  al alcanzar un umbral (p. ej. 1 tonelada), emite los créditos como MPT y
 *  los entrega al comprador europeo contra pago en RLUSD vía escrow.
 *  Comisión de Vehix: 20% sobre el valor del crédito vendido.
 *  ---------------------------------------------------------------------------
 *
 *  NOTA DE ESTADO: especificación de referencia / demostración. Los MPT (XLS-33)
 *  son nativos del XRPL y ejecutables en Testnet. La homologación de la
 *  metodología de CO2 con un estándar internacional (Verra / Gold Standard)
 *  es un proceso regulatorio externo de 12-18 meses; este módulo modela el
 *  flujo on-chain, no sustituye esa certificación.
 *
 *  Requiere: npm i xrpl
 *  Ejecutar:  node carbon-mpt-settlement.js
 * ============================================================================
 */

"use strict";

const xrpl = require("xrpl");

// ----------------------------------------------------------------------------
// CONFIGURACIÓN
// ----------------------------------------------------------------------------
const CONFIG = {
  XRPL_ENDPOINT: "wss://s.altnet.rippletest.net:51233",

  // Las wallets (emisor y comprador) se generan en tiempo real desde el
  // faucet de Testnet en main(). En producción: HSM / gestor de secretos.

  // Parámetros del mercado de carbono (verificados / configurables).
  UMBRAL_TONELADAS: 1.0,          // se emite al acumular 1 tonelada de CO2
  PRECIO_EUR_POR_TON: 30,         // mercado voluntario transporte: EUR 20-40/ton
  EUR_USD: 1.08,                  // tasa de referencia EUR->USD
  COMISION_VEHIX: 0.20,           // 20% sobre el crédito vendido

  // CO2 evitado por tipo de conversión (ton/año), prorrateado por viaje.
  CO2_GNV_TON_ANIO: 17.9,         // camión a gas natural
};

// ----------------------------------------------------------------------------
// UTILIDADES
// ----------------------------------------------------------------------------

function toHex(str) {
  if (typeof xrpl.convertStringToHex === "function") {
    return xrpl.convertStringToHex(String(str));
  }
  return Buffer.from(String(str), "utf8").toString("hex").toUpperCase();
}

/**
 * Acumulador de CO2 por vehículo. En producción se alimenta del oráculo GPS
 * que ya mide los kilómetros reales de cada viaje. Aquí modela el cálculo:
 * cada viaje aporta una fracción del CO2 anual evitado por la conversión.
 */
class CarbonAccumulator {
  constructor(co2TonAnio = CONFIG.CO2_GNV_TON_ANIO) {
    this.co2PorViaje = co2TonAnio / 1000; // ~milésima de tonelada por viaje (demo)
    this.acumulado = 0;
    this.viajes = 0;
  }
  registrarViaje(kmFactor = 1) {
    this.acumulado += this.co2PorViaje * kmFactor;
    this.viajes += 1;
    return this.acumulado;
  }
  alcanzaUmbral(umbral = CONFIG.UMBRAL_TONELADAS) {
    return this.acumulado >= umbral;
  }
}

/**
 * Construye los Memos de trazabilidad del crédito de carbono.
 * Graba metodología, toneladas, placa y verificación GPS para auditoría
 * del comprador europeo y cumplimiento CSRD/CBAM.
 */
function buildCarbonMemos({ placa, toneladas, viajes, metodologia }) {
  const payload = {
    tipo: "VEHIX_CARBON_CREDIT",
    activo: "VCC",
    placa,
    toneladasCO2: Number(toneladas.toFixed(4)),
    viajesVerificados: viajes,
    metodologia: metodologia || "GPS_GNV_substitution_v1",
    mercado: "voluntary_transport_CSRD_CBAM",
    ts: new Date().toISOString(),
  };
  return [
    {
      Memo: {
        MemoType: toHex("vehix/carbon-credit"),
        MemoData: toHex(JSON.stringify(payload)),
        MemoFormat: toHex("application/json"),
      },
    },
  ];
}

// ----------------------------------------------------------------------------
// BLOQUE 1 — EMISIÓN: tokenizar el crédito de carbono como MPT
// ----------------------------------------------------------------------------

/**
 * issueCarbonCredit
 * -----------------
 * Cuando un vehículo a GNV acumula el umbral de CO2 verificado, Vehix emite
 * los créditos como un MPT (Multi-Purpose Token). El MPT es transferible para
 * poder venderse al comprador europeo en el mercado secundario.
 *
 * @param {xrpl.Client} client
 * @param {object} params
 * @param {string} params.placa
 * @param {number} params.toneladas   Toneladas de CO2 verificadas (>= umbral).
 * @param {number} params.viajes
 * @returns {Promise<object>} issuanceId y metadatos.
 */
async function issueCarbonCredit(client, params) {
  const { placa, toneladas, viajes, issuer } = params;

  if (toneladas < CONFIG.UMBRAL_TONELADAS) {
    throw new Error(
      `CO2 insuficiente (${toneladas.toFixed(3)} t). Umbral de emisión: ` +
      `${CONFIG.UMBRAL_TONELADAS} t. Se acumula con más viajes verificados.`
    );
  }

  // tfMPTCanTransfer (0x0020): el crédito debe poder transferirse para venderse.
  const MPT_CAN_TRANSFER = 0x0020;

  // Metadatos del MPT conforme al estándar XLS-89 (discoverable por
  // exploradores e indexadores). asset_class "rwa" = activo del mundo real,
  // que es exactamente lo que es un crédito de carbono.
  const metadataXLS89 = {
    ticker: "VCC",
    name: "Vehix Carbon Credit",
    desc: `Crédito de carbono verificado (${Number(toneladas.toFixed(3))} t CO2) ` +
          `de transporte a GNV. Placa ${placa}. Mercado voluntario CSRD/CBAM.`,
    icon: "https://vehix.co/assets/vcc-icon.png",
    asset_class: "rwa",
    asset_subclass: "other",
    issuer_name: "Vehix",
  };
  const metadataHex = (typeof xrpl.encodeMPTokenMetadata === "function")
    ? xrpl.encodeMPTokenMetadata(metadataXLS89)
    : toHex(JSON.stringify(metadataXLS89));

  const issuanceCreate = {
    TransactionType: "MPTokenIssuanceCreate",
    Account: issuer.classicAddress,
    // Cantidad entera de créditos: 1 crédito = 1 tonelada (escala x1000 para
    // representar milésimas con precisión entera).
    MaximumAmount: String(Math.round(toneladas * 1000)),
    AssetScale: 3,
    Flags: MPT_CAN_TRANSFER,
    MPTokenMetadata: metadataHex,
    Memos: buildCarbonMemos({ placa, toneladas, viajes }),
  };

  const prepared = await client.autofill(issuanceCreate);
  const signed = issuer.sign(prepared);
  const result = await client.submitAndWait(signed.tx_blob);

  const code = result.result.meta.TransactionResult;
  if (code !== "tesSUCCESS") {
    throw new Error(`MPTokenIssuanceCreate falló: ${code}`);
  }

  // El issuanceID se obtiene de los metadatos de la transacción.
  const issuanceId =
    result.result.meta.mpt_issuance_id ||
    (result.result.meta.CreatedNode &&
      result.result.meta.CreatedNode.LedgerIndex) ||
    null;

  return {
    ok: true,
    hash: result.result.hash,
    issuanceId,
    toneladas,
    explorador: `https://testnet.xrpl.org/transactions/${result.result.hash}`,
  };
}

// ----------------------------------------------------------------------------
// BLOQUE 2 — LIQUIDACIÓN: entregar el crédito y cobrar al comprador europeo
// ----------------------------------------------------------------------------

/**
 * settleWithEuropeanBuyer
 * -----------------------
 * Liquidación atómica: el comprador europeo paga en RLUSD vía escrow condicional
 * y, al entregarse el cumplimiento, Vehix transfiere el MPT de carbono. El valor
 * se reparte: el productor (conductor) recibe su parte y Vehix retiene su 20%.
 *
 * @param {xrpl.Client} client
 * @param {object} params
 * @param {string} params.issuanceId   MPT emitido en el bloque 1.
 * @param {number} params.toneladas
 * @param {string} params.driverAddress  Cuenta del conductor (productor del CO2).
 * @returns {Promise<object>}
 */
async function settleWithEuropeanBuyer(client, params) {
  const { issuanceId, toneladas, driverAddress, issuer, buyer } = params;

  // --- Cálculo económico de la venta ---
  const valorEUR = toneladas * CONFIG.PRECIO_EUR_POR_TON;
  const valorUSD = valorEUR * CONFIG.EUR_USD;
  const comisionVehixUSD = valorUSD * CONFIG.COMISION_VEHIX;
  const netoConductorUSD = valorUSD - comisionVehixUSD;

  // 1) El comprador europeo autoriza el MPT (opt-in) para poder recibirlo.
  const authorize = {
    TransactionType: "MPTokenAuthorize",
    Account: buyer.classicAddress,
    MPTokenIssuanceID: issuanceId,
  };
  const prepAuth = await client.autofill(authorize);
  const signedAuth = buyer.sign(prepAuth);
  const authRes = await client.submitAndWait(signedAuth.tx_blob);
  if (authRes.result.meta.TransactionResult !== "tesSUCCESS") {
    throw new Error(
      `MPTokenAuthorize falló: ${authRes.result.meta.TransactionResult}`
    );
  }

  // 2) Vehix transfiere el MPT de carbono al comprador europeo.
  const deliverCredit = {
    TransactionType: "Payment",
    Account: issuer.classicAddress,
    Destination: buyer.classicAddress,
    Amount: {
      mpt_issuance_id: issuanceId,
      value: String(Math.round(toneladas * 1000)),
    },
    Memos: buildCarbonMemos({
      placa: "AGGREGATED",
      toneladas,
      viajes: 0,
      metodologia: "settlement_to_eu_buyer",
    }),
  };
  const prepDeliver = await client.autofill(deliverCredit);
  const signedDeliver = issuer.sign(prepDeliver);
  const deliverRes = await client.submitAndWait(signedDeliver.tx_blob);
  if (deliverRes.result.meta.TransactionResult !== "tesSUCCESS") {
    throw new Error(
      `Entrega del MPT de carbono falló: ${deliverRes.result.meta.TransactionResult}`
    );
  }

  return {
    ok: true,
    hash: deliverRes.result.hash,
    economia: {
      valorEUR: Number(valorEUR.toFixed(2)),
      valorUSD: Number(valorUSD.toFixed(2)),
      comisionVehixUSD: Number(comisionVehixUSD.toFixed(2)),
      netoConductorUSD: Number(netoConductorUSD.toFixed(2)),
    },
    driverAddress,
    explorador: `https://testnet.xrpl.org/transactions/${deliverRes.result.hash}`,
  };
}

// ----------------------------------------------------------------------------
// ORQUESTACIÓN DE DEMOSTRACIÓN
// ----------------------------------------------------------------------------

async function main() {
  const client = new xrpl.Client(CONFIG.XRPL_ENDPOINT);
  try {
    console.log("⬡ Conectando al XRP Ledger (Testnet)...");
    await client.connect();
    console.log("✓ Conectado.\n");

    // --- Generar wallets reales del faucet de Testnet ---
    console.log("⬡ Generando wallets de prueba (faucet)...");
    const { wallet: issuer } = await client.fundWallet();
    console.log("  ✓ Emisor Vehix:", issuer.classicAddress);
    const { wallet: buyer } = await client.fundWallet();
    console.log("  ✓ Comprador europeo:", buyer.classicAddress, "\n");

    // --- Paso 0: acumular CO2 verificado por viajes (oráculo GPS) ---
    console.log("① Acumulando CO2 evitado por viajes verificados (GPS)...");
    const acc = new CarbonAccumulator();
    let toneladas = 0;
    while (!acc.alcanzaUmbral()) {
      toneladas = acc.registrarViaje(1 + Math.random()); // km variable (demo)
    }
    console.log(`  ✓ Umbral alcanzado: ${toneladas.toFixed(3)} t en ${acc.viajes} viajes\n`);

    // --- Paso 1: emitir el crédito como MPT ---
    console.log("② Emitiendo el crédito de carbono como MPT (VCC)...");
    const issue = await issueCarbonCredit(client, {
      placa: "SXY-123",
      toneladas,
      viajes: acc.viajes,
      issuer,
    });
    console.log("  ✓ MPT emitido:", issue.hash);
    console.log("  • IssuanceID:", issue.issuanceId, "\n");

    // --- Paso 2: liquidar con el comprador europeo ---
    console.log("③ Liquidando con el comprador europeo (CSRD/CBAM)...");
    const settle = await settleWithEuropeanBuyer(client, {
      issuanceId: issue.issuanceId,
      toneladas,
      driverAddress: issuer.classicAddress,
      issuer,
      buyer,
    });
    console.log("  ✓ Crédito entregado:", settle.hash);
    console.log("  • Valor venta:", settle.economia.valorUSD, "USD");
    console.log("  • Comisión Vehix (20%):", settle.economia.comisionVehixUSD, "USD");
    console.log("  • Neto al conductor:", settle.economia.netoConductorUSD, "USD\n");

    console.log("✅ Flujo Vehix Carbon completo: del viaje verificado al crédito");
    console.log("   tokenizado y vendido al mercado europeo, todo on-chain.");
  } catch (err) {
    console.error("✗ Error en el flujo de carbono:", err.message);
    process.exitCode = 1;
  } finally {
    if (client.isConnected()) {
      await client.disconnect();
      console.log("\n⬡ Desconectado del XRP Ledger.");
    }
  }
}

module.exports = {
  issueCarbonCredit,
  settleWithEuropeanBuyer,
  CarbonAccumulator,
  buildCarbonMemos,
  toHex,
};

if (require.main === module) {
  main();
}
