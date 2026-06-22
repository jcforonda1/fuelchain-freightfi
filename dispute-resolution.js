import {
  Client,
  xrpToDrops,
  unixTimeToRippleTime,
  multisign,
} from "xrpl";
import crypto from "crypto";

const TESTNET_URL = "wss://s.altnet.rippletest.net:51233";
const EXPLORER    = "https://testnet.xrpl.org/transactions";

// ── Parámetros de la disputa ──────────────────────────────────────────────────

const DISPUTE = {
  id               : "DISP-BOG-VVC-2026-0003",
  freight_xrp      : "10",
  arb_fee_xrp      : "0.1",   // 0.1 XRP por árbitro ganador
  total_escrow_xrp : "10.2",  // freight + 2 × arb_fee
  // Contexto COP (narrativo)
  freight_cop      : 3_500_000,
  total_tariff_cop :   348_000,
  buffer_cop       :    69_600,  // 20 % de 348.000
  delta_cop        :   180_000,  // cobro real > buffer → ARBITRATION_FLAG
};

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
const fmt_cop = (n) => `$${n.toLocaleString("es-CO")} COP`;

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

// ── Documento oficial Policía de Tránsito ─────────────────────────────────────

function simulateOfficialDocument(disputeId) {
  const doc = {
    tipo         : "ACTO_ADMINISTRATIVO",
    entidad      : "Policía de Tránsito — Cundinamarca",
    numero       : "PA-2026-04-0892",
    fecha        : new Date().toISOString().split("T")[0],
    asunto       : "Cierre vía Bogotá-Villavicencio km 82 — Sector Pipiral",
    causa        : "Derrumbe por lluvias · tarifa diferencial aplicada por desvío",
    cobro_adicional_cop: DISPUTE.delta_cop,
    justificacion: "Desvío temporal Variante Chirajara km 52-84, control especial",
    funcionario  : "Subintendente Carlos Ruiz — Placa COL-2847",
    dispute_ref  : disputeId,
  };
  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify(doc))
    .digest("hex");
  return { doc, hash };
}

// ── Multisig helpers ──────────────────────────────────────────────────────────

// Firma la tx con N árbitros y devuelve el blob combinado (sin enviar)
async function msSign(client, tx, ...signers) {
  const prepared         = await client.autofill(tx);
  prepared.SigningPubKey = "";
  prepared.Fee           = String((signers.length + 1) * 12); // (N+1)×12 drops
  const blobs            = signers.map(w => w.sign(prepared, true).tx_blob);
  return { combined: multisign(blobs), prepared };
}

