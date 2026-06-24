# Euchre Table + Phone Hand App

A Railway-ready multiplayer Euchre web app.

- iPad/table view shows the Euchre table, scorecard, kitty/up-card, played cards, trick piles, turn pointer, and four seat-specific QR codes.
- Each QR code is a normal HTTPS link to a seat-specific phone hand view.
- Seat color determines team: South/North are Blue, West/East are Red.
- Phone view shows a rotary fan hand with huge cards. Swipe sideways to move through cards. Swipe a card upward to play/discard it.
- Supports two-round trump selection, pass/order-up, suit choice from the remaining three suits in round 2, dealer discard, going alone, trick resolution, and scoring.
- Includes phone preview mode with 5 random cards.

## Local setup

```bash
npm install
npm start
```

Open:

```text
http://localhost:3000/?role=table
```

Phone preview:

```text
http://localhost:3000/?role=hand&preview=1
```

## Deploy to Railway through GitHub

1. Unzip this folder.
2. Push the contents to a GitHub repository.
3. In Railway, create a new project from that GitHub repo.
4. Railway should install dependencies and run `npm start`.
5. Open the generated Railway domain on the iPad with `/?role=table`.
6. Scan each seat QR code from the phones.

The server listens on `process.env.PORT || 3000`, so it works with Railway's dynamic port environment.

## Notes

This version keeps game state in server memory. That is perfect for one live table on a single Railway instance, but it will not persist games after a server restart and it is not designed for multi-instance horizontal scaling.

