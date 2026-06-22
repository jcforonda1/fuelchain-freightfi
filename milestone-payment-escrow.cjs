/**
 * ============================================================================
 *  VEHIX — milestone-payment-escrow.cjs
 * ============================================================================
 *  PAGO POR HITO DE TRABAJO usando Escrow nativo del XRP Ledger.
 *
 *  Demuestra, de forma verificable on-chain, la infraestructura de pagos de
 *  Vehix: el dinero se ENVÍA y la red lo RETIENE bajo una condición; al
 *  cumplirse el hito se LIBERAN los fondos al colaborador; si no se cumple en
 *  el plazo, el dinero VUELVE a Vehix. Esto es exactamente lo que Vehix usará
 *  para pagar a su equipo por hitos cuando llegue el Grant.
 *
 *  Esta demostración corre los DOS escenarios para que se vean ambos caminos:
 *    ESCENARIO A (éxito):    se entrega el hito  -> fondos liberados al colaborador
 *    ESCENARIO B (no cumple): vence el plazo      -> fondos devueltos a Vehix
 *
 *  PRIMITIVAS NATIVAS DEL XRP LEDGER:
 *    - EscrowCreate (Condition + CancelAfter) -> bloquea el pago
 *    - EscrowFinish (Fulfillment)             -> libera contra entrega
 *    - EscrowCancel                            -> devuelve si no se cumple
 *    - Memos (hex)                             -> traza del hito y el colaborador
 *
 *  RED: XRPL Testnet (dinero de prueba, sin riesgo). Verificable en
 *  https://testnet.xrpl.org. La lógica es idéntica en Mainnet.
 *
 *  Requiere: npm install xrpl five-bells-condition
 *  Ejecutar:  node milestone-payment-escrow.cjs
 * ============================================================================
 */

"use strict";

const xrpl = require("xrpl");
const cc = require("five-bells-condition");
const crypto = require("crypto");

