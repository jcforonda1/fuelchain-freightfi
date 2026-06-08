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

const GRANT_TOTAL_XRP = 100;

const MILESTONES = [
  { id: "M1", pct:  7.5, days:  30, criteria: "Constitución legal FuelChain SAS + NIT DIAN" },
  { id: "M2", pct:  7.5, days:  60, criteria: "PoC XRPL Testnet — 5 transacciones en vivo" },
  { id: "M3", pct:  7.5, days:  90, criteria: "Piloto 3 empresas transportadoras Bogotá" },
  { id: "M4", pct:  7.5, days: 120, criteria: "Integración API DIAN facturación electrónica" },
  { id: "M5", pct: 17.5, days: 180, criteria: "100 conductores activos en plataforma" },
  { id: "M6", pct: 17.5, days: 240, criteria: "Volumen $500M COP en factoring RADIAN" },
  { id: "M7", pct: 17.5, days: 300, criteria: "Expansión Perú + Ecuador — alianzas firmadas" },
  { id: "M8", pct: 17.5, days: 365, criteria: "Rentabilidad operativa + 500 conductores" },
];

// ── Console helpers ───────────────────────────────────────────────────────────

const W    = 68;
const hr   = (c = "─") => c.repeat(W);
const col  = (k, v) => console.log(`  ${String(k).padEnd(34)}: ${v}`);
const step = (n, title) => {
  console.log("\n" + hr());
  console.log(`  PASO ${n} — ${title}`);
  console.log(hr());
};
const ok      = (r) => r === "tesSUCCESS" ? r + " ✓" : r + " ✗";
const toHex   = (s) => Buffer.from(s, "utf8").toString("hex").toUpperCase();

function buildMemo(type, payload) {
  return [{
    Memo: {
      MemoType  : toHex(`freightfi/${type}`),
      MemoFormat: toHex("application/json"),
      MemoData  : toHex(JSON.stringify(payload)),
    },
  }];
}

// ── PREIMAGE-SHA-256 Crypto Condition (RFC draft-thomas-crypto-conditions) ────
// Preimage: 32 random bytes  →  cost = 32 = 0x20
// Condition:   A025 8020 {fingerprint 32B} 8101 20
// Fulfillment: A022 8020 {preimage 32B}

function makeCondition() {
  const preimage    = crypto.randomBytes(32);
  const fingerprint = crypto.createHash("sha256").update(preimage).digest("hex").toUpperCase();
  const condition   = `A0258020${fingerprint}810120`;
  const fulfillment = `A0228020${preimage.toString("hex").toUpperCase()}`;
  return { condition, fulfillment };
}

// ── Multisig helper — devuelve { result, seq } ────────────────────────────────

