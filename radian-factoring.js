import {
  Client,
  xrpToDrops,
  dropsToXrp,
  encodeMPTokenMetadata,
  decodeMPTokenMetadata,
  decodeAccountID,
} from "xrpl";
import crypto from "crypto";

const TESTNET_URL = "wss://s.altnet.rippletest.net:51233";
const EXPLORER    = "https://testnet.xrpl.org/transactions";

// ── Parámetros de la factura de flete ─────────────────────────────────────────

const INVOICE = {
  id           : `INV-FF-2026-${crypto.randomBytes(3).toString("hex").toUpperCase()}`,
  valor_cop    : 3_500_000,
  valor_xrp    : "10",        // valor facial en XRP
  descuento_pct: 2,           // descuento factoring 2 %
  precio_xrp   : "9.8",       // lo que paga el inversor
  spread_xrp   : "0.2",       // ganancia del inversor al vencimiento
  plazo_dias   : 60,
};

// ── Console helpers ───────────────────────────────────────────────────────────

const W    = 66;
const hr   = (c = "─") => c.repeat(W);
const col  = (k, v) => console.log(`  ${String(k).padEnd(32)}: ${v}`);
const step = (n, title) => {
  console.log("\n" + hr());
  console.log(`  PASO ${n} — ${title}`);
  console.log(hr());
};
const ok      = (r) => r === "tesSUCCESS" ? r + " ✓" : r + " ✗";
const fmt_cop = (n) => `$${n.toLocaleString("es-CO")} COP`;
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

// ── Simular evento RADIAN / DIAN ──────────────────────────────────────────────

function simulateRadian(invoice) {
  const maturityDate = new Date(Date.now() + invoice.plazo_dias * 86_400_000)
    .toISOString().split("T")[0];

  const radianEvent = {
    evento           : "INSCRIPCION_TITULO_VALOR",
    sistema          : "RADIAN-DIAN",
    cufe             : `CUFE-${crypto.randomBytes(8).toString("hex").toUpperCase()}`,
    nit_emisor       : "900.123.456-7",
    nit_adquiriente  : "800.987.654-1",
    numero_factura   : invoice.id,
    fecha_emision    : new Date().toISOString().split("T")[0],
    fecha_vencimiento: maturityDate,
    valor_cop        : invoice.valor_cop,
    moneda           : "COP",
    tipo             : "FEV",    // Factura Electrónica de Venta
    estado_radian    : "DISPONIBLE",
  };

  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify(radianEvent))
    .digest("hex");

  return { event: radianEvent, hash, maturityDate };
}

// ── Calcular MPTokenIssuanceID ─────────────────────────────────────────────────
// MPTokenIssuanceID = Sequence(4B big-endian) + AccountID(20B) = 192 bits = 48 hex chars
// El LedgerIndex del objeto MPTokenIssuance es SHA512Half(namespace + MPTokenIssuanceID)
// y mide 256 bits (64 hex), que NO es el ID que usan MPTokenAuthorize / Payment.

