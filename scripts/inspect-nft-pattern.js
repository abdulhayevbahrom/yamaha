require("dotenv").config();
const util = require("node:util");
const {
  getMyTelegramNftGifts,
} = require("../services/telegram-gift.service");

async function main() {
  const limitArg = Number(process.argv[2] || 10);
  const limit = Number.isFinite(limitArg)
    ? Math.min(Math.max(Math.trunc(limitArg), 1), 50)
    : 10;

  console.log(`[INSPECT_NFT_PATTERN] limit=${limit}`);

  const items = await getMyTelegramNftGifts({
    limit,
    debug: true,
    debugLimit: Math.min(limit, 20),
  });

  const payload = items.map((item, index) => ({
    index: index + 1,
    nftId: item?.nftId,
    slug: item?.slug,
    title: item?.title,
    symbol: item?.symbol,
    backdrop: item?.backdrop,
    patternAsset: item?.patternAsset || null,
  }));

  console.log(
    util.inspect(payload, {
      depth: 6,
      colors: false,
      maxArrayLength: 100,
      breakLength: 140,
    }),
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(
      "[INSPECT_NFT_PATTERN][ERROR]",
      error?.errorMessage || error?.message || String(error),
    );
    process.exit(1);
  });