async function msSubmit(client, tx, ...signers) {
  const prepared = await client.autofill(tx);
  prepared.SigningPubKey = "";
  // Usar la fee base que autofill calculó según la carga actual del nodo,
  // multiplicada por (N_signers + 1) según el protocolo XRPL multisig.
  const base = parseInt(prepared.Fee ?? "12");
  prepared.Fee = String(base * (signers.length + 1));
  const blobs = signers.map((w) => w.sign(prepared, true).tx_blob);
  const result = await client.submitAndWait(multisign(blobs));
  return { result, seq: prepared.Sequence };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function runGovEscrow() {
  const client = new Client(TESTNET_URL);

  try {
    console.log("\n" + hr("═"));
    console.log("  FREIGHTFI — GovEscrow  |  Grant Milestones 2-de-3 XRPL Testnet");
    console.log(hr("═") + "\n");

    await client.connect();
    console.log("  Conectado a XRPL Testnet.\n");

    // ── PASO 1: Wallets ───────────────────────────────────────────────────
    step(1, "Crear wallets  (CEO · Observer · Arbiter · Grant Wallet)");

    console.log("\n  [CEO]       solicitando faucet...");
    const { wallet: wCEO      } = await client.fundWallet();
    col("  wCEO       (CEO FuelChain)", wCEO.address);

    console.log("\n  [OBSERVER]  solicitando faucet...");
    const { wallet: wObserver } = await client.fundWallet();
    col("  wObserver  (Ripple Observer)", wObserver.address);

    console.log("\n  [ARBITER]   solicitando faucet...");
    const { wallet: wArbiter  } = await client.fundWallet();
    col("  wArbiter   (Independent Arbiter)", wArbiter.address);

    console.log("\n  [GRANT]     solicitando faucet (×2 para cubrir 100 XRP + reservas)...");
    const { wallet: wGrant } = await client.fundWallet();
    await client.fundWallet(wGrant); // segunda recarga: cubre 100 XRP escrow + 28 XRP reserves
    col("  wGrant     (Grant Master Wallet)", wGrant.address);

    // ── PASO 2: SignerListSet ─────────────────────────────────────────────
    step(2, "SignerListSet en wGrant — quórum 2-de-3, weight 1 c/u");

    const slResult = await client.submitAndWait(
      wGrant.sign(
        await client.autofill({
          TransactionType: "SignerListSet",
          Account        : wGrant.address,
          SignerQuorum   : 2,
          SignerEntries  : [
            { SignerEntry: { Account: wCEO.address,      SignerWeight: 1 } },
            { SignerEntry: { Account: wObserver.address, SignerWeight: 1 } },
            { SignerEntry: { Account: wArbiter.address,  SignerWeight: 1 } },
          ],
        })
      ).tx_blob
    );

    console.log();
    col("  Hash SignerListSet", slResult.result.hash);
    col("  Estado", ok(slResult.result.meta.TransactionResult));
    col("  Firmantes", "CEO(1) · Observer(1) · Arbiter(1)  |  quórum = 2");
    console.log(`\n  🔗  ${EXPLORER}/${slResult.result.hash}`);

    // ── PASO 3: AccountSet asfDisableMaster ───────────────────────────────
    step(3, "AccountSet — deshabilitar master key (solo multi-sig puede mover fondos)");

    const disableResult = await client.submitAndWait(
      wGrant.sign(
        await client.autofill({
          TransactionType: "AccountSet",
          Account        : wGrant.address,
          SetFlag        : 4, // asfDisableMaster
        })
      ).tx_blob
    );

    console.log();
    col("  Hash AccountSet", disableResult.result.hash);
    col("  Estado", ok(disableResult.result.meta.TransactionResult));
    col("  SetFlag", "4 = asfDisableMaster");
    col("  Master key", "DESHABILITADA — solo 2-de-3 multisig a partir de ahora");
    console.log(`\n  🔗  ${EXPLORER}/${disableResult.result.hash}`);

    // ── PASO 4: Generar condiciones PREIMAGE-SHA-256 ──────────────────────
    step(4, "Generar condiciones PREIMAGE-SHA-256 únicas por milestone");

    const milestoneData = MILESTONES.map((m) => ({
      ...m,
      xrp: m.pct,
      ...makeCondition(),
    }));

    console.log();
    milestoneData.forEach((m) => {
      col(`  ${m.id} (${m.pct}% · ${m.xrp} XRP · día ${m.days})`,
        m.condition.slice(0, 20) + "…");
    });

    // ── PASO 5: EscrowCreate × 8 desde wGrant (multisig CEO + Observer) ──
    step(5, "EscrowCreate × 8 — multisig CEO + Observer · Condition única por hito");

    const escrows = [];

    for (const m of milestoneData) {
      // M3: CancelAfter corto (60s desde ahora) para poder demostrar EscrowCancel en esta sesión.
      // Representa el deadline real del día 90 del grant.
      const cancelMs = m.id === "M3"
        ? Date.now() + 60_000
        : Date.now() + m.days * 86_400_000;

      const { result, seq } = await msSubmit(client, {
        TransactionType: "EscrowCreate",
        Account        : wGrant.address,
        Amount         : xrpToDrops(m.xrp.toString()),
        Destination    : wGrant.address,
        CancelAfter    : unixTimeToRippleTime(cancelMs),
        Condition      : m.condition,
        Memos          : buildMemo("govescrow-create", {
          grant_id    : "FuelChain-Ripple-2026",
          milestone_id: m.id,
          porcentaje  : `${m.pct}%`,
          monto_xrp   : m.xrp,
          criteria    : m.criteria,
          deadline_dia: m.id === "M3" ? "90 (demo=60s)" : m.days,
        }),
      }, wCEO, wObserver);

      const txResult = result.result.meta.TransactionResult;
      if (txResult !== "tesSUCCESS") {
        throw new Error(`EscrowCreate ${m.id} falló: ${txResult}`);
      }

      escrows.push({
        ...m,
        hash_create: result.result.hash,
        seq,
        status     : "ACTIVO",
        cancelMs,
      });

      col(`  ${m.id} EscrowCreate`, ok(txResult));
    }

    console.log(`\n  8 escrows creados — ${GRANT_TOTAL_XRP} XRP bloqueados en Grant Wallet.`);

    // ── PASO 6: EscrowFinish M1 — CEO + Observer ──────────────────────────
    step(6, "EscrowFinish M1 — oráculo verifica criterio · CEO + Observer firman");

    const m1 = escrows.find((e) => e.id === "M1");

    const { result: r1 } = await msSubmit(client, {
      TransactionType: "EscrowFinish",
      Account        : wGrant.address,
      Owner          : wGrant.address,
      OfferSequence  : m1.seq,
      Condition      : m1.condition,
      Fulfillment    : m1.fulfillment,
      Memos          : buildMemo("govescrow-finish", {
        milestone_id  : "M1",
        criteria      : m1.criteria,
        oracle_verdict: "APROBADO",
        signers       : ["CEO", "Observer"],
        timestamp     : new Date().toISOString(),
      }),
    }, wCEO, wObserver);

    m1.hash_finish = r1.result.hash;
    m1.status = "LIBERADO";

    console.log();
    col("  Hash EscrowFinish M1", r1.result.hash);
    col("  Estado", ok(r1.result.meta.TransactionResult));
    col("  Fondos liberados", `${m1.xrp} XRP → Grant Wallet`);
    col("  Signers", "CEO + Observer  (quórum 2-de-3 ✓)");
    console.log(`\n  🔗  ${EXPLORER}/${r1.result.hash}`);

    // ── PASO 7: EscrowFinish M2 — CEO + Observer ──────────────────────────
    step(7, "EscrowFinish M2 — oráculo verifica criterio · CEO + Observer firman");

    const m2 = escrows.find((e) => e.id === "M2");

    const { result: r2 } = await msSubmit(client, {
      TransactionType: "EscrowFinish",
      Account        : wGrant.address,
      Owner          : wGrant.address,
      OfferSequence  : m2.seq,
      Condition      : m2.condition,
      Fulfillment    : m2.fulfillment,
      Memos          : buildMemo("govescrow-finish", {
        milestone_id  : "M2",
        criteria      : m2.criteria,
        oracle_verdict: "APROBADO",
        signers       : ["CEO", "Observer"],
        timestamp     : new Date().toISOString(),
      }),
    }, wCEO, wObserver);

    m2.hash_finish = r2.result.hash;
    m2.status = "LIBERADO";

    console.log();
    col("  Hash EscrowFinish M2", r2.result.hash);
    col("  Estado", ok(r2.result.meta.TransactionResult));
    col("  Fondos liberados", `${m2.xrp} XRP → Grant Wallet`);
    col("  Signers", "CEO + Observer  (quórum 2-de-3 ✓)");
    console.log(`\n  🔗  ${EXPLORER}/${r2.result.hash}`);

    // ── PASO 8: Esperar expiración de M3 CancelAfter ──────────────────────
    step(8, "Simulación M3 — milestone no cumplido · esperando CancelAfter");

    const m3 = escrows.find((e) => e.id === "M3");
    const waitMs = Math.max(0, m3.cancelMs - Date.now()) + 4_000;

    col("  Deadline M3", "día 90 del grant  (demo = 60s desde creación)");
    col("  Esperando", `${Math.ceil(waitMs / 1000)}s hasta que CancelAfter pase…`);
    await new Promise((r) => setTimeout(r, waitMs));
    console.log("  CancelAfter expirado. Procediendo con EscrowCancel.");

    // ── PASO 9: EscrowCancel M3 ───────────────────────────────────────────
    step(9, "EscrowCancel M3 — criterio no cumplido · fondos regresan a Grant Wallet");

    // Una vez que CancelAfter expira, cualquier cuenta puede enviar EscrowCancel.
    // Usamos wCEO como submitter (master key) — el Owner sigue siendo wGrant.
    const cancelResult = await client.submitAndWait(
      wCEO.sign(
        await client.autofill({
          TransactionType: "EscrowCancel",
          Account        : wCEO.address,
          Owner          : wGrant.address,
          OfferSequence  : m3.seq,
          Memos          : buildMemo("govescrow-cancel", {
            milestone_id: "M3",
            criteria    : m3.criteria,
            razon       : "Criterio no cumplido en deadline día 90",
            accion      : "EscrowCancel — fondos regresan a Grant Wallet",
            timestamp   : new Date().toISOString(),
          }),
        })
      ).tx_blob
    );

    m3.hash_cancel = cancelResult.result.hash;
    m3.status = "CANCELADO";

    console.log();
    col("  Hash EscrowCancel M3", cancelResult.result.hash);
    col("  Estado", ok(cancelResult.result.meta.TransactionResult));
    col("  Fondos devueltos", `${m3.xrp} XRP → Grant Wallet`);
    col("  Razón", "Criterio no cumplido en plazo día 90");
    console.log(`\n  🔗  ${EXPLORER}/${cancelResult.result.hash}`);

    // ── PASO 10: Dashboard ────────────────────────────────────────────────
    step(10, "Dashboard — estado de todos los milestones del grant");

    const released  = escrows.filter((e) => e.status === "LIBERADO");
    const cancelled = escrows.filter((e) => e.status === "CANCELADO");
    const active    = escrows.filter((e) => e.status === "ACTIVO");
    const sumXrp    = (arr) => arr.reduce((s, e) => s + e.xrp, 0);

    const statusIcon = { LIBERADO: "OK ", CANCELADO: "XX ", ACTIVO: "..." };

    console.log(`
  ┌──────┬───────────┬──────────────────────────────────────┬──────────┐
  │  ID  │  Estado   │  Criterio                            │   XRP    │
  ├──────┼───────────┼──────────────────────────────────────┼──────────┤`);

    for (const e of escrows) {
      const icon   = statusIcon[e.status] ?? "   ";
      const estado = `[${icon}] ${e.status}`.slice(0, 9).padEnd(9);
      const crit   = e.criteria.slice(0, 38).padEnd(38);
      const xrpStr = `${e.xrp} XRP`.padStart(8);
      console.log(`  │  ${e.id}  │ ${estado} │ ${crit} │ ${xrpStr} │`);
    }

    console.log(`  ├──────┴───────────┴──────────────────────────────────────┴──────────┤
  │  [OK ] Liberados  : ${String(released.length).padEnd(1)} milestone(s)  ·  ${String(sumXrp(released)).padEnd(5)} XRP                    │
  │  [XX ] Cancelados : ${String(cancelled.length).padEnd(1)} milestone(s)  ·  ${String(sumXrp(cancelled)).padEnd(5)} XRP                    │
  │  [...] Activos    : ${String(active.length).padEnd(1)} milestone(s)  ·  ${String(sumXrp(active)).padEnd(5)} XRP (bloqueados)       │
  │  Governance : 2-de-3 multisig (CEO · Observer · Arbiter)         │
  │  Protocolo  : PREIMAGE-SHA-256 Condition por escrow              │
  │  Grant      : FuelChain-Ripple-2026  |  Total: ${GRANT_TOTAL_XRP} XRP            │
  └──────────────────────────────────────────────────────────────────┘`);

    // ── PASO 11: Links ────────────────────────────────────────────────────
    step(11, "Links directos — XRPL Testnet Explorer");

    console.log(`
  [Governance setup]
  SignerListSet  :  ${EXPLORER}/${slResult.result.hash}
  DisableMaster  :  ${EXPLORER}/${disableResult.result.hash}
`);

    for (const e of escrows) {
      console.log(`  [${e.id}] EscrowCreate  :  ${EXPLORER}/${e.hash_create}`);
      if (e.hash_finish) console.log(`  [${e.id}] EscrowFinish :  ${EXPLORER}/${e.hash_finish}`);
      if (e.hash_cancel) console.log(`  [${e.id}] EscrowCancel :  ${EXPLORER}/${e.hash_cancel}`);
    }

    console.log();
    console.log(hr("═"));
    console.log("  FREIGHTFI GOVESCROW — Completado exitosamente");
    console.log(hr("═") + "\n");

  } finally {
    await client.disconnect();
    console.log("  Desconectado del nodo XRPL.\n");
  }
}

runGovEscrow().catch((err) => {
  console.error("Error:", err.message ?? err);
  process.exit(1);
});
