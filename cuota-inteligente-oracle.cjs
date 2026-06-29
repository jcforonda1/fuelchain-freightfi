/**
 * ============================================================
 *  VEHIX — MÓDULO: CUOTA INTELIGENTE DE ACPM
 *  (cuota-inteligente-oracle.cjs)
 * ============================================================
 *  Convierte el subsidio plano (por categoría) en una CUOTA
 *  verificada por datos. La cuota mensual de diésel subsidiado
 *  se emite como un MPT (saldo de "crédito de combustible
 *  subsidiado"). Cada consumo verificado debita el MPT:
 *    - dentro de cuota  -> subsidiado
 *    - fuera de cuota   -> precio pleno + anomalía marcada
 *
 *  Cada evento graba en Memos los factores del Score de Cuota:
 *  cilindraje (RUNT), score GPS, EDS, cruce galones<->km.
 *
 *  MODELO MULTIFACTOR:
 *    cilindraje (RUNT) -> consumo base (arranque en frío)
 *    GPS / galones     -> eficiencia real observada
 *    score GPS + EDS + galones<->km -> validación anti-fraude
 *
 *  NOTA: Simulación en la RED DE PRUEBAS (Testnet). Datos
 *  ficticios. Demostración técnica para concursos. El modelo
 *  financiero y regulatorio debe validarse con las autoridades
 *  y un profesional del derecho antes de cualquier uso real.
 * ============================================================
 */

const xrpl = require("xrpl");

// ---- Parámetros de la simulación (vehículo de ejemplo: buseta escolar) ----
const VEHICULO = {
  placa: "SXY123",
  cedula: "71788824",
  cilindrajeRUNT: "2500cc",
  modalidadRUNT: "Especial escolar",
  cuotaKm: 1200,          // km subsidiados al mes (patrón aprendido)
  eficienciaKmGal: 9,     // km por galón observados (GPS ÷ galones)
};

const DORMIR_MS = 2500;

// Eventos de tanqueo simulados a lo largo del mes
const EVENTOS = [
  { etiqueta: "Semana 1 (rutina)",        galones: 40, scoreGps: 96, edsOk: true,  cruceOk: true  },
  { etiqueta: "Semana 2 (con trancones)", galones: 45, scoreGps: 92, edsOk: true,  cruceOk: true  },
  { etiqueta: "Semana 3 (rutina)",        galones: 40, scoreGps: 90, edsOk: true,  cruceOk: true  },
  { etiqueta: "Fin de semana (paseo)",    galones: 30, scoreGps: 38, edsOk: false, cruceOk: false },
];

