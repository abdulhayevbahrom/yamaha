const { getTonkeeperService } = require("./tonkeeper.service");

const tonkeeper = getTonkeeperService();

const getBalance = async (req, res) => {
  try {
    const balance = await tonkeeper.getDetailedBalance();

    res.json({
      success: true,
      data: balance,
    });
  } catch (error) {
    console.error("Balance xatolik:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

const getWalletInfo = async (req, res) => {
  try {
    const info = await tonkeeper.getWalletInfo();

    res.json({
      success: true,
      data: info,
    });
  } catch (error) {
    console.error("Wallet info xatolik:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

const getTransactions = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const transactions = await tonkeeper.getTransactions(limit);

    res.json({
      success: true,
      count: transactions.length,
      data: transactions,
    });
  } catch (error) {
    console.error("Transactions xatolik:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

const sendTon = async (req, res) => {
  try {
    const { toAddress, amount, comment } = req.body;

    if (!toAddress || !amount) {
      return res.status(400).json({
        success: false,
        error: "toAddress va amount majburiy",
      });
    }

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({
        success: false,
        error: "Amount musbat raqam bo'lishi kerak",
      });
    }

    const result = await tonkeeper.sendTon(toAddress, amountNum, comment);

    res.json({
      success: true,
      message: "TON muvaffaqiyatli yuborildi",
      data: result,
    });
  } catch (error) {
    console.error("Send TON xatolik:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

module.exports = {
  getBalance,
  getWalletInfo,
  getTransactions,
  sendTon,
};
