# Xavfsiz deploy qilish bo‘yicha yo‘riqnoma

Kiritilgan xavfsizlik o‘zgarishlari oldingi buyurtmalar bilan mos ishlaydi.
Production muhitida quyidagi sozlamalarni kiritish shart.

## Asosiy sozlamalar

- `ADMIN_ALLOWED_TG_IDS`: admin panelga kirishi mumkin bo‘lgan Telegram
  foydalanuvchi IDlari. Bir nechta ID vergul bilan ajratiladi. Bu sozlama
  kiritilmasa, `ADMIN_NOTIFY_CHAT_ID` ishlatiladi. Ikkalasi ham bo‘sh bo‘lsa,
  admin panelga kirish bloklanadi.
- `TG_INIT_DATA_MAX_AGE_SEC_CRITICAL`: moliyaviy amallar uchun Telegram
  `initData` sessiyasining maksimal yoshi, soniyalarda. Standart qiymat:
  `600` (10 daqiqa). Production `.env` faylida oldingi `300` qiymati qolgan
  bo‘lsa, uni ham `600` ga almashtirish kerak.
- `TRUST_PROXY`: faqat haqiqiy reverse proxy topologiyasi yoki ishonchli proxy
  tarmog‘iga moslab sozlanishi kerak. Standart qiymat `false`. Raqamli hop
  qiymati ishlatilsa, origin server internetdan bevosita ochiq bo‘lmasligi
  kerak.

## Cloudflare Turnstile

Turnstile buyurtma yaratish, balans to‘ldirish, Gift/NFT amallari va admin
login so‘rovlarini avtomatlashtirilgan hujumlardan himoya qiladi.

Uni yoqishdan oldin quyidagilarni sozlang:

```text
TURNSTILE_ENABLED=true
TURNSTILE_SECRET_KEY=...
TURNSTILE_ALLOWED_HOSTNAMES=yamaha-mini-app.vercel.app
TURNSTILE_EXPECTED_ACTION=api_write
```

Frontend uchun:

```text
VITE_TURNSTILE_SITE_KEY=...
```

`TURNSTILE_ALLOWED_HOSTNAMES` ichida bir nechta frontend domeni vergul bilan
ajratiladi. `TURNSTILE_EXPECTED_ACTION` standart holatda `api_write`.

Turnstile `x-request-id` o‘rnini bosmaydi. Turnstile avtomatlashtirilgan
hujumlarni kamaytiradi, `x-request-id` esa takroriy so‘rov va bir amalning
ikki marta bajarilishiga qarshi ishlaydi.

## CardXabar to‘lov oqimi

To‘lovlar tashqi HTTP servisdan qabul qilinmaydi.
`/api/integrations/orders/process-payment` va
`/api/admin/orders/process-payment` endpointlari yopilgan.

CardXabar xabarlari `yamaha-cardxabar-client` PM2 processi orqali olinadi va
backend ichida bevosita qayta ishlanadi. Productionda `CARDXABAR_CHAT_ID`
majburiy: faqat shu aniq Telegram chatdan kelgan xabarlar qabul qilinadi.

Shu sabab `INTEGRATION_IP_ALLOWLIST`, `INTERNAL_API_KEY` va
`INTERNAL_SIGNING_SECRET` kerak emas.

## To‘lov kartalari

To‘lov kartalari admin panel orqali kiritilishi kerak. Kod ichidagi doimiy
karta raqamlari olib tashlangan.

Favqulodda vaziyatda env orqali karta berish quyidagicha yoqiladi:

```text
ALLOW_PAYMENT_CARD_ENV_FALLBACK=true
PURCHASE_FALLBACK_CARD_NUMBER=...
PURCHASE_FALLBACK_CARD_HOLDER=...
TOPUP_FALLBACK_CARD_NUMBER=...
TOPUP_FALLBACK_CARD_HOLDER=...
```

Bu fallback faqat vaqtinchalik choraga mo‘ljallangan.

## Deploydan oldingi tekshiruv

Serverda quyidagi buyruq bajariladi:

```bash
NODE_ENV=production npm run preflight
```

U kerakli env sozlamalari, CardXabar va Gift Telegram sessionlari, MongoDB
ulanishi, kritik indekslar hamda aktiv purchase/topup kartalarini tekshiradi.
Tekshiruvdan o‘tmasa PM2 processlari restart qilinmaydi.

## Qo‘lda tekshiriladigan amallar

Order yoki Telegram transfer `needs_review` holatiga tushsa, tashqi provayder
natijasi aniq bo'lmagan bo'ladi. Bunday amalni qayta bajarish yoki pulni
qaytarishdan oldin administrator uni qo'lda tekshirishi shart.

## GW PUBG UC production rollout

GW integratsiyasini birdaniga yoqmaslik kerak. Deploy tartibi:

1. Backend va frontend kodini `GW_PUBG_AUTOBUY_ENABLED=false` bilan deploy qiling.
2. Production server IPv4 manzilini GW kabinetidagi allowlistga kiriting.
3. Yangi GW API kalitini faqat backend `.env` fayliga yozing.
4. Backendni restart qilib, admin paneldagi “GW katalogini yangilash” amalini bajaring.
5. Har bir PID, UC miqdori, GW USD narxi va mavjudlik holatini tekshiring.
6. Har bir faol paketga mijoz uchun UZS narxini kiriting. Provider USD narxi
   mijoz narxi sifatida ishlatilmaydi.
7. `NODE_ENV=production npm run preflight` muvaffaqiyatli tugaganini tekshiring.
8. Faqat shundan keyin `GW_PUBG_AUTOBUY_ENABLED=true` qilib backendni restart qiling.
9. Bitta kichik ichki PUBG buyurtmasini tekshiring; `completed`, provider order ID,
   mijoz balansidagi yechim va tarix yozuvini solishtiring.

Tavsiya etilgan sozlamalar:

```text
GW_API_URL=https://api.sonofutred.com
GW_API_TIMEOUT_MS=20000
GW_PUBG_AUTOBUY_ENABLED=false
GW_PUBG_POLL_INTERVAL_MS=5000
GW_PUBG_POLL_MAX_ATTEMPTS=24
GW_PUBG_SUBMIT_RECOVERY_MAX_ATTEMPTS=6
GW_PUBG_CATALOG_SYNC_INTERVAL_MS=300000
GW_PUBG_CATALOG_MAX_AGE_MS=1800000
```

Katalog belgilangan maksimal yoshdan eskirsa yoki paket providerda mavjud bo'lmasa,
yangi buyurtma qabul qilinmaydi. Submit natijasi timeout sabab noma'lum bo'lsa,
bir xil idempotent `trxid` bilan recovery bajariladi. Recovery ham aniq natija
bermasa order `needs_review` holatiga o'tadi; bu holatda avtomatik refund yoki
yangi `trxid` bilan qayta xarid qilish taqiqlanadi.