// Firma y envía al ledger
async function msSubmit(client, tx, ...signers) {
  const { combined } = await msSign(client, tx, ...signers);
  return client.submitAndWait(combined);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function runDisputeResolution() {
  const client = new Client(TESTNET_URL);

  try {
    console.log("\n" + hr("═"));
    console.log("  FREIGHTFI — Dispute Resolution  |  Arbitraje 2-de-3 en XRPL Testnet");
    console.log(hr("═") + "\n");

    await client.connect();
    console.log("  Conectado a XRPL Testnet.\n");

    // ── PASO 1: Wallets ───────────────────────────────────────────────────
    step(1, "Crear wallets  (empresa · camión · disputa · Árbitro1 · Árbitro2 · Árbitro3)");

    console.log("\n  [EMPRESA]   solicitando faucet...");
    const { wallet: wEmpresa } = await client.fundWallet();
    col("  wEmpresa   (generadora de carga)", wEmpresa.address);

    console.log("\n  [CAMION]    solicitando faucet...");
    const { wallet: wCamion  } = await client.fundWallet();
    col("  wCamion    (propietario camión)", wCamion.address);

    console.log("\n  [DISPUTE]   solicitando faucet...");
    const { wallet: wDispute } = await client.fundWallet();
    col("  wDispute   (escrow de disputa)", wDispute.address);

    console.log("\n  [ARBITRO 1] solicitando faucet...");
    const { wallet: wArb1    } = await client.fundWallet();
    col("  wArbitro1", wArb1.address);

    console.log("\n  [ARBITRO 2] solicitando faucet...");
    const { wallet: wArb2    } = await client.fundWallet();
    col("  wArbitro2", wArb2.address);

    console.log("\n  [ARBITRO 3] solicitando faucet...");
    const { wallet: wArb3    } = await client.fundWallet();
    col("  wArbitro3", wArb3.address);

    // ── PASO 2: ARBITRATION_FLAG ──────────────────────────────────────────
    step(2, "ARBITRATION_FLAG — delta supera el buffer del 20 %");

    console.log();
    col("  Flete en disputa", `${DISPUTE.freight_xrp} XRP  (${fmt_cop(DISPUTE.freight_cop)})`);
    col("  Total peajes proyectado", fmt_cop(DISPUTE.total_tariff_cop));
    col("  Buffer máximo 20 %", fmt_cop(DISPUTE.buffer_cop));
    col("  Delta real detectado", `+${fmt_cop(DISPUTE.delta_cop)}  ⚠️`);
    col("  Exceso sobre buffer", `+${fmt_cop(DISPUTE.delta_cop - DISPUTE.buffer_cop)}`);
    console.log(`
  ${"!".repeat(W)}
  ⚠️  ARBITRATION_FLAG
  Delta ${fmt_cop(DISPUTE.delta_cop)} supera buffer ${fmt_cop(DISPUTE.buffer_cop)}.
  Fondos → Dispute Escrow controlado por panel de 3 árbitros.
  ${"!".repeat(W)}`);

    // ── PASO 3: SignerListSet + desactivar master key en wDispute ─────────
    step(3, "SignerListSet  +  AccountSet disableMaster  →  wDispute");

    const slResult = await client.submitAndWait(
      wDispute.sign(
        await client.autofill({
          TransactionType: "SignerListSet",
          Account        : wDispute.address,
          SignerQuorum   : 2,
          SignerEntries  : [
            { SignerEntry: { Account: wArb1.address, SignerWeight: 1 } },
            { SignerEntry: { Account: wArb2.address, SignerWeight: 1 } },
            { SignerEntry: { Account: wArb3.address, SignerWeight: 1 } },
          ],
        })
      ).tx_blob
    );

    console.log();
    col("  Hash SignerListSet", slResult.result.hash);
    col("  Estado", ok(slResult.result.meta.TransactionResult));
    col("  SignerQuorum", "2  (2-de-3 árbitros)");
    col("  Árbitro1 / Árbitro2 / Árbitro3", "weight 1 cada uno");
    console.log(`\n  🔗  ${EXPLORER}/${slResult.result.hash}`);

    // Desactivar master key — solo árbitros pueden mover fondos desde wDispute
    const dmResult = await client.submitAndWait(
      wDispute.sign(
        await client.autofill({
          TransactionType: "AccountSet",
          Account        : wDispute.address,
          SetFlag        : 4,   // asfDisableMaster
        })
      ).tx_blob
    );

    console.log();
    col("  Hash AccountSet (disableMaster)", dmResult.result.hash);
    col("  Estado", ok(dmResult.result.meta.TransactionResult));
    col("  Efecto", "Master key DESACTIVADA en wDispute");
    col("  Única autorización válida", "2-de-3 árbitros vía SignerList");
    console.log(`\n  🔗  ${EXPLORER}/${dmResult.result.hash}`);

    // ── PASO 4: EscrowCreate — Dispute Escrow ─────────────────────────────
    step(4, `EscrowCreate — Dispute Escrow  (${DISPUTE.total_escrow_xrp} XRP)`);

    const cancelAtMS    = Date.now() + 48 * 3_600_000;
    const finishAfterMs = Date.now() + 30_000;
    const { doc, hash: docHash } = simulateOfficialDocument(DISPUTE.id);

    const prepCreate   = await client.autofill({
      TransactionType: "EscrowCreate",
      Account        : wEmpresa.address,
      Amount         : xrpToDrops(DISPUTE.total_escrow_xrp),
      Destination    : wDispute.address,
      FinishAfter    : unixTimeToRippleTime(finishAfterMs),
      CancelAfter    : unixTimeToRippleTime(cancelAtMS),
      Memos          : buildMemo("dispute-escrow-create", {
        dispute_id     : DISPUTE.id,
        trigger_reason : "DELTA_EXCEEDS_BUFFER_20PCT",
        document_hash  : docHash,
        resolution_path: null,
        timestamp      : new Date().toISOString(),
      }),
    });
    const escrowSeq    = prepCreate.Sequence;
    const createResult = await client.submitAndWait(wEmpresa.sign(prepCreate).tx_blob);

    console.log();
    col("  dispute_id", DISPUTE.id);
    col("  trigger_reason", "DELTA_EXCEEDS_BUFFER_20PCT");
    col("  document_hash (parcial)", docHash.slice(0, 20) + "…");
    col("  Hash EscrowCreate", createResult.result.hash);
    col("  Estado", ok(createResult.result.meta.TransactionResult));
    col("  Monto bloqueado", `${DISPUTE.total_escrow_xrp} XRP`);
    col("  Destino (wDispute)", wDispute.address.slice(0, 14) + "…");
    col("  OfferSequence", escrowSeq);
    console.log(`\n  🔗  ${EXPLORER}/${createResult.result.hash}`);

    const waitMs = Math.max(0, finishAfterMs - Date.now()) + 4_000;
    col("\n  Esperando FinishAfter", `${Math.ceil(waitMs / 1000)} s…`);
    await new Promise(r => setTimeout(r, waitMs));

    // ── PASO 5: Oracle valida documento oficial ───────────────────────────
    step(5, "Oracle valida documento oficial  (Policía de Tránsito)");

    const reHash  = crypto.createHash("sha256").update(JSON.stringify(doc)).digest("hex");
    const docOK   = reHash === docHash;

    console.log();
    col("  Entidad", doc.entidad);
    col("  N.° acto", doc.numero);
    col("  Fecha", doc.fecha);
    col("  Asunto", doc.asunto);
    col("  Cobro adicional justificado", fmt_cop(doc.cobro_adicional_cop));
    col("  document_hash (parcial)", docHash.slice(0, 20) + "…");
    col("  Verificación", docOK
      ? "HASH VÁLIDO ✓ — acto auténtico"
      : "HASH INVÁLIDO ✗ — documento rechazado");
    console.log(`\n  Oracle: cobro extra justificado → resolución a favor del camionero.`);

    // ── PASO 6: PATH A — EscrowFinish multisig ────────────────────────────
    step(6, "PATH A — EscrowFinish multisig  (Árbitro1 + Árbitro2)");

    console.log(`
  Árbitro1 (${wArb1.address.slice(0, 16)}…)  →  VOTA A FAVOR del camionero  ✓
  Árbitro2 (${wArb2.address.slice(0, 16)}…)  →  VOTA A FAVOR del camionero  ✓
  Árbitro3 (${wArb3.address.slice(0, 16)}…)  →  VOTA EN CONTRA              ✗  (→ Path B)

  Suma pesos FAVOR  = 2  ≥  SignerQuorum 2  →  QUÓRUM ALCANZADO`);

    const finishResult = await msSubmit(
      client,
      {
        TransactionType: "EscrowFinish",
        Account        : wDispute.address,
        Owner          : wEmpresa.address,
        OfferSequence  : escrowSeq,
        Memos          : buildMemo("dispute-escrow-finish", {
          dispute_id     : DISPUTE.id,
          trigger_reason : "DELTA_EXCEEDS_BUFFER_20PCT",
          document_hash  : docHash,
          resolution_path: "PATH_A_AUTO_RESOLUTION",
          timestamp      : new Date().toISOString(),
          arbiters_favor : [wArb1.address, wArb2.address],
          arbiter_against: [wArb3.address],
          resolution     : "IN_FAVOR_OF_CAMION",
        }),
      },
      wArb1, wArb2,
    );

    console.log();
    col("  Hash EscrowFinish", finishResult.result.hash);
    col("  Estado", ok(finishResult.result.meta.TransactionResult));
    col("  Ledger #", finishResult.result.ledger_index);
    col("  Fondos liberados a wDispute", `${DISPUTE.total_escrow_xrp} XRP`);
    console.log(`\n  🔗  ${EXPLORER}/${finishResult.result.hash}`);

    // ── PASO 7: Distribución desde wDispute (multisig Árb1 + Árb2) ───────
    step(7, "Distribución  —  wDispute paga  (multisig Árb1 + Árb2)");

    // helper: pago desde wDispute autorizado por Arb1 + Arb2
    const dPay = (dest, xrp, memoType, memoData) =>
      msSubmit(client, {
        TransactionType: "Payment",
        Account        : wDispute.address,
        Destination    : dest.address,
        Amount         : xrpToDrops(xrp),
        Memos          : buildMemo(memoType, memoData),
      }, wArb1, wArb2);

    const payCamion = await dPay(wCamion, DISPUTE.freight_xrp, "dispute-pay-camion", {
      dispute_id : DISPUTE.id,
      concept    : "FLETE_RESOLUCION_ARBITRAL",
      resolution : "IN_FAVOR_OF_CAMION",
    });

    const payArb1 = await dPay(wArb1, DISPUTE.arb_fee_xrp, "dispute-fee-arbitro", {
      dispute_id : DISPUTE.id,
      concept    : "FEE_ARBITRO_GANADOR",
      arbitro    : "Árbitro1",
    });

    const payArb2 = await dPay(wArb2, DISPUTE.arb_fee_xrp, "dispute-fee-arbitro", {
      dispute_id : DISPUTE.id,
      concept    : "FEE_ARBITRO_GANADOR",
      arbitro    : "Árbitro2",
    });

    console.log();
    col("  [1] Flete → camionero", `${DISPUTE.freight_xrp} XRP`);
    col("    Hash", payCamion.result.hash);
    col("    Estado", ok(payCamion.result.meta.TransactionResult));
    console.log(`    🔗  ${EXPLORER}/${payCamion.result.hash}\n`);

    col("  [2] Fee → Árbitro1  (ganador)", `${DISPUTE.arb_fee_xrp} XRP`);
    col("    Hash", payArb1.result.hash);
    col("    Estado", ok(payArb1.result.meta.TransactionResult));
    console.log(`    🔗  ${EXPLORER}/${payArb1.result.hash}\n`);

    col("  [3] Fee → Árbitro2  (ganador)", `${DISPUTE.arb_fee_xrp} XRP`);
    col("    Hash", payArb2.result.hash);
    col("    Estado", ok(payArb2.result.meta.TransactionResult));
    console.log(`    🔗  ${EXPLORER}/${payArb2.result.hash}\n`);

    col("  [4] Fee Árbitro3", "— NO ENVIADO (voto disidente, ver Path B)");

    // ── PASO 8: PATH B — Simulación de desacuerdo (solo consola) ─────────
    step(8, "PATH B — Simulación: Árbitro3 vota diferente  (sin tx on-chain)");

    // Construir la tx alternativa que Arb3 intentaría firmar (NO se envía)
    const { combined: altBlob } = await msSign(
      client,
      {
        TransactionType: "EscrowFinish",
        Account        : wDispute.address,
        Owner          : wEmpresa.address,
        OfferSequence  : escrowSeq,
        Memos          : buildMemo("dispute-escrow-alt", {
          dispute_id     : DISPUTE.id,
          resolution_path: "PATH_B_DISSENT",
          resolution     : "IN_FAVOR_OF_EMPRESA",
          signed_by      : ["Árbitro3"],
        }),
      },
      wArb3,   // solo Árbitro3 firma — 1 de 3
    );

    console.log(`
  Árbitro3 propone resolución IN_FAVOR_OF_EMPRESA y firma su versión:

  ▸ altFinishTx.SigningPubKey = ""   (multisig mode)
  ▸ Árbitro3.authorizeMultisign()  → ${altBlob.slice(0, 22)}…
  ▸ Signers en tx alt            → [Árbitro3]
  ▸ Suma de pesos CONTRA         = 1
  ▸ SignerQuorum requerido        = 2
  ▸ 1 < 2  →  QUÓRUM NO ALCANZADO — ledger rechaza tx de Árbitro3

  Tabla de votos:
  ┌──────────────┬──────────────┬────────┬──────────────────────┐
  │  Árbitro     │  Voto        │  Peso  │  Resolución propuesta │
  ├──────────────┼──────────────┼────────┼──────────────────────┤
  │  Árbitro1    │  FAVOR   ✓  │   1    │  IN_FAVOR_OF_CAMION   │
  │  Árbitro2    │  FAVOR   ✓  │   1    │  IN_FAVOR_OF_CAMION   │
  │  Árbitro3    │  CONTRA  ✗  │   1    │  IN_FAVOR_OF_EMPRESA  │
  ├──────────────┼──────────────┼────────┼──────────────────────┤
  │  FAVOR       │              │   2    │  ≥ quórum 2  → GANA  │
  │  CONTRA      │              │   1    │  < quórum 2  → PIERDE│
  └──────────────┴──────────────┴────────┴──────────────────────┘

  PATH A ejecutado en cadena.  PATH B descartado por quórum insuficiente.
  Árbitro3 no recibe fee (${DISPUTE.arb_fee_xrp} XRP retenido) por voto disidente.`);

    // ── PASO 9: Verificar memo EscrowFinish on-chain ──────────────────────
    step(9, "Memo EscrowFinish on-chain verificado");

    const { result: txFin } = await client.request({
      command: "tx", transaction: finishResult.result.hash,
    });
    const raw = txFin.Memos?.[0]?.Memo;
    if (raw) {
      console.log();
      console.log(
        JSON.stringify(JSON.parse(fromHex(raw.MemoData)), null, 2)
          .split("\n").map(l => "    " + l).join("\n")
      );
    }

    // ── PASO 10: Resumen de links ─────────────────────────────────────────
    step(10, "Links directos — XRPL Testnet Explorer");

    console.log(`
  [1] SignerListSet      (árbitros 2-de-3 en wDispute):
      ${EXPLORER}/${slResult.result.hash}

  [2] AccountSet         (master key desactivada en wDispute):
      ${EXPLORER}/${dmResult.result.hash}

  [3] EscrowCreate       (dispute escrow ${DISPUTE.total_escrow_xrp} XRP):
      ${EXPLORER}/${createResult.result.hash}

  [4] EscrowFinish       (PATH A — Árb1 + Árb2 multisig):
      ${EXPLORER}/${finishResult.result.hash}

  [5] Pago camionero     (${DISPUTE.freight_xrp} XRP — flete):
      ${EXPLORER}/${payCamion.result.hash}

  [6] Fee Árbitro1       (${DISPUTE.arb_fee_xrp} XRP — ganador):
      ${EXPLORER}/${payArb1.result.hash}

  [7] Fee Árbitro2       (${DISPUTE.arb_fee_xrp} XRP — ganador):
      ${EXPLORER}/${payArb2.result.hash}
`);

    console.log(hr("═"));
    console.log("  FREIGHTFI DISPUTE RESOLUTION — Completado exitosamente");
    console.log(hr("═") + "\n");

  } finally {
    await client.disconnect();
    console.log("  Desconectado del nodo XRPL.\n");
  }
}

runDisputeResolution().catch((err) => {
  console.error("Error:", err.message ?? err);
  process.exit(1);
});
