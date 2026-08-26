# Uzum PUBG API Contract

Bu hujjat `UzumBank -> PUBG UC` mini-API oqimi uchun mo‘ljallangan.

## Maqsad

Mijoz UzumBank ilovasida:
- O‘yinlar bo‘limini ochadi
- PUBG ni tanlaydi
- paketni tanlaydi
- `playerId` kiritadi

Backend esa:
- `serviceId` va auth ni tekshiradi
- `playerId` ni GW API orqali verify qiladi
- `profileName` ni qaytaradi
- buyurtmani yaratadi
- GW PUBG auto-fulfillment ni ishga tushiradi

## Auth

Har bir request `Authorization` header bilan keladi.

Format:
```text
Basic base64(login:password)
```

`.env` sozlamalari:
```env
UZUM_PUBG_SERVICE_IDS=7814652
UZUM_PUBG_LOGIN=uzumloginforpubg
UZUM_PUBG_PASSWORD=uzumpasswordforpubg
UZUM_PUBG_CONFIRM_WAIT_MS=125000
UZUM_PUBG_CONFIRM_CHECK_INTERVAL_MS=500
```

## Endpointlar

### `POST /uzum/pubg/check`

Request body:
```json
{
  "serviceId": 7814652,
  "params": {
    "playerId": "512345678",
    "planCode": "60"
  }
}
```

Response `OK`:
```json
{
  "serviceId": 7814652,
  "timestamp": 1724300000000,
  "status": "OK",
  "data": {
    "player_id": { "value": "512345678" },
    "profile_name": { "value": "Player Nick" },
    "amount": { "value": "14000" }
  }
}
```

### `POST /uzum/pubg/create`

Request body:
```json
{
  "serviceId": 7814652,
  "transId": "UZM-PUBG-0001",
  "price_amount": 14000,
  "params": {
    "playerId": "512345678",
    "planCode": "60"
  }
}
```

Response `CREATED`:
```json
{
  "serviceId": 7814652,
  "transId": "UZM-PUBG-0001",
  "status": "CREATED",
  "transTime": 1724300000000,
  "data": {},
  "amount": 14000
}
```

### `POST /uzum/pubg/confirm`

`confirm` GW sotuvining yakuniy natijasini kutadi. Faqat order `completed/success`
bo'lganda `CONFIRMED`, sotuv bekor qilingan yoki yakunlanmagan bo'lsa `10015`
qaytaradi. Kutish muddati `UZUM_PUBG_CONFIRM_WAIT_MS` orqali sozlanadi.
`confirmTime` response yuborilgan vaqt emas, GW sotuv muvaffaqiyatli yakunlangan vaqt.

Request body:
```json
{
  "serviceId": 7814652,
  "transId": "UZM-PUBG-0001"
}
```

Response `CONFIRMED`:
```json
{
  "serviceId": 7814652,
  "transId": "UZM-PUBG-0001",
  "confirmTime": 1724300000000,
  "status": "CONFIRMED",
  "data": {},
  "amount": 14000
}
```

### `POST /uzum/pubg/status`

`transTime` order `/create` orqali yaratilgan vaqtni, `confirmTime` esa sotuv
muvaffaqiyatli yakunlangan vaqtni qaytaradi.

Request body:
```json
{
  "serviceId": 7814652,
  "transId": "UZM-PUBG-0001"
}
```

Response mumkin bo‘lgan holatlar:
- `CONFIRMED`
- `REVERSED`
- `FAILED`

## Validatsiya qoidalari

- `serviceId` `.env` dagi ro‘yxatda bo‘lishi kerak
- login/parol `.env` dagi qiymatga mos bo‘lishi kerak
- `playerId` `5` bilan boshlanishi kerak
- `planCode` `uc` planlari ichida bo‘lishi kerak
- `price_amount` plan narxiga mos bo‘lishi kerak
- `playerId` GW API orqali verify qilinishi kerak

## Error code’lar

- `10001` - auth xato
- `10005` - majburiy parametr yo‘q
- `10006` - serviceId noto‘g‘ri
- `10007` - player yoki paket topilmadi
- `10008` - dublikat tranzaksiya
- `10009` - order yaratilmadi
- `10011` - narx mos emas
- `10014` - tranzaksiya topilmadi yoki status noma’lum
- `10015` - order tasdiqlashga tayyor emas
- `99999` - server xatosi

## Ichki xulosa

Bu flow `yamaha`ning existing mini-API checkout oqimiga ulanmaydi.
U alohida provider sifatida ishlaydi va faqat PUBG UC uchun mo‘ljallangan.