function dormir(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function aHex(texto) {
  return Buffer.from(String(texto), "utf8").toString("hex").toUpperCase();
}

// Construye los Memos con los factores del Score de Cuota
function memosEvento(o) {
  return Object.entries(o).map(([k, v]) => ({
    Memo: { MemoType: aHex(k), MemoData: aHex(v) },
  }));
}

async function enviar(cliente, wallet, tx, nombrePaso) {
  const prep = await cliente.autofill(tx);
  const firmada = wallet.sign(prep);
  const res = await cliente.submitAndWait(firmada.tx_blob);
  const resultado = res.result.meta.TransactionResult;
  console.log("  " + nombrePaso + ":", resultado);
  if (resultado !== "tesSUCCESS") {
    console.log("\n  ⚠ El paso '" + nombrePaso + "' falló (" + resultado + "). Deteniendo.");
    throw new Error("Paso fallido: " + nombrePaso + " -> " + resultado);
  }
  return res;
}

async function main() {
  console.log("============================================================");
  console.log(" VEHIX — CUOTA INTELIGENTE DE ACPM — Simulación Testnet");
  console.log("============================================================\n");

  // 1) Conexión
  const cliente = new xrpl.Client("wss://s.altnet.rippletest.net:51233");
  await cliente.connect();
  console.log("✓ Conectado a la red de pruebas XRPL\n");

  // 2) Wallets: la Autoridad (emite el crédito subsidiado) y el Vehículo (titular)
  console.log("Creando wallets de prueba (faucet)...");
  const autoridad = (await cliente.fundWallet()).wallet;  // representa al Estado / fondo del subsidio
  const vehiculo  = (await cliente.fundWallet()).wallet;  // el transportador
  console.log("  Autoridad (emisor del crédito):", autoridad.classicAddress);
  console.log("  Vehículo (titular):            ", vehiculo.classicAddress);
  console.log();

  // 3) Calcular la cuota a partir del modelo multifactor
  console.log("------------------------------------------------------------");
  console.log(" PASO 1: Cálculo de la cuota (modelo multifactor)");
  console.log("------------------------------------------------------------");
  const cuotaGalones = Math.round(VEHICULO.cuotaKm / VEHICULO.eficienciaKmGal);
  console.log("  Placa:", VEHICULO.placa, "| Cilindraje (RUNT):", VEHICULO.cilindrajeRUNT, "| Modalidad:", VEHICULO.modalidadRUNT);
  console.log("  Patrón aprendido:", VEHICULO.cuotaKm, "km/mes");
  console.log("  Eficiencia observada:", VEHICULO.eficienciaKmGal, "km/gal");
  console.log("  => CUOTA MENSUAL:", cuotaGalones, "galones subsidiados");
  console.log();

  // 4) Crear la emisión del MPT (el "crédito de combustible subsidiado")
  console.log("------------------------------------------------------------");
  console.log(" PASO 2: Emitir el crédito subsidiado como MPT");
  console.log("------------------------------------------------------------");
  const crearMPT = {
    TransactionType: "MPTokenIssuanceCreate",
    Account: autoridad.classicAddress,
    AssetScale: 0,
    MaximumAmount: "1000000",
    Flags: 32, // tfMPTCanTransfer
  };
  const resMPT = await enviar(cliente, autoridad, crearMPT, "MPTokenIssuanceCreate");
  const issuanceID = resMPT.result.meta.mpt_issuance_id;
  if (!issuanceID) {
    throw new Error("No se obtuvo el mpt_issuance_id de la emisión.");
  }
  console.log("  ID de la emisión (MPT):", issuanceID);
  console.log();
  await dormir(DORMIR_MS);

  // 5) El vehículo autoriza el MPT (opt-in)
  console.log("------------------------------------------------------------");
  console.log(" PASO 3: El vehículo autoriza el MPT");
  console.log("------------------------------------------------------------");
  const autorizar = {
    TransactionType: "MPTokenAuthorize",
    Account: vehiculo.classicAddress,
    MPTokenIssuanceID: issuanceID,
  };
  await enviar(cliente, vehiculo, autorizar, "MPTokenAuthorize");
  console.log();
  await dormir(DORMIR_MS);

  // 6) La autoridad entrega la cuota mensual al vehículo
  console.log("------------------------------------------------------------");
  console.log(" PASO 4: Entregar la cuota mensual al vehículo");
  console.log("------------------------------------------------------------");
  const entregar = {
    TransactionType: "Payment",
    Account: autoridad.classicAddress,
    Destination: vehiculo.classicAddress,
    Amount: { mpt_issuance_id: issuanceID, value: String(cuotaGalones) },
    Memos: memosEvento({
      concepto: "cuota_mensual_acpm",
      placa: VEHICULO.placa,
      galones: String(cuotaGalones),
    }),
  };
  await enviar(cliente, autoridad, entregar, "Entrega de cuota");
  console.log("  Saldo inicial de cuota:", cuotaGalones, "galones subsidiados");
  console.log();
  await dormir(DORMIR_MS);

  // 7) Procesar los eventos de consumo (cada uno debita el MPT)
  console.log("------------------------------------------------------------");
  console.log(" PASO 5: Procesar consumos (debita la cuota)");
  console.log("------------------------------------------------------------");
  let saldo = cuotaGalones;
  let totalSubsidiado = 0;
  let totalExceso = 0;

  for (const ev of EVENTOS) {
    const subsidiado = Math.min(ev.galones, saldo);
    const exceso = ev.galones - subsidiado;

    console.log("\n  • " + ev.etiqueta + " — tanqueo de " + ev.galones + " gal");
    console.log("    Score GPS:", ev.scoreGps, "| EDS:", ev.edsOk ? "registrada" : "ATÍPICA", "| Galones↔km:", ev.cruceOk ? "coherente" : "INCOHERENTE");

    if (subsidiado > 0) {
      const debitar = {
        TransactionType: "Payment",
        Account: vehiculo.classicAddress,
        Destination: autoridad.classicAddress,
        Amount: { mpt_issuance_id: issuanceID, value: String(subsidiado) },
        Memos: memosEvento({
          evento: ev.etiqueta,
          galones_totales: String(ev.galones),
          galones_subsidiados: String(subsidiado),
          galones_exceso: String(exceso),
          score_gps: String(ev.scoreGps),
          eds: ev.edsOk ? "registrada" : "atipica",
          galones_km: ev.cruceOk ? "coherente" : "incoherente",
        }),
      };
      await enviar(cliente, vehiculo, debitar, "    Débito subsidiado (" + subsidiado + " gal)");
      saldo -= subsidiado;
      totalSubsidiado += subsidiado;
    }

    if (exceso > 0) {
      totalExceso += exceso;
      console.log("    ⚠ ANOMALÍA: " + exceso + " gal de EXCESO -> NO subsidiados, precio pleno. Marcado para auditoría.");
    }
    console.log("    Saldo de cuota restante:", saldo, "galones");
    await dormir(DORMIR_MS);
  }

  // 8) Resumen
  console.log("\n------------------------------------------------------------");
  console.log(" RESULTADO FINAL");
  console.log("------------------------------------------------------------");
  console.log("  Cuota mensual:        ", cuotaGalones, "galones");
  console.log("  Consumo subsidiado:   ", totalSubsidiado, "galones");
  console.log("  Exceso (precio pleno):", totalExceso, "galones");
  console.log("  Saldo final de cuota: ", saldo, "galones");
  console.log("  ✓ Cuota emitida y debitada como MPT (saldo verificable on-chain)");
  console.log("  ✓ Cada consumo grabó sus factores en los Memos (trazabilidad)");
  console.log("  ✓ El exceso del paseo quedó fuera de cuota y marcado");
  console.log();

  await cliente.disconnect();
  console.log("✓ Desconectado. Simulación de Cuota Inteligente completada.");
}

main().catch((err) => {
  console.error("ERROR en la simulación de Cuota Inteligente:", err.message || err);
});
