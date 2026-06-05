import { Client, Wallet } from "xrpl";

const TESTNET_URL = "wss://s.altnet.rippletest.net:51233";

async function main() {
  const client = new Client(TESTNET_URL);

  try {
    console.log("Conectando a XRPL Testnet...");
    await client.connect();
    console.log("Conexion establecida.\n");

    console.log("Generando wallet de prueba (faucet)...");
    const { wallet, balance } = await client.fundWallet();

    console.log("=== WALLET GENERADA ===");
    console.log(`Direccion:  ${wallet.address}`);
    console.log(`Seed:       ${wallet.seed}`);
    console.log(`Clave pub:  ${wallet.publicKey}`);
    console.log(`Balance:    ${balance} XRP`);
    console.log("=======================");

    // Verificacion adicional consultando el ledger
    const accountInfo = await client.request({
      command: "account_info",
      account: wallet.address,
      ledger_index: "validated",
    });

    const drops = accountInfo.result.account_data.Balance;
    const xrp = Number(drops) / 1_000_000;
    console.log(`\nBalance confirmado en ledger: ${xrp} XRP (${drops} drops)`);
  } finally {
    await client.disconnect();
    console.log("\nDesconectado del nodo.");
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
