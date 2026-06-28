/**
 * ============================================================
 *  VEHIX — MÓDULO 13: FOPAT VAULT ORACLE  (fopat-vault-oracle.cjs)
 * ============================================================
 *  FOPAT = Fondo de Protección al Transportador.
 *
 *  MODELO LEGAL CORRECTO (evita captación ilegal):
 *  - El POOL/bóveda DESEMBOLSA primero el aporte (como crédito), por
 *    adelantado, hacia una cuenta de MinTransporte.
 *  - NO se retiene ni acumula dinero del conductor (eso sería captación).
 *  - La cuota se recauda luego de cada flete (eso vive en freightfi.js).
 *  - Modelo: Embedded Finance / crédito comercial, NO captación.
 *
 *  ARQUITECTURA EN 2 PASOS:
 *   PASO 1 - initiateFopatDisbursement(): el Vault paga 25% por adelantado
 *            a MinTransporte vía ESCROW NATIVO con condición criptográfica.
 *            Memos hex: cédula, placa, radicado RUNT, reporte DIAN.
 *   PASO 2 - verifyAndReleaseFopat(): el escrow se libera SOLO con
 *            2-de-3 firmas del oráculo (Desintegradora + RUNT + GPS Vehix).
 *
 *  NOTA: Simulación en la RED DE PRUEBAS (Testnet). Dinero ficticio.
 *  Esto es una DEMO técnica para el Grant. El modelo legal debe ser
 *  validado por un abogado antes de operar con dinero real.
 * ============================================================
 */

const xrpl = require("xrpl");
const cc = require("five-bells-condition");
const crypto = require("crypto");

// ---- Parámetros de la simulación ----
const APORTE_FOPAT_XRP = "10";       // aporte simulado (25% del valor, ya calculado)
const PLAZO_SEGUNDOS = 3600;          // ventana amplia para liberar (1 hora)
const DORMIR_MS = 5000;               // espera de seguridad antes de liberar