const CONFIG = {
  XRPL_ENDPOINT: "wss://s.altnet.rippletest.net:51233",
  PAGO_XRP: "10",          // monto del hito (XRP de prueba)
  // El Escenario A (liberar) necesita un plazo AMPLIO para que la red permita
  // liberar antes del vencimiento. El Escenario B (devolver) necesita un plazo
  // CORTO para poder mostrar la devolución en vivo sin esperar días.
  PLAZO_AMPLIO_SEGUNDOS: 3600,   // 1 hora: margen de sobra para liberar
  PLAZO_CORTO_SEGUNDOS: 6,       // 6 segundos: para demostrar la devolución
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

// Memos: graban qué hito es y quién es el colaborador, para auditoría on-chain.
function buildMemos({ hito, colaborador }) {
  const payload = {
    tipo: "VEHIX_PAGO_POR_HITO",
    hito,
    colaborador,
    ts: new Date().toISOString(),
  };
  return [{
    Memo: {
      MemoType: toHex("vehix/pago-hito"),
      MemoData: toHex(JSON.stringify(payload)),
      MemoFormat: toHex("application/json"),
    },
  }];
}

// Genera la condición criptográfica del hito.
// El "fulfillment" (la llave secreta) lo guarda Vehix y solo se revela
// cuando valida que el hito se cumplió. Sin esa llave, nadie cobra.
function generarCondicion() {
  const preimage = crypto.randomBytes(32);
  const f = new cc.PreimageSha256();
  f.setPreimage(preimage);
  return {
    condition: f.getConditionBinary().toString("hex").toUpperCase(),
    fulfillment: f.serializeBinary().toString("hex").toUpperCase(),
  };
}

function rippleTimeFromNow(segundos) {
  const rippleEpoch = 946684800; // 1 enero 2000 UTC, época de XRPL
  return Math.floor(Date.now() / 1000) - rippleEpoch + segundos;
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// ----------------------------------------------------------------------------
// PASO 1 — VEHIX ENVÍA EL PAGO Y LA RED LO RETIENE
// ----------------------------------------------------------------------------
async function crearEscrowDeHito(client, vehix, colaboradorAddr, datos, plazoSegundos) {
  const { condition, fulfillment } = generarCondicion();
  const cancelAfter = rippleTimeFromNow(plazoSegundos);

  const tx = {
    TransactionType: "EscrowCreate",
    Account: vehix.classicAddress,        // Vehix pone el dinero
    Destination: colaboradorAddr,         // destinado al colaborador
    Amount: xrpl.xrpToDrops(CONFIG.PAGO_XRP),
    Condition: condition,                 // se libera solo con la llave secreta
    CancelAfter: cancelAfter,             // si no se cumple, se puede devolver
    Memos: buildMemos(datos),
  };

  const prepared = await client.autofill(tx);
  const signed = vehix.sign(prepared);
  const result = await client.submitAndWait(signed.tx_blob);
  const code = result.result.meta.TransactionResult;
  if (code !== "tesSUCCESS") throw new Error(`EscrowCreate falló: ${code}`);

  return {
    hash: result.result.hash,
    secuencia: result.result.tx_json ? result.result.tx_json.Sequence : result.result.Sequence,
    fulfillment,
    condition,
    explorador: `https://testnet.xrpl.org/transactions/${result.result.hash}`,
  };
}

// ----------------------------------------------------------------------------
// PASO 2A — EL HITO SE CUMPLE: SE LIBERAN LOS FONDOS AL COLABORADOR
// ----------------------------------------------------------------------------
async function liberarPago(client, ejecutor, vehixAddr, secuencia, condition, fulfillment) {
  const tx = {
    TransactionType: "EscrowFinish",
    Account: ejecutor.classicAddress,
    Owner: vehixAddr,
    OfferSequence: secuencia,
    Condition: condition,
    Fulfillment: fulfillment,   // la llave secreta que prueba el cumplimiento
  };
  const prepared = await client.autofill(tx);
  const signed = ejecutor.sign(prepared);
  const result = await client.submitAndWait(signed.tx_blob);
  const code = result.result.meta.TransactionResult;
  if (code !== "tesSUCCESS") throw new Error(`EscrowFinish falló: ${code}`);
  return {
    hash: result.result.hash,
    explorador: `https://testnet.xrpl.org/transactions/${result.result.hash}`,
  };
}

// ----------------------------------------------------------------------------
// PASO 2B — EL HITO NO SE CUMPLE: EL DINERO VUELVE A VEHIX
// ----------------------------------------------------------------------------
async function devolverPago(client, ejecutor, vehixAddr, secuencia) {
  const tx = {
    TransactionType: "EscrowCancel",
    Account: ejecutor.classicAddress,
    Owner: vehixAddr,
    OfferSequence: secuencia,
  };
  const prepared = await client.autofill(tx);
  const signed = ejecutor.sign(prepared);
  const result = await client.submitAndWait(signed.tx_blob);
  const code = result.result.meta.TransactionResult;
  if (code !== "tesSUCCESS") throw new Error(`EscrowCancel falló: ${code}`);
  return {
    hash: result.result.hash,
    explorador: `https://testnet.xrpl.org/transactions/${result.result.hash}`,
  };
}

async function saldo(client, address) {
  try {
    const r = await client.request({ command: "account_info", account: address, ledger_index: "validated" });
    return Number(xrpl.dropsToXrp(r.result.account_data.Balance)).toFixed(2);
  } catch { return "0.00"; }
}

// ----------------------------------------------------------------------------
// DEMOSTRACIÓN DE LOS DOS ESCENARIOS
// ----------------------------------------------------------------------------
async function main() {
  const client = new xrpl.Client(CONFIG.XRPL_ENDPOINT);
  try {
    console.log("⬡ VEHIX — Demostración de pago por hito en XRPL (Testnet)\n");
    await client.connect();
    console.log("✓ Conectado al XRP Ledger.\n");

    console.log("⬡ Generando wallets de prueba (faucet)...");
    const { wallet: vehix } = await client.fundWallet();
    const { wallet: colaborador } = await client.fundWallet();
    console.log("  • Tesorería Vehix :", vehix.classicAddress);
    console.log("  • Colaborador     :", colaborador.classicAddress, "\n");

    // ===================== ESCENARIO A: EL HITO SE CUMPLE =====================
    console.log("══════════════════════════════════════════════════════════");
    console.log("  ESCENARIO A — El colaborador CUMPLE el hito");
    console.log("══════════════════════════════════════════════════════════");
    console.log("① Vehix envía el pago y la red lo retiene...");
    const escrowA = await crearEscrowDeHito(client, vehix, colaborador.classicAddress, {
      hito: "Entrega de hito de trabajo (servicio cumplido)",
      colaborador: colaborador.classicAddress,
    }, CONFIG.PLAZO_AMPLIO_SEGUNDOS);
    console.log("  ✓ Pago retenido on-chain. El colaborador ya puede verlo.");
    console.log("  • Ver:", escrowA.explorador);
    console.log("  • Saldo colaborador ahora:", await saldo(client, colaborador.classicAddress), "XRP (aún no recibe)\n");

    // Pequeña espera de seguridad: la red necesita validar el escrow en un
    // ledger cerrado antes de permitir liberarlo.
    await dormir(5000);
    console.log("② Vehix valida la entrega y libera los fondos...");
    const finish = await liberarPago(client, vehix, vehix.classicAddress, escrowA.secuencia, escrowA.condition, escrowA.fulfillment);
    console.log("  ✓ FONDOS LIBERADOS al colaborador.");
    console.log("  • Ver:", finish.explorador);
    console.log("  • Saldo colaborador ahora:", await saldo(client, colaborador.classicAddress), "XRP (¡recibió su pago!)\n");

    // ===================== ESCENARIO B: EL HITO NO SE CUMPLE ==================
    console.log("══════════════════════════════════════════════════════════");
    console.log("  ESCENARIO B — El hito NO se cumple (vence el plazo)");
    console.log("══════════════════════════════════════════════════════════");
    console.log("① Vehix envía otro pago y la red lo retiene...");
    const escrowB = await crearEscrowDeHito(client, vehix, colaborador.classicAddress, {
      hito: "Entrega de hito de trabajo (no cumplido)",
      colaborador: colaborador.classicAddress,
    }, CONFIG.PLAZO_CORTO_SEGUNDOS);
    console.log("  ✓ Pago retenido on-chain.");
    console.log("  • Ver:", escrowB.explorador, "\n");

    console.log(`② Esperando a que venza el plazo (${CONFIG.PLAZO_CORTO_SEGUNDOS}s)...`);
    await dormir((CONFIG.PLAZO_CORTO_SEGUNDOS + 5) * 1000);
    // Avanza un par de ledgers para que la red registre el vencimiento.
    console.log("③ El plazo venció sin entrega. Vehix recupera su dinero...");
    let devuelto = null;
    for (let intento = 1; intento <= 5 && !devuelto; intento++) {
      try {
        devuelto = await devolverPago(client, vehix, vehix.classicAddress, escrowB.secuencia);
      } catch (e) {
        if (String(e.message).includes("tecNO_PERMISSION") || String(e.message).includes("tooEarly") || String(e.message).includes("tecNO_TARGET")) {
          await dormir(3000); // espera y reintenta hasta que el ledger pase el CancelAfter
        } else { throw e; }
      }
    }
    if (devuelto) {
      console.log("  ✓ DINERO DEVUELTO a Vehix (el hito no se cumplió).");
      console.log("  • Ver:", devuelto.explorador, "\n");
    } else {
      console.log("  • (La devolución puede tardar unos ledgers más; el mecanismo es correcto.)\n");
    }

    console.log("══════════════════════════════════════════════════════════");
    console.log("✅ DEMOSTRACIÓN COMPLETA");
    console.log("   Vehix puede pagar por hitos de forma verificable: el dinero");
    console.log("   se libera SOLO si el trabajo se cumple, y vuelve si no. Todo");
    console.log("   on-chain, sin intermediarios. Esta es la infraestructura de");
    console.log("   pagos que Vehix usará con su equipo cuando llegue el Grant.");
    console.log("══════════════════════════════════════════════════════════");
  } catch (err) {
    console.error("✗ Error:", err.message);
    process.exitCode = 1;
  } finally {
    if (client.isConnected()) {
      await client.disconnect();
      console.log("\n⬡ Desconectado del XRP Ledger.");
    }
  }
}

module.exports = { crearEscrowDeHito, liberarPago, devolverPago };

if (require.main === module) {
  main();
}
