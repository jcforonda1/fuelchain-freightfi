// ─────────────────────────────────────────────────────────────────────────────
// VEHIX POINTS (VXP) — Módulo de Lealtad Tokenizada
//
// CONCEPTO:
//   VXP es la moneda de lealtad de Vehix — MPT fungible transferible.
//   Se gana por buen comportamiento (viajes, SOAT vigente, GPS preciso).
//   Se canjea por beneficios (descuentos SOAT, cobro diferido, asistencia).
//   Flags 0x0020 (tfMPTCanTransfer) habilita mercado secundario P2P.
//   Módulo importable por freightfi, soat-defi, acpm-oracle, cargo-bank.
// ─────────────────────────────────────────────────────────────────────────────

import {
  Client,
  encodeMPTokenMetadata,
  decodeAccountID,
} from "xrpl";

const TESTNET_URL = "wss://s.altnet.rippletest.net:51233";
const EXPLORER    = "https://testnet.xrpl.org/transactions";

// ── Configuración VXP ─────────────────────────────────────────────────────────

const VXP_SUPPLY         = 1_000_000_000;   // mil millones de VXP
const VXP_COBRA_AL_SALIR = 2_000;           // costo beneficio Platinum
const BURN_CAMION_MONTO  = 500;
const BENEFICIO_CAMION   = "10% descuento próximo SOAT";
const AHORRO_COP         = 38_000;
const P2P_MONTO          = 100;

// ── Plan EARN por conductor ───────────────────────────────────────────────────

const EARN_PLAN = [
  {
    walletKey : "wMoto",
    nombre    : "Maria Lopez Vargas",
    placa     : "ABC12D",
    tipo      : "Motocicleta 100-200cc",
    eventos   : [
      { accion: "viaje_completado", descripcion: "Viaje completado sin incidentes",  vxp: 100 },
      { accion: "soat_al_dia",      descripcion: "SOAT vigente y al día",            vxp:  50 },
      { accion: "gps_preciso",      descripcion: "GPS preciso — 0 desvíos de ruta",  vxp:  25 },
    ],
  },
  {
    walletKey : "wCamion",
    nombre    : "Carlos Rueda Mora",
    placa     : "SXZ842",
    tipo      : "Camión carga C6",
    eventos   : [
      { accion: "viaje_completado", descripcion: "Viaje completado sin incidentes",  vxp: 100 },
      { accion: "racha_10_viajes",  descripcion: "Racha 10 viajes sin siniestro",    vxp: 500 },
      { accion: "pila_al_dia",      descripcion: "PILA (aportes salud) al día",      vxp:  75 },
      { accion: "soat_al_dia",      descripcion: "SOAT vigente y al día",            vxp:  50 },
    ],
  },
  {
    walletKey : "wBus",
    nombre    : "Transporte Andino SAS",
    placa     : "WTR309",
    tipo      : "Bus escolar",
    eventos   : [
      { accion: "viaje_completado",    descripcion: "Viaje completado sin incidentes", vxp: 100 },
      { accion: "score_perfecto",      descripcion: "Score de conducción perfecto",     vxp:  75 },
      { accion: "cero_siniestros_ano", descripcion: "0 siniestros en el año",          vxp: 200 },
    ],
  },
];

// ── Catálogo de beneficios por nivel ─────────────────────────────────────────

const BENEFICIOS = {
  Bronze  : ["Asistencia en carretera 24h", "5% dto. gestión trámites RUNT"],
  Gold    : ["10% dto. próximo SOAT (~$38.000 COP)", "Acceso prioritario crédito Vehix"],
  Platinum: ["SOAT gratis (hasta $946.600 COP)", "Cobra-al-salir premium", "Seguro todo riesgo"],
};

function loyaltyLevel(vxp) {
  if (vxp >= 2_000) return "Platinum";
  if (vxp >=   500) return "Gold";
  return "Bronze";
}

// ── Console helpers ───────────────────────────────────────────────────────────

const W    = 72;
const hr   = (c = "─") => c.repeat(W);
const col  = (k, v) => console.log(`  ${String(k).padEnd(38)}: ${v}`);
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
      MemoType  : toHex(`vehix/points/${type}`),
      MemoFormat: toHex("application/json"),
      MemoData  : toHex(JSON.stringify(payload)),
    },
  }];
}