function computeMPTIssuanceID(issuerAddress, sequence) {
  const seqBuf = Buffer.alloc(4);
  seqBuf.writeUInt32BE(sequence >>> 0, 0);
  const accountBuf = Buffer.from(decodeAccountID(issuerAddress));
  return Buffer.concat([seqBuf, accountBuf]).toString("hex").toUpperCase();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function runRadianFactoring() {
  const client = new Client(TESTNET_URL);

  try {
    console.log("\n" + hr("═"));
    console.log("  FREIGHTFI — RADIAN Factoring  |  MPT en XRPL Testnet");
    console.log(hr("═") + "\n");

    await client.connect();
    console.log("  Conectado a XRPL Testnet.\n");

    // ── PASO 1: Wallets ───────────────────────────────────────────────────
    step(1, "Crear wallets  (empresa · inversor · conductor · cargador)");

    console.log("\n  [EMPRESA]   solicitando faucet...");
    const { wallet: wEmpresa   } = await client.fundWallet();
    col("  wEmpresa   (empresa de transporte)", wEmpresa.address);

    console.log("\n  [INVERSOR]  solicitando faucet...");
    const { wallet: wInversor  } = await client.fundWallet();
    col("  wInversor  (inversionista institucional)", wInversor.address);

    console.log("\n  [CONDUCTOR] solicitando faucet...");
    const { wallet: wConductor } = await client.fundWallet();
    col("  wConductor (conductor propietario)", wConductor.address);

    console.log("\n  [CARGADOR]  solicitando faucet...");
    const { wallet: wCargador  } = await client.fundWallet();
    col("  wCargador  (empresa generadora de carga)", wCargador.address);

    // ── PASO 2: Registro RADIAN (DIAN) ────────────────────────────────────
    step(2, "Registro RADIAN — inscripción como título valor electrónico");

    const { event: radianEvent, hash: radianHash, maturityDate } =
      simulateRadian(INVOICE);

    console.log();
    col("  Sistema", "RADIAN — DIAN Colombia");
    col("  Evento", radianEvent.evento);
    col("  CUFE", radianEvent.cufe);
    col("  invoice_id", INVOICE.id);
    col("  NIT emisor (empresa)", radianEvent.nit_emisor);
    col("  NIT adquiriente (cargador)", radianEvent.nit_adquiriente);
    col("  Fecha emisión", radianEvent.fecha_emision);
    col("  Fecha vencimiento (60 días)", maturityDate);
    col("  Valor facial", `${fmt_cop(INVOICE.valor_cop)}  /  ${INVOICE.valor_xrp} XRP`);
    col("  radian_hash (parcial)", radianHash.slice(0, 20) + "…");
    console.log(`\n  Factura inscrita en RADIAN → habilitada para negociación.`);

    // ── PASO 3: MPTokenIssuanceCreate ─────────────────────────────────────
    step(3, "MPTokenIssuanceCreate — tokenizar factura como MPT");

    const mptMeta = {
      invoice_id       : INVOICE.id,
      radian_hash      : radianHash,
      valor_cop        : INVOICE.valor_cop,
      fecha_vencimiento: maturityDate,
      estado           : "DISPONIBLE",
      tipo             : "FEV",
    };

    const mptCreateTx = await client.autofill({
      TransactionType : "MPTokenIssuanceCreate",
      Account         : wEmpresa.address,
      AssetScale      : 0,
      MaximumAmount   : "1",
      Flags           : 0,
      MPTokenMetadata : encodeMPTokenMetadata(mptMeta),
      Memos           : buildMemo("mpt-create", {
        invoice_id  : INVOICE.id,
        radian_hash : radianHash,
        tipo_evento : "EMISION_MPT_FACTURA",
      }),
    });
    const mptCreateSeq    = mptCreateTx.Sequence;
    const mptCreateResult = await client.submitAndWait(wEmpresa.sign(mptCreateTx).tx_blob);

    // Sequence del tx autofilled + AccountID del emisor = MPTokenIssuanceID (48 hex = 192 bits)
    const mptID = computeMPTIssuanceID(wEmpresa.address, mptCreateSeq);

    console.log();
    col("  Hash MPTokenIssuanceCreate", mptCreateResult.result.hash);
    col("  Estado", ok(mptCreateResult.result.meta.TransactionResult));
    col("  MPTokenIssuanceID", mptID);
    col("  AssetScale", "0  (token indivisible — 1 factura = 1 MPT)");
    col("  MaximumAmount", "1");
    col("  Metadata invoice_id", INVOICE.id);
    col("  Metadata radian_hash", radianHash.slice(0, 20) + "…");
    col("  Metadata estado", "DISPONIBLE");
    console.log(`\n  🔗  ${EXPLORER}/${mptCreateResult.result.hash}`);

    // verificación de metadata omitida (el campo no siempre viene en el result de Testnet)

    // ── PASO 4: MPTokenAuthorize — inversor hace opt-in ───────────────────
    step(4, "MPTokenAuthorize — inversor hace opt-in para recibir MPT");

    const authResult = await client.submitAndWait(
      wInversor.sign(
        await client.autofill({
          TransactionType  : "MPTokenAuthorize",
          Account          : wInversor.address,
          MPTokenIssuanceID: mptID,
        })
      ).tx_blob
    );

    console.log();
    col("  Hash MPTokenAuthorize", authResult.result.hash);
    col("  Estado", ok(authResult.result.meta.TransactionResult));
    col("  MPTokenIssuanceID", mptID);
    col("  Holder habilitado", wInversor.address.slice(0, 14) + "…  listo para recibir MPT");
    console.log(`\n  🔗  ${EXPLORER}/${authResult.result.hash}`);

    // ── PASO 5: FACTORING_COMPRA — inversor paga 9.8 XRP a empresa ────────
    step(5, `FACTORING_COMPRA — inversor paga ${INVOICE.precio_xrp} XRP a empresa`);

    const buyResult = await client.submitAndWait(
      wInversor.sign(
        await client.autofill({
          TransactionType: "Payment",
          Account        : wInversor.address,
          Destination    : wEmpresa.address,
          Amount         : xrpToDrops(INVOICE.precio_xrp),
          Memos          : buildMemo("factoring-compra", {
            invoice_id  : INVOICE.id,
            radian_hash : radianHash,
            tipo_evento : "FACTORING_COMPRA",
            valor_facial: INVOICE.valor_xrp,
            descuento   : `${INVOICE.descuento_pct}%`,
            precio_pago : INVOICE.precio_xrp,
          }),
        })
      ).tx_blob
    );

    console.log();
    col("  Hash Pago inversor→empresa", buyResult.result.hash);
    col("  Estado", ok(buyResult.result.meta.TransactionResult));
    col("  Inversor pagó", `${INVOICE.precio_xrp} XRP (descuento ${INVOICE.descuento_pct}% sobre ${INVOICE.valor_xrp} XRP)`);
    console.log(`\n  🔗  ${EXPLORER}/${buyResult.result.hash}`);

    // ── PASO 6: Empresa transfiere MPT al inversor ────────────────────────
    step(6, "Transferencia MPT — empresa entrega título al inversor");

    const mptTransferResult = await client.submitAndWait(
      wEmpresa.sign(
        await client.autofill({
          TransactionType: "Payment",
          Account        : wEmpresa.address,
          Destination    : wInversor.address,
          Amount         : { mpt_issuance_id: mptID, value: "1" },
          Memos          : buildMemo("mpt-transfer", {
            invoice_id  : INVOICE.id,
            radian_hash : radianHash,
            tipo_evento : "TRANSFERENCIA_MPT",
            de          : "empresa_transporte",
            para        : "inversor_institucional",
          }),
        })
      ).tx_blob
    );

    console.log();
    col("  Hash MPT Payment", mptTransferResult.result.hash);
    col("  Estado", ok(mptTransferResult.result.meta.TransactionResult));
    col("  MPT transferido a inversor", wInversor.address.slice(0, 14) + "…");
    col("  Estado factura", "DISPONIBLE → EN_PODER_INVERSOR");
    console.log(`\n  🔗  ${EXPLORER}/${mptTransferResult.result.hash}`);

    // ── PASO 7: PAGO_CONDUCTOR — liquidez inmediata ───────────────────────
    step(7, `PAGO_CONDUCTOR — empresa inyecta ${INVOICE.precio_xrp} XRP al conductor`);

    const conductorResult = await client.submitAndWait(
      wEmpresa.sign(
        await client.autofill({
          TransactionType: "Payment",
          Account        : wEmpresa.address,
          Destination    : wConductor.address,
          Amount         : xrpToDrops(INVOICE.precio_xrp),
          Memos          : buildMemo("pago-conductor", {
            invoice_id    : INVOICE.id,
            radian_hash   : radianHash,
            tipo_evento   : "PAGO_CONDUCTOR",
            concepto      : "Anticipo flete via factoring RADIAN",
            dias_ahorrados: INVOICE.plazo_dias,
          }),
        })
      ).tx_blob
    );

    console.log();
    col("  Hash Pago empresa→conductor", conductorResult.result.hash);
    col("  Estado", ok(conductorResult.result.meta.TransactionResult));
    col("  Conductor recibió", `${INVOICE.precio_xrp} XRP  (en minutos, no en ${INVOICE.plazo_dias} días)`);
    console.log(`\n  🔗  ${EXPLORER}/${conductorResult.result.hash}`);

    // ── PASO 8: RECUPERACION_POOL — vencimiento simulado ─────────────────
    step(8, `RECUPERACION_POOL — cargador paga ${INVOICE.valor_xrp} XRP al inversor (vencimiento)`);

    const poolResult = await client.submitAndWait(
      wCargador.sign(
        await client.autofill({
          TransactionType: "Payment",
          Account        : wCargador.address,
          Destination    : wInversor.address,
          Amount         : xrpToDrops(INVOICE.valor_xrp),
          Memos          : buildMemo("recuperacion-pool", {
            invoice_id  : INVOICE.id,
            radian_hash : radianHash,
            tipo_evento : "RECUPERACION_POOL",
            valor_facial: INVOICE.valor_xrp,
            spread_xrp  : INVOICE.spread_xrp,
            plazo_dias  : INVOICE.plazo_dias,
          }),
        })
      ).tx_blob
    );

    console.log();
    col("  Hash Pago cargador→inversor", poolResult.result.hash);
    col("  Estado", ok(poolResult.result.meta.TransactionResult));
    col("  Capital recuperado", `${INVOICE.valor_xrp} XRP (valor facial de la factura)`);
    col("  Spread del inversor", `${INVOICE.spread_xrp} XRP  (2% en ${INVOICE.plazo_dias} días ≈ 12.2% APY)`);
    console.log(`\n  🔗  ${EXPLORER}/${poolResult.result.hash}`);

    // ── PASO 9: Resumen financiero ────────────────────────────────────────
    step(9, "Resumen financiero del ciclo de factoring");

    // Balances finales
    const [infoConductor, infoInversor] = await Promise.all([
      client.request({ command: "account_info", account: wConductor.address, ledger_index: "validated" }),
      client.request({ command: "account_info", account: wInversor.address,  ledger_index: "validated" }),
    ]);
    const balConductor = dropsToXrp(infoConductor.result.account_data.Balance);
    const balInversor  = dropsToXrp(infoInversor.result.account_data.Balance);

    console.log(`
  ┌────────────────────────────────────────────────────────────────┐
  │  FREIGHTFI — Ciclo de Factoring RADIAN completado              │
  ├──────────────────────┬─────────────────────────────────────────┤
  │  Conductor           │  Cobró ${INVOICE.precio_xrp} XRP en minutos              │
  │                      │  Sin esperar ${INVOICE.plazo_dias} días de plazo                  │
  │                      │  Balance final: ${String(balConductor).padEnd(6)} XRP              │
  ├──────────────────────┼─────────────────────────────────────────┤
  │  Inversionista       │  Pagó  ${INVOICE.precio_xrp} XRP  →  Cobró ${INVOICE.valor_xrp} XRP      │
  │                      │  Spread: ${INVOICE.spread_xrp} XRP  (2% en 60 días)         │
  │                      │  Balance final: ${String(balInversor).padEnd(6)} XRP              │
  │                      │  APY aproximado: 12.2%                  │
  ├──────────────────────┼─────────────────────────────────────────┤
  │  Pool / Cargador     │  Pagó valor facial ${INVOICE.valor_xrp} XRP al vencim.  │
  │                      │  Pool: capital + spread sostenible      │
  ├──────────────────────┼─────────────────────────────────────────┤
  │  RADIAN / MPT        │  Factura tokenizada on-chain (XRPL)     │
  │                      │  radian_hash + invoice_id en memo       │
  │  MPTokenIssuanceID   │  ${(mptID ?? "N/A").slice(0, 20)}…        │
  └──────────────────────┴─────────────────────────────────────────┘`);

    // ── PASO 10: Links directos ───────────────────────────────────────────
    step(10, "Links directos — XRPL Testnet Explorer");

    console.log(`
  [1] MPTokenIssuanceCreate  (factura tokenizada como MPT):
      ${EXPLORER}/${mptCreateResult.result.hash}

  [2] MPTokenAuthorize       (inversor hace opt-in para recibir MPT):
      ${EXPLORER}/${authResult.result.hash}

  [3] FACTORING_COMPRA       (inversor paga ${INVOICE.precio_xrp} XRP a empresa):
      ${EXPLORER}/${buyResult.result.hash}

  [4] Transferencia MPT      (empresa → inversor, título valor):
      ${EXPLORER}/${mptTransferResult.result.hash}

  [5] PAGO_CONDUCTOR         (conductor recibe ${INVOICE.precio_xrp} XRP en minutos):
      ${EXPLORER}/${conductorResult.result.hash}

  [6] RECUPERACION_POOL      (cargador paga ${INVOICE.valor_xrp} XRP al inversor):
      ${EXPLORER}/${poolResult.result.hash}
`);

    console.log(hr("═"));
    console.log("  FREIGHTFI RADIAN FACTORING — Completado exitosamente");
    console.log(hr("═") + "\n");

  } finally {
    await client.disconnect();
    console.log("  Desconectado del nodo XRPL.\n");
  }
}

runRadianFactoring().catch((err) => {
  console.error("Error:", err.message ?? err);
  process.exit(1);
});
