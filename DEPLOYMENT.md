# Deployment & Setup

## Hosting
- **Repo:** https://github.com/Legends97/crtg-website.git
- **Vercel-Projekt:** `legends-panel/crtg-plattform`
- **Live-URL:** https://crtg-plattform.vercel.app
- GitHub-Repo ist mit Vercel verbunden → jeder Push auf `main` deployed automatisch neu.
- Manuell deployen: `npx vercel --prod --yes` im Projektordner.

## Datenbank
- **Neon Postgres** (über Vercel Marketplace Integration `neon-crimson-book`), verbunden via `vercel integration add neon`.
- Verbindung läuft über die Env Var `DATABASE_URL` (automatisch von der Integration gesetzt, in Vercel Project Settings → Environment Variables).
- Tabelle `users` wird beim ersten API-Aufruf automatisch angelegt (`create table if not exists` in `api/index.js`).

## Discord-Login (OAuth2)
- Discord-App im [Developer Portal](https://discord.com/developers/applications) angelegt ("CRTG PLATTFORM").
- Redirect-URI: `https://crtg-plattform.vercel.app/api/auth/callback`
- Env Vars in Vercel: `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`
- Nur Mitglieder des Discord-Servers mit der ID in `DISCORD_GUILD_ID` (Env Var) dürfen sich anmelden (Scope `identify guilds`, Prüfung in `callback()` in `api/index.js`).
- Wer sich zum ersten Mal einloggt, wird automatisch als Fahrer (`role: driver`) angelegt.

## Admins
- Admin-Rechte sind **fest im Code** hinterlegt (nicht als Env Var), in `api/index.js` ganz oben:
  ```js
  const ADMIN_DISCORD_IDS = [
    "755740275627786270", // Benni
    "489500699676377088", // Legends
  ];
  ```
- Jede Discord-ID in dieser Liste wird beim Login automatisch zum Admin gemacht/gehalten. Um jemanden als Admin hinzuzufügen: ID in diese Liste eintragen, committen, pushen (Auto-Deploy übernimmt den Rest).

## Steam-Verknüpfung
- Eingeloggte Nutzer können im Account-Menü (Navbar) ihre SteamID64 verknüpfen über Steam OpenID (`/api/auth/steam` → `/api/auth/steam/callback`), kein API-Key nötig.

## Fahrernummer
- Jeder Fahrer kann im Account-Menü seine eigene Fahrernummer setzen (`PATCH /api/me`), eindeutig unter aktiven Fahrern.
- Admins können sie zusätzlich im Admin-Panel (`/admin/`) für jeden Fahrer setzen/ändern.

## Zugriffsschutz
- Alle Seiten (außer `login.html`) verlangen eine Anmeldung: `nav.js` prüft `/api/me`, leitet unangemeldete Besucher automatisch auf `login.html` um (Inhalt bleibt per CSS unsichtbar bis die Prüfung durch ist, kein Flash of Content).

## Stintplaner
- Links: Fahrer-Liste mit Platzhaltern „Fahrer 1/2/3", frei editierbar/erweiterbar.
- Rechts: pro Stint ein Dropdown mit allen Platzhaltern **plus** allen registrierten Team-Mitgliedern (`GET /api/drivers`, für jeden eingeloggten Nutzer zugänglich). Auswahl legt bei Bedarf automatisch einen neuen Fahrer-Slot links an.

## Umgebungsvariablen (Vercel → Project Settings → Environment Variables)
| Name | Zweck |
|---|---|
| `DATABASE_URL` | Neon-Postgres-Verbindung (automatisch von der Integration) |
| `SESSION_SECRET` | Signiert die Login-Session-Cookies (zufällig generiert, ≥32 Zeichen) |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | Discord-OAuth-App |
| `DISCORD_GUILD_ID` | Discord-Server, dessen Mitglieder sich einloggen dürfen |

Admin-IDs sind **nicht** mehr als Env Var hinterlegt, siehe oben (Code).