function computeMPTIssuanceID(issuerAddress, sequence) {
  const seqBuf     = Buffer.alloc(4);
  seqBuf.writeUInt32BE(sequence >>> 0, 0);
  const accountBuf = Buffer.from(decodeAccountID(issuerAddress));
  return Buffer.concat([seqBuf, accountBuf]).toString("hex").toUpperCase();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function runVehixPoints() {
  const client  = new Client(TESTNET_URL);
  const txLinks = [];

  const trackTx = (label, hash) => {
    txLinks.push({ label, url: `${EXPLORER}/${hash}` });
    console.log(`\n  🔗  ${EXPLORER}/${hash}`);
  };

  try {
    console.log("\n" + hr("═"));
    console.log("  VEHIX POINTS (VXP) — Lealtad Tokenizada  |  XRPL Testnet");
    console.log("  MPT fungible · tfMPTCanTransfer · EARN · BURN · P2P · Dashboard");
    console.log(hr("═") + "\n");

    await client.connect();
    console.log("  Conectado a XRPL Testnet.\n");

    // ─────────────────────────────────────────────────────────────────────
    // PASO 1 — Wallets (4 actores)
    // ─────────────────────────────────────────────────────────────────────
    paso(1, "Crear wallets — VehixPoints (emisor VXP) + 3 conductores");

    console.log("\n  [VEHIX POINTS]  solicitando faucet...");
    const { wallet: wVehixPoints } = await client.fundWallet();
    col("  wVehixPoints  (Emisor VXP — Vehix Loyalty Engine)", wVehixPoints.address);

    console.log("\n  [MOTO]          solicitando faucet...");
    const { wallet: wMoto } = await client.fundWallet();
    col("  wMoto         (Maria Lopez — Moto ABC12D)", wMoto.address);

    console.log("\n  [CAMION]        solicitando faucet...");
    const { wallet: wCamion } = await client.fundWallet();
    col("  wCamion       (Carlos Rueda — Camion SXZ842)", wCamion.address);

    console.log("\n  [BUS]           solicitando faucet...");
    const { wallet: wBus } = await client.fundWallet();
    col("  wBus          (Transporte Andino — Bus WTR309)", wBus.address);

    const wallets = { wMoto, wCamion, wBus };

    // ─────────────────────────────────────────────────────────────────────
    // PASO 2 — Emitir VXP (MPTokenIssuanceCreate) + opt-in conductores
    // ─────────────────────────────────────────────────────────────────────
    paso(2, "Emitir VehixPoints (VXP) — MPT fungible transferible");

    console.log(`
  Flags 0x0020 (tfMPTCanTransfer) — CRÍTICO para la lógica de puntos:
    Sin este flag  → solo el emisor puede mover VXP hacia/desde holders.
    Con 0x0020     → cualquier holder transfiere a otro holder (P2P).
  Esto habilita el mercado secundario de puntos demostrado en Paso 6.

  Suministro máximo : ${VXP_SUPPLY.toLocaleString()} VXP
  AssetScale        : 0  (unidades enteras — 1 VXP mínimo)
  Emisor            : VehixPoints (Vehix Loyalty Engine)
`);

    const mptCreateTx = await client.autofill({
      TransactionType: "MPTokenIssuanceCreate",
      Account        : wVehixPoints.address,
      AssetScale     : 0,
      MaximumAmount  : String(VXP_SUPPLY),
      Flags          : 0x0020,  // tfMPTCanTransfer — transferencias P2P entre holders
      MPTokenMetadata: encodeMPTokenMetadata({
        name       : "VehixPoints",
        ticker     : "VXP",
        asset_class: "loyalty",
        emisor     : "Vehix Loyalty Engine",
        descripcion: "Puntos de lealtad Vehix por buen comportamiento vial",
        max_supply : VXP_SUPPLY,
        niveles    : { Bronze: "0-499 VXP", Gold: "500-1999 VXP", Platinum: "2000+ VXP" },
        uso        : "descuentos SOAT, credito diferido, asistencia carretera",
      }),
      Memos: buildMemo("vxp-create", {
        tipo_evento: "VXP_ISSUANCE_CREATE",
        ticker     : "VXP",
        max_supply : VXP_SUPPLY,
        flags      : "0x0020 tfMPTCanTransfer",
        asset_class: "loyalty",
      }),
    });
    const mptSeq    = mptCreateTx.Sequence;
    const mptResult = await client.submitAndWait(wVehixPoints.sign(mptCreateTx).tx_blob);
    const mptID     = computeMPTIssuanceID(wVehixPoints.address, mptSeq);

    col("  TX MPTokenIssuanceCreate", ok(mptResult.result.meta.TransactionResult));
    col("  MPTokenIssuanceID (VXP)", mptID);
    col("  MaximumAmount", `${VXP_SUPPLY.toLocaleString()} VXP`);
    col("  tfMPTCanTransfer 0x0020", "Transferencias P2P HABILITADAS ✓");
    trackTx("MPTokenIssuanceCreate VehixPoints (VXP) — 1.000M suministro", mptResult.result.hash);

    // ── Opt-in: los 3 conductores hacen MPTokenAuthorize ─────────────────
    console.log("\n  Conductores hacen MPTokenAuthorize (opt-in para recibir VXP)...");

    for (const plan of EARN_PLAN) {
      const w = wallets[plan.walletKey];
      const authResult = await client.submitAndWait(
        w.sign(await client.autofill({
          TransactionType  : "MPTokenAuthorize",
          Account          : w.address,
          MPTokenIssuanceID: mptID,
        })).tx_blob
      );
      col(`  MPTokenAuthorize ${plan.walletKey} (${plan.placa})`, ok(authResult.result.meta.TransactionResult));
      trackTx(`MPTokenAuthorize VXP — ${plan.walletKey} ${plan.placa} (opt-in)`, authResult.result.hash);
    }

    // ─────────────────────────────────────────────────────────────────────
    // PASO 3 — EARN: acreditar VXP por comportamiento
    // ─────────────────────────────────────────────────────────────────────
    paso(3, "EARN — Acreditar VXP por comportamiento vial");

    console.log(`
  Cada evento = Payment MPT VehixPoints → Conductor.
  Memo: tipo_evento VXP_EARN, accion, vxp_ganados, saldo_nuevo.
`);

    const saldos    = { wMoto: 0, wCamion: 0, wBus: 0 };
    const vxpEarned = { wMoto: 0, wCamion: 0, wBus: 0 };

    for (const plan of EARN_PLAN) {
      const w = wallets[plan.walletKey];
      console.log(`\n  ── ${plan.nombre.padEnd(26)} | ${plan.placa} | ${plan.tipo} ──`);

      for (const evento of plan.eventos) {
        const saldoNuevo = saldos[plan.walletKey] + evento.vxp;

        const txEarn = await client.submitAndWait(
          wVehixPoints.sign(await client.autofill({
            TransactionType: "Payment",
            Account        : wVehixPoints.address,
            Destination    : w.address,
            Amount         : { mpt_issuance_id: mptID, value: String(evento.vxp) },
            Memos          : buildMemo("earn", {
              tipo_evento : "VXP_EARN",
              accion      : evento.accion,
              descripcion : evento.descripcion,
              vxp_ganados : evento.vxp,
              saldo_nuevo : saldoNuevo,
              conductor   : plan.nombre,
              placa       : plan.placa,
            }),
          })).tx_blob
        );

        saldos[plan.walletKey]    = saldoNuevo;
        vxpEarned[plan.walletKey] += evento.vxp;

        col(`  +${String(evento.vxp).padStart(3)} VXP  ${evento.accion.padEnd(26)}`, ok(txEarn.result.meta.TransactionResult));
        col(`    Saldo acumulado`, `${saldoNuevo} VXP`);
        trackTx(`VXP_EARN +${evento.vxp} VXP — ${plan.nombre} (${evento.accion})`, txEarn.result.hash);
      }

      const totalEarn = vxpEarned[plan.walletKey];
      col(`\n  Total EARN ${plan.walletKey}`, `${totalEarn} VXP — Nivel: ${loyaltyLevel(totalEarn)}`);
    }

    // ─────────────────────────────────────────────────────────────────────
    // PASO 4 — Niveles de lealtad
    // ─────────────────────────────────────────────────────────────────────
    paso(4, "Niveles de Lealtad — Bronze / Gold / Platinum");

    console.log(`
  Bronze   :     0 –   499 VXP  │  Asistencia carretera · 5% dto. trámites RUNT
  Gold     :   500 – 1.999 VXP  │  10% dto. SOAT · Crédito Vehix prioritario
  Platinum :  2.000+ VXP        │  SOAT gratis · Cobra-al-salir · Seguro todo riesgo
`);

    for (const plan of EARN_PLAN) {
      const saldo = saldos[plan.walletKey];
      const nivel = loyaltyLevel(saldo);
      col(`  ${plan.nombre.padEnd(26)} | ${String(saldo).padStart(4)} VXP`, `Nivel ${nivel}`);
      col(`    Beneficios activos`, BENEFICIOS[nivel].join(" · "));
    }

    // ─────────────────────────────────────────────────────────────────────
    // PASO 5 — BURN: canjear VXP por beneficios
    // ─────────────────────────────────────────────────────────────────────
    paso(5, "BURN — Canjear VXP por beneficios (transfer back al emisor)");

    console.log(`
  El conductor transfiere VXP de vuelta a VehixPoints (emisor) = quema.
  Memo: tipo_evento BURN, beneficio, vxp_gastados, saldo_restante.
`);

    const vxpBurned = { wMoto: 0, wCamion: 0, wBus: 0 };

    // ── Canje 1: wCamion — 500 VXP → "10% descuento próximo SOAT" ────────
    console.log("  ── Canje 1: wCamion — 500 VXP → 10% descuento próximo SOAT ─────────");

    col("  Conductor", "Carlos Rueda Mora (wCamion)");
    col("  VXP disponibles", `${saldos.wCamion} VXP  (nivel Gold)`);
    col("  VXP a canjear", `${BURN_CAMION_MONTO} VXP`);
    col("  Beneficio", `${BENEFICIO_CAMION} — ahorro $${AHORRO_COP.toLocaleString("es-CO")} COP`);

    const saldoCamionPostBurn = saldos.wCamion - BURN_CAMION_MONTO;

    const txBurnCamion = await client.submitAndWait(
      wCamion.sign(await client.autofill({
        TransactionType: "Payment",
        Account        : wCamion.address,
        Destination    : wVehixPoints.address,
        Amount         : { mpt_issuance_id: mptID, value: String(BURN_CAMION_MONTO) },
        Memos          : buildMemo("burn", {
          tipo_evento    : "VXP_BURN",
          beneficio      : BENEFICIO_CAMION,
          vxp_gastados   : BURN_CAMION_MONTO,
          saldo_restante : saldoCamionPostBurn,
          ahorro_cop     : AHORRO_COP,
          conductor      : "Carlos Rueda Mora",
          placa          : "SXZ842",
        }),
      })).tx_blob
    );

    saldos.wCamion      = saldoCamionPostBurn;
    vxpBurned.wCamion   = BURN_CAMION_MONTO;

    col("  TX VXP_BURN wCamion", ok(txBurnCamion.result.meta.TransactionResult));
    col("  Saldo restante wCamion", `${saldoCamionPostBurn} VXP → Nivel ${loyaltyLevel(saldoCamionPostBurn)}`);
    col("  Beneficio activado", `${BENEFICIO_CAMION} ✓`);
    col("  Ahorro en SOAT próximo", `$${AHORRO_COP.toLocaleString("es-CO")} COP`);
    trackTx(`VXP_BURN 500 VXP — Carlos Rueda (${BENEFICIO_CAMION} ahorro $38.000 COP)`, txBurnCamion.result.hash);

    // ── Canje 2: wMoto — intenta cobra-al-salir, necesita 2.000 VXP ──────
    console.log("\n  ── Canje 2: wMoto — intenta Cobra-al-Salir (requiere 2.000 VXP) ───");

    col("  Conductor", "Maria Lopez Vargas (wMoto)");
    col("  VXP disponibles", `${saldos.wMoto} VXP  (nivel ${loyaltyLevel(saldos.wMoto)})`);
    col("  Beneficio deseado", "Cobra-al-salir premium  (nivel Platinum)");
    col("  VXP necesarios", `${VXP_COBRA_AL_SALIR} VXP`);
    col("  Resultado",
      `${saldos.wMoto} < ${VXP_COBRA_AL_SALIR} — INSUFICIENTE ✗  (faltan ${VXP_COBRA_AL_SALIR - saldos.wMoto} VXP)`);

    console.log(`
  [INFO] wMoto no alcanza nivel Platinum.
         Saldo actual : ${saldos.wMoto} VXP
         Faltante     : ${VXP_COBRA_AL_SALIR - saldos.wMoto} VXP para Cobra-al-salir
         Canje NO ejecutado — saldo sin cambio.`);

    // ─────────────────────────────────────────────────────────────────────
    // PASO 6 — Transferencia P2P entre conductores
    // ─────────────────────────────────────────────────────────────────────
    paso(6, "P2P Transfer — wCamion → wMoto (mercado secundario)");

    console.log(`
  Diferenciador clave: Flags 0x0020 (tfMPTCanTransfer).
    Sin 0x0020  → solo el emisor puede mover VXP; holders no se transfieren entre sí.
    Con 0x0020  → cualquier holder transfiere a otro holder (P2P habilitado).
  Caso de uso: regalo entre conductores, pago de favores, ayuda mutual.
`);

    col("  Origen", `wCamion — Carlos Rueda Mora  (saldo: ${saldos.wCamion} VXP)`);
    col("  Destino", `wMoto   — Maria Lopez Vargas (saldo: ${saldos.wMoto} VXP)`);
    col("  Monto P2P", `${P2P_MONTO} VXP`);
    col("  Flag habilitante", "0x0020 tfMPTCanTransfer ✓");

    const saldoCamionPostP2P = saldos.wCamion - P2P_MONTO;
    const saldoMotoPostP2P   = saldos.wMoto   + P2P_MONTO;

    const txP2P = await client.submitAndWait(
      wCamion.sign(await client.autofill({
        TransactionType: "Payment",
        Account        : wCamion.address,
        Destination    : wMoto.address,
        Amount         : { mpt_issuance_id: mptID, value: String(P2P_MONTO) },
        Memos          : buildMemo("p2p-transfer", {
          tipo_evento: "P2P_TRANSFER",
          de         : "wCamion — Carlos Rueda Mora",
          para       : "wMoto — Maria Lopez Vargas",
          monto      : P2P_MONTO,
          concepto   : "Regalo entre conductores",
          flag_usado : "0x0020 tfMPTCanTransfer",
        }),
      })).tx_blob
    );

    saldos.wCamion = saldoCamionPostP2P;
    saldos.wMoto   = saldoMotoPostP2P;

    col("  TX P2P_TRANSFER", ok(txP2P.result.meta.TransactionResult));
    col("  Saldo wCamion post-P2P", `${saldoCamionPostP2P} VXP → Nivel ${loyaltyLevel(saldoCamionPostP2P)}`);
    col("  Saldo wMoto   post-P2P", `${saldoMotoPostP2P} VXP → Nivel ${loyaltyLevel(saldoMotoPostP2P)}`);
    trackTx(`P2P_TRANSFER 100 VXP wCamion→wMoto (Regalo — tfMPTCanTransfer demostrado)`, txP2P.result.hash);

    // ─────────────────────────────────────────────────────────────────────
    // PASO 7 — Dashboard VXP
    // ─────────────────────────────────────────────────────────────────────
    paso(7, "Dashboard VXP — Estado final de conductores");

    const dashData = EARN_PLAN.map((plan) => {
      const saldo = saldos[plan.walletKey];
      const nivel = loyaltyLevel(saldo);
      return {
        nombre  : plan.nombre,
        placa   : plan.placa,
        earned  : vxpEarned[plan.walletKey],
        burned  : vxpBurned[plan.walletKey],
        saldo,
        nivel,
        benefits: BENEFICIOS[nivel],
      };
    });

    const totalEarned = Object.values(vxpEarned).reduce((a, b) => a + b, 0);
    const totalBurned = Object.values(vxpBurned).reduce((a, b) => a + b, 0);
    const totalSaldo  = Object.values(saldos).reduce((a, b) => a + b, 0);

    const TW = 102;
    const sep = "  " + "─".repeat(TW);
    console.log();
    console.log(sep);
    console.log(
      `  ${"Conductor".padEnd(26)}` +
      `${"Placa".padEnd(9)}` +
      `${"VXP Ganados".padStart(12)}` +
      `${"VXP Gastados".padStart(13)}` +
      `${"Saldo".padStart(8)}` +
      `  ${"Nivel".padEnd(10)}` +
      `  Beneficios disponibles`
    );
    console.log(sep);

    for (const d of dashData) {
      const prefix =
        `  ${d.nombre.padEnd(26)}` +
        `${d.placa.padEnd(9)}` +
        `${String(d.earned).padStart(12)}` +
        `${String(d.burned).padStart(13)}` +
        `${String(d.saldo).padStart(8)}` +
        `  ${d.nivel.padEnd(10)}` +
        `  `;

      console.log(prefix + d.benefits[0]);
      for (let i = 1; i < d.benefits.length; i++) {
        console.log(" ".repeat(prefix.length) + d.benefits[i]);
      }
    }

    console.log(sep);
    console.log(
      `  ${"TOTAL".padEnd(35)}` +
      `${String(totalEarned).padStart(12)}` +
      `${String(totalBurned).padStart(13)}` +
      `${String(totalSaldo).padStart(8)}`
    );
    console.log(sep);

    console.log(`
  ┌────────────────────────────────────────────────────────────────────────┐
  │  VEHIX POINTS (VXP) — Resumen de operaciones                          │
  ├───────────────────────────────────────┬────────────────────────────────┤
  │  Suministro máximo VXP               │  ${String(VXP_SUPPLY.toLocaleString()).padEnd(30)}  │
  │  VXP emitidos (EARN total)           │  ${String(totalEarned + " VXP").padEnd(30)}  │
  │  VXP quemados (BURN)                 │  ${String(totalBurned + " VXP  (10% dto. SOAT Carlos)").padEnd(30)}  │
  │  VXP en circulación                  │  ${String(totalSaldo + " VXP  (3 conductores)").padEnd(30)}  │
  │  P2P transferidos                    │  ${String(P2P_MONTO + " VXP  wCamion → wMoto").padEnd(30)}  │
  ├───────────────────────────────────────┼────────────────────────────────┤
  │  EARN eventos ejecutados             │  ${String(EARN_PLAN.reduce((a, p) => a + p.eventos.length, 0)).padEnd(30)}  │
  │  BURN canjes ejecutados              │  ${String("1  (1 bloqueado por saldo insuf.)").padEnd(30)}  │
  │  P2P transfers                       │  ${String("1  (tfMPTCanTransfer demostrado)").padEnd(30)}  │
  │  Transacciones on-chain total        │  ${String(txLinks.length).padEnd(30)}  │
  ├───────────────────────────────────────┼────────────────────────────────┤
  │  Flag diferenciador                  │  0x0020 tfMPTCanTransfer        │
  │  Protocolo                           │  XRPL MPTokenIssuanceCreate     │
  │  Red                                 │  XRPL Testnet                   │
  └───────────────────────────────────────┴────────────────────────────────┘`);

    // ─────────────────────────────────────────────────────────────────────
    // PASO 8 — Links XRPL Testnet Explorer
    // ─────────────────────────────────────────────────────────────────────
    paso(8, "Links directos — XRPL Testnet Explorer");
    console.log();
    txLinks.forEach((t, i) => {
      console.log(`  [${String(i + 1).padStart(2)}] ${t.label}`);
      console.log(`       ${t.url}`);
    });

    console.log();
    console.log(hr("═"));
    console.log("  VEHIX POINTS (VXP) — Completado exitosamente");
    console.log(hr("═") + "\n");

  } finally {
    await client.disconnect();
    console.log("  Desconectado del nodo XRPL.\n");
  }
}

runVehixPoints().catch((err) => {
  console.error("Error:", err.message ?? err);
  process.exit(1);
});