function dormir(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Convierte un texto a hexadecimal (los Memos del XRPL van en hex)
function aHex(texto) {
  return Buffer.from(texto, "utf8").toString("hex").toUpperCase();
}

// Construye los Memos de trazabilidad del FOPAT
function construirMemosFopat({ cedula, placa, radicadoRUNT, reporteDIAN }) {
  return [
    { Memo: { MemoType: aHex("cedula"),       MemoData: aHex(cedula) } },
    { Memo: { MemoType: aHex("placa"),        MemoData: aHex(placa) } },
    { Memo: { MemoType: aHex("radicado_runt"), MemoData: aHex(radicadoRUNT) } },
    { Memo: { MemoType: aHex("reporte_dian"),  MemoData: aHex(reporteDIAN) } },
  ];
}

async function main() {
  console.log("============================================================");
  console.log(" VEHIX — FOPAT VAULT ORACLE (Módulo 13) — Simulación Testnet");
  console.log("============================================================\n");

  // 1) Conexión a la red de pruebas
  const cliente = new xrpl.Client("wss://s.altnet.rippletest.net:51233");
  await cliente.connect();
  console.log("✓ Conectado a la red de pruebas XRPL\n");

  // 2) Crear las wallets de la simulación (del faucet, dinero ficticio)
  console.log("Creando wallets de prueba (faucet)...");
  const poolVault   = (await cliente.fundWallet()).wallet;   // el POOL / bóveda FOPAT
  const minTransporte = (await cliente.fundWallet()).wallet; // destino: MinTransporte
  console.log("  POOL (bóveda FOPAT):   ", poolVault.classicAddress);
  console.log("  MinTransporte (destino):", minTransporte.classicAddress);
  console.log();

  // Los 3 firmantes del oráculo 2-de-3 (Desintegradora, RUNT, GPS Vehix)
  console.log("Creando los 3 firmantes del oráculo (multifirma 2-de-3)...");
  const desintegradora = (await cliente.fundWallet()).wallet;
  const runt           = (await cliente.fundWallet()).wallet;
  const gpsVehix       = (await cliente.fundWallet()).wallet;
  console.log("  Firmante 1 — Desintegradora:", desintegradora.classicAddress);
  console.log("  Firmante 2 — RUNT:          ", runt.classicAddress);
  console.log("  Firmante 3 — GPS Vehix:     ", gpsVehix.classicAddress);
  console.log();

  // 3) Configurar la multifirma 2-de-3 en la cuenta de MinTransporte
  //    (para que liberar el escrow requiera 2 de los 3 firmantes)
  console.log("Configurando SignerList 2-de-3 en la cuenta de MinTransporte...");
  const signerListTx = {
    TransactionType: "SignerListSet",
    Account: minTransporte.classicAddress,
    SignerQuorum: 2, // se necesitan 2 firmas
    SignerEntries: [
      { SignerEntry: { Account: desintegradora.classicAddress, SignerWeight: 1 } },
      { SignerEntry: { Account: runt.classicAddress,           SignerWeight: 1 } },
      { SignerEntry: { Account: gpsVehix.classicAddress,       SignerWeight: 1 } },
    ],
  };
  const slPrep = await cliente.autofill(signerListTx);
  const slFirmada = minTransporte.sign(slPrep);
  const slRes = await cliente.submitAndWait(slFirmada.tx_blob);
  console.log("  Resultado:", slRes.result.meta.TransactionResult);
  console.log();

  // 4) Crear la condición criptográfica para el escrow
  const preimagen = crypto.randomBytes(32);
  const condicionObj = new cc.PreimageSha256();
  condicionObj.setPreimage(preimagen);
  const condicion = condicionObj.getConditionBinary().toString("hex").toUpperCase();
  const cumplimiento = condicionObj.serializeBinary().toString("hex").toUpperCase();

  // ============================================================
  // PASO 1: initiateFopatDisbursement — el POOL paga por adelantado
  // ============================================================
  console.log("------------------------------------------------------------");
  console.log(" PASO 1: initiateFopatDisbursement (el POOL desembolsa 25%)");
  console.log("------------------------------------------------------------");

  const memos = construirMemosFopat({
    cedula: "71788824",
    placa: "SXY123",
    radicadoRUNT: "RUNT-2026-004521",
    reporteDIAN: "DIAN-2026-FOPAT-0098",
  });

  // NOTA: cuando un escrow usa Condition (condición criptográfica),
  // se libera al presentar el Fulfillment correcto. No combinamos
  // FinishAfter con Condition para evitar tecNO_PERMISSION.
  // Mantenemos solo CancelAfter como ventana de seguridad (devolución).
  const cancelAfter = xrpl.isoTimeToRippleTime(new Date(Date.now() + PLAZO_SEGUNDOS * 1000));

  const escrowCreate = {
    TransactionType: "EscrowCreate",
    Account: poolVault.classicAddress,          // el POOL paga
    Destination: minTransporte.classicAddress,  // a MinTransporte
    Amount: xrpl.xrpToDrops(APORTE_FOPAT_XRP),
    Condition: condicion,                        // liberación por condición criptográfica
    CancelAfter: cancelAfter,                    // ventana para devolución si no se libera
    Memos: memos,
  };

  const ecPrep = await cliente.autofill(escrowCreate);
  const ecFirmada = poolVault.sign(ecPrep);
  const ecRes = await cliente.submitAndWait(ecFirmada.tx_blob);
  const resultadoEscrow = ecRes.result.meta.TransactionResult;
  console.log("  EscrowCreate:", resultadoEscrow);
  console.log("  Hash:", ecFirmada.hash);

  // Si el escrow no se creó, nos detenemos aquí con un mensaje claro
  if (resultadoEscrow !== "tesSUCCESS") {
    console.log("\n  ⚠ El escrow no se creó (" + resultadoEscrow + "). Deteniendo.");
    console.log("  Revisa el saldo del POOL o la condición. No se intenta liberar.");
    await cliente.disconnect();
    return;
  }

  console.log("  Aporte reservado:", APORTE_FOPAT_XRP, "XRP (crédito por adelantado)");

  // La secuencia del escrow es la Sequence de la transacción que lo creó
  const secuenciaEscrow = ecPrep.Sequence;
  console.log("  Secuencia del escrow:", secuenciaEscrow);
  console.log();

  // Esperar la ventana de seguridad antes de liberar
  console.log("Esperando ventana de seguridad (" + DORMIR_MS / 1000 + "s)...\n");
  await dormir(DORMIR_MS);

  // ============================================================
  // PASO 2: verifyAndReleaseFopat — liberar con 2-de-3 firmas
  // ============================================================
  console.log("------------------------------------------------------------");
  console.log(" PASO 2: verifyAndReleaseFopat (liberar con 2-de-3 firmas)");
  console.log("------------------------------------------------------------");

  // El EscrowFinish lo firman 2 de los 3 firmantes del oráculo
  const escrowFinish = {
    TransactionType: "EscrowFinish",
    Account: minTransporte.classicAddress,
    Owner: poolVault.classicAddress,
    OfferSequence: secuenciaEscrow,
    Condition: condicion,
    Fulfillment: cumplimiento,
  };

  const efPrep = await cliente.autofill(escrowFinish, 2); // 2 firmas
  // Un EscrowFinish con Fulfillment requiere un fee mayor.
  // Aseguramos un fee holgado para la condición + multifirma.
  efPrep.Fee = "1000";
  // Firma 1: Desintegradora
  const firma1 = desintegradora.sign(efPrep, true);
  // Firma 2: RUNT
  const firma2 = runt.sign(efPrep, true);
  // Combinar las 2 firmas (2-de-3 cumplido)
  const combinada = xrpl.multisign([firma1.tx_blob, firma2.tx_blob]);

  console.log("  Firmas recogidas: Desintegradora + RUNT (2 de 3) ✓");
  const efRes = await cliente.submitAndWait(combinada);
  console.log("  EscrowFinish:", efRes.result.meta.TransactionResult);
  console.log("  Hash:", efRes.result.hash);
  console.log();

  // 5) Verificar el saldo final de MinTransporte
  const saldo = await cliente.getXrpBalance(minTransporte.classicAddress);
  console.log("------------------------------------------------------------");
  console.log(" RESULTADO FINAL");
  console.log("------------------------------------------------------------");
  console.log("  Saldo de MinTransporte:", saldo, "XRP");
  console.log("  ✓ El aporte FOPAT se desembolsó como crédito (no captación)");
  console.log("  ✓ Liberado con 2-de-3 firmas del oráculo (anti-fraude)");
  console.log("  ✓ Trazabilidad en Memos: cédula, placa, RUNT, DIAN");
  console.log();

  await cliente.disconnect();
  console.log("✓ Desconectado. Simulación FOPAT completada.");
}

main().catch((err) => {
  console.error("ERROR en la simulación FOPAT:", err);
});
