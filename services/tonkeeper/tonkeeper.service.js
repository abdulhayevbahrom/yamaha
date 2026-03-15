const TonWeb = require("tonweb");
const axios = require("axios");
const { mnemonicToPrivateKey } = require("@ton/crypto");

class TonkeeperService {
  constructor() {
    this.mnemonic = process.env.TON_MNEMONIC?.split(" ") || [];
    this.adminAddress = process.env.ADMIN_WALLET;
    this.initialized = false;

    this.tonweb = new TonWeb(
      new TonWeb.HttpProvider("https://toncenter.com/api/v2/jsonRPC", {
        apiKey: process.env.TONCENTER_API_KEY,
      })
    );

    this.tonapi = axios.create({
      baseURL: "https://tonapi.io/v2",
      headers: {
        Authorization: `Bearer ${process.env.TON_API_KEY}`,
      },
    });
  }

  async init() {
    if (this.initialized) return;

    try {
      if (!this.mnemonic.length) {
        throw new Error("TON_MNEMONIC topilmadi .env da");
      }

      const keyPair = await mnemonicToPrivateKey(this.mnemonic);

      this.keyPair = {
        publicKey: keyPair.publicKey,
        secretKey: keyPair.secretKey,
      };

      const WalletClass = this.tonweb.wallet.all["v4R2"];
      this.wallet = new WalletClass(this.tonweb.provider, {
        publicKey: this.keyPair.publicKey,
        wc: 0,
      });

      const address = await this.wallet.getAddress();
      this.walletAddress = address.toString(true, true, true);

      // console.log("✅ Tonkeeper wallet tayyor");
      // console.log("📮 Address:", this.walletAddress);

      this.initialized = true;
    } catch (error) {
      console.error("❌ Tonkeeper init xatolik:", error);
      throw error;
    }
  }

  async getBalance() {
    try {
      await this.init();

      const balanceNano = await this.tonweb.provider.getBalance(
        this.walletAddress
      );

      return Number(TonWeb.utils.fromNano(balanceNano));
    } catch (error) {
      console.error("❌ Balance xatolik:", error);
      throw new Error("Balans olishda xatolik");
    }
  }

  // Batafsil balans (TonAPI orqali)
  async getDetailedBalance() {
    try {
      await this.init();
      const response = await this.tonapi.get(`/accounts/${this.walletAddress}`);
      return {
        balance: response.data.balance / 1e9,
        status: response.data.status,
        lastActivity: response.data.last_activity,
        address: this.walletAddress,
      };
    } catch (error) {
      console.error("❌ Detailed balance xatolik:", error);
      // Fallback to basic balance
      const balance = await this.getBalance();
      return { balance, address: this.walletAddress };
    }
  }

  // TON yuborish
  async sendTon(toAddress, amount, comment = "") {
    try {
      await this.init();

      const balance = await this.getBalance();
      if (balance < amount) {
        throw new Error(
          `Yetarli balans yo'q. Kerak: ${amount} TON, Mavjud: ${balance} TON`
        );
      }

      const amountNano = TonWeb.utils.toNano(amount.toString());

      // console.log(`📤 TON yuborilmoqda:`);
      // console.log(`   From: ${this.walletAddress}`);
      // console.log(`   To: ${toAddress}`);
      // console.log(`   Amount: ${amount} TON`);
      // console.log(`   Comment: ${comment || "yo'q"}`);

      // ✅ SEQNO FIX
      let seqno = await this.wallet.methods.seqno().call();
      if (seqno === null || seqno === undefined) {
        seqno = 0;
      }

      const transfer = this.wallet.methods.transfer({
        secretKey: this.keyPair.secretKey,
        toAddress,
        amount: amountNano,
        seqno,
        payload: comment,
        sendMode: 3,
      });

      await transfer.send();

      // console.log("✅ TON yuborildi!");

      return {
        success: true,
        amount,
        to: toAddress,
        from: this.walletAddress,
        comment,
        timestamp: new Date(),
      };
    } catch (error) {
      console.error("❌ TON yuborishda xatolik:", error);
      throw error;
    }
  }

  // Transaction tarixini olish
  async getTransactions(limit = 10) {
    try {
      await this.init();
      const response = await this.tonapi.get(
        `/accounts/${this.walletAddress}/events`,
        { params: { limit } }
      );

      return response.data.events.map((tx) => {
        const action = tx.actions[0];
        return {
          hash: tx.event_id,
          timestamp: new Date(tx.timestamp * 1000),
          type: action.type,
          amount: action.TonTransfer?.amount / 1e9 || 0,
          from: action.TonTransfer?.sender?.address || "unknown",
          to: action.TonTransfer?.recipient?.address || "unknown",
          comment: action.TonTransfer?.comment || "",
        };
      });
    } catch (error) {
      console.error("❌ Transactions xatolik:", error);
      return [];
    }
  }

  // Wallet ma'lumotlarini olish
  async getWalletInfo() {
    try {
      await this.init();
      const balance = await this.getDetailedBalance();
      const transactions = await this.getTransactions(5);

      return {
        address: this.walletAddress,
        balance: balance.balance,
        status: balance.status || "active",
        recentTransactions: transactions,
        lastUpdate: new Date(),
      };
    } catch (error) {
      console.error("❌ Wallet info xatolik:", error);
      throw error;
    }
  }
}

let tonkeeperInstance = null;

const getTonkeeperService = () => {
  if (!tonkeeperInstance) {
    tonkeeperInstance = new TonkeeperService();
  }
  return tonkeeperInstance;
};

module.exports = {
  getTonkeeperService,
  TonkeeperService,
};
