# Research: Optionen für einen In-App-Notification-Posteingang

> Ticket: #10 (Teil der Karte #9). Stand: 2026-11-17. **Keine Entscheidung** — nur Vergleich und Shortlist als Grundlage für das Entscheidungs-Ticket.

## Rahmen (aus #9)

- Gesucht: dauerhafter **Posteingang** (Glocke, Ungelesen-Zähler, Liste, gelesen/ungelesen) — nur **In-App-Kanal**. E-Mail bleibt bei Postmark (`app/lib/mailer.server.ts`), Toasts bei `sonner`.
- Harte Kriterien: **DSGVO** (gehostet ⇒ EU-Hosting + AVV/DPA), **Stack-Passung** (React 19.2, React Router 8.3 mit SSR; fertige React-Komponente ist ein Plus), **Kosten** (Free Tier Plus, kein Muss).
- Relevanter Kontext aus dem Repo: Cadence läuft als **ein Prozess mit einer SQLite-Datei** via Drizzle ([ADR 0006](../adr/0006-one-sqlite-file-through-drizzle.md)). UI-Bausteine vorhanden: `radix-ui`, `lucide-react`, Tailwind, `app/components/ui/*`.

## Kandidaten im Überblick

| Option | Typ | EU-Hosting | DPA/AVV | React-Komponente (React 19?) | Node Server SDK | Realtime | Read/Unread-Modell | Free Tier | Preis bei kleinem Volumen | Betriebsaufwand | Lock-in |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Novu Cloud** | SaaS (Open Core) | **Ja, Frankfurt**, auch im Free-Plan [1][2] | Ja, DPA + SCC zum Download [2] | `@novu/react` `<Inbox />` + Headless-Hooks; React 18/19 [3][4] | `@novu/api` [4] | Ja, WebSocket (`wss://eu.socket.novu.co`) [2] | read/unread, Unread-Count in Echtzeit [3]; Archiv/Snooze (Snooze nur Cloud) [5] | 10.000 Workflow Runs/Monat, Novu-Branding [1] | Pro ab $30/Monat (30k Runs), danach $1,20/1k [1] | gering | mittel (Workflows/Templates bei Novu; Core ist MIT → Exit zu Self-Hosting möglich) [6] |
| **Novu self-hosted (Community)** | selbst betrieben | eigene Infra | n/a (eigene Verantwortung) [5] | wie Cloud; Bell/Inbox/Preferences auch self-hosted, nur Branding-Entfernung + Snooze cloud-only [5] | `@novu/api` | WebSocket (eigener WS-Service) [7] | wie Cloud | kostenlos (MIT Core) [6] | Infra-Kosten | **hoch**: API, Worker, WS, Dashboard + **MongoDB + Redis (AOF) + S3**; Single-VM min. 4 vCPU/8 GB [7]; nur 1 Team-Member [5] | gering–mittel |
| **Knock** | SaaS | **Nein** — „EU data residency is coming soon … by the end of 2026“ [8]; Transfer via DPF/SCC [9] | Ja [10] | `@knocklabs/react`: `NotificationFeedPopover`, `NotificationFeed`, `NotificationIconButton` + Hooks [11]; peer React 17–19 [npm] | `@knocklabs/node` | Ja, WebSocket (managed) [12] | seen / read / interacted / archived [12] | 10.000 Messages/Monat [13] | Starter **$250/Monat** (50k), dann $0,005/Msg [13] | gering | hoch |
| **Courier** | SaaS | Ja, **Irland** — aber **nur Business/Enterprise** (bezahlt) [14] | laut Pricing unter Enterprise [15] | `@trycourier/courier-react` v9, peer `react >=18` [16][npm] | `@trycourier/courier` | Ja (Realtime-WebSocket `realtime.eu.courier.io`) [14] | read/unread, archived, opened; Cross-Device-Sync [16] | 10.000 Sends/Monat [15] | Business $0,005/Send **ab dem ersten Send** (50k = $250) [15] | gering | hoch |
| **SuprSend** | SaaS | „US or EU data residency“ [17][18]; Plan-Zuordnung unklar (Pricing nennt Custom-Region nur Enterprise) [19] | DPA verlinkt [19] | `@suprsend/react` (Drop-in + Headless), peer `react >=16.8` [20][npm] | `@suprsend/node-sdk` | laut gelesener Doku nicht spezifiziert | laut gelesener Doku nicht spezifiziert | 10.000 Notifications/Monat, SuprSend-Branding im Feed [19] | Essentials $100/Monat (50k), dann $0,002 [19] | gering | hoch |
| **MagicBell** | SaaS | **nicht dokumentiert** (Trust Centre nennt keine Region) [21] | Ja [21] | `@magicbell/react` (`Inbox`, `FloatingInbox` …) [22] | `magicbell-js` | laut gelesener Doku nicht spezifiziert | read/unread [22] | 1.000 Deliveries/Monat [23] | Startup $249/Monat (50k) [23] | gering | hoch |
| **Pingram (ex NotificationAPI)** | SaaS | laut Hersteller US/EU/CA-Regionen [24] | nicht geprüft | React SDK, React 19 laut Hersteller-Blog [25]; peer React 17–19 [npm] | ja | nicht geprüft | nicht geprüft | widersprüchlich (10k vs. 30k In-App; aktuelle Pricing-Seite nennt In-App nicht) [26] | ab $20/Monat [26] | gering | hoch |
| **Eigenbau: SQLite + eigene UI** | selbst betrieben | Daten bleiben in `data.db` | n/a (keine neue Partei) | keine fertige Lib — Bell/Popover aus `radix-ui` + `lucide-react` + bestehenden `ui/*`-Komponenten | Drizzle (bestehend) | optional: SSE über eine React-Router-**Resource Route** [27]; im Ein-Prozess-Setup reicht ein In-Memory-Event-Bus (Schluss aus ADR 0006) — sonst Revalidierung beim Navigieren | frei definierbar (z. B. `readAt` nullable, „alle gelesen“) | kostenlos | 0 € | mittel (Schema, Migration, UI, Tests selbst bauen; kein Extra-Service) | **keiner** |

`[npm]` = `peerDependencies` laut `npm view <paket>` am 2026-11-17: `@knocklabs/react@0.15.1` (react ^17–^19), `@novu/react@3.20.0` (react ^18 || ^19), `@trycourier/courier-react@9.3.5` (react >=18), `@suprsend/react@1.6.0` (react >=16.8), `@notificationapi/react@2.0.1` (react ^17–^19).

## Beobachtungen

- **DSGVO trennt das Feld am stärksten.** Dokumentiertes EU-Hosting im passenden Preisbereich hat nur **Novu Cloud** (Frankfurt, schon im Free-Plan) [1][2]. Courier hat EU (Irland), aber erst ab bezahltem Business-Plan [14]. Knock hat heute **kein** EU-Hosting [8]. MagicBell dokumentiert keine Region [21]. SuprSend nennt EU-Residency, die Plan-Zuordnung ist aber widersprüchlich [17][19] → beim Hersteller klären.
- **In-App zählt überall als abrechenbare Nachricht** (z. B. Knock: „email and in-app results in two messages“ [13]; MagicBell zählt pro Kanal [23]). Bei Cadence-Volumen dürften alle Free Tiers (1k–10k/Monat) anfangs reichen; der Sprung zur ersten bezahlten Stufe ist aber groß (Knock/MagicBell ~$250, SuprSend $100, Novu $30).
- **SSR:** Alle Vendor-Inboxen authentifizieren im Browser (Subscriber-ID/HMAC bzw. vom Server signiertes User-JWT [12][16][20][22]) und öffnen dort ihre WebSocket-Verbindung. Für React Router 8 heißt das (Schluss, nicht in den Vendor-Docs zu RR8 belegt): Inbox clientseitig rendern, Token im `loader` serverseitig erzeugen. Keiner der Anbieter hat React-Router-spezifische Doku; Novu verweist nur auf einen Next.js-Quickstart [3].
- **Self-hosted Novu** ist ein Architekturbruch zu ADR 0006: MongoDB + zwei Redis + Object Storage + vier Services [7], nur um einen Posteingang zu betreiben. DPA/SSO/RBAC entfallen, nur 1 Team-Member [5].
- **Eigenbau** passt am besten zur bestehenden Architektur (eine SQLite-Datei, ein Prozess, kein neuer Auftragsverarbeiter → keine AVV nötig). Kosten sind Entwicklungszeit statt Abo; Realtime ist optional und mit SSE über eine Resource Route ohne neue Infrastruktur machbar [27]. Eine verbreitete, gepflegte „Inbox-only“-React-UI-Library ohne Backend wurde nicht gefunden — die UI wäre aus vorhandenen Radix-Bausteinen zu bauen.

## Shortlist (für das Entscheidungs-Ticket)

1. **Eigenbau (SQLite + Radix-UI, optional SSE)** — kein Drittanbieter, DSGVO trivial, passt zu ADR 0006, kein Lock-in; Aufwand liegt in eigener Entwicklung.
2. **Novu Cloud (EU/Frankfurt)** — einziger gehosteter Dienst mit EU-Hosting + DPA schon im Free-Plan, fertige `<Inbox />` mit React 19 und WebSocket; MIT-Core mindert Lock-in.
3. **Courier (EU/Irland, Business)** — reifes Inbox-SDK mit Realtime und read/archived, EU-Hosting aber nur bezahlt ($0,005/Send ab dem ersten).
4. *(Optional, unter Vorbehalt)* **SuprSend** — günstige bezahlte Stufe und EU-Residency genannt; vor Aufnahme klären, ob EU im Free/Essentials-Plan verfügbar ist.

Ausgeschlossen bzw. nachrangig: **Knock** (heute kein EU-Hosting [8]), **MagicBell** (EU-Region nicht dokumentiert [21]), **Novu self-hosted** (Betriebsaufwand unverhältnismäßig [7]), **Pingram** (Angaben zu In-App-Preis widersprüchlich [26]).

## Offene Punkte für die Entscheidung

- Braucht Cadence Realtime (siehe „Echtzeit vs. beim Laden“ in #9)? Wenn nein, schrumpft der Vorteil der SaaS-Inboxen deutlich.
- SuprSend/Courier: genaue Plan-Zuordnung von EU-Hosting und DPA schriftlich beim Hersteller bestätigen lassen.

## Quellen

1. Novu Pricing — https://novu.co/pricing
2. Novu Docs, Security and Compliance — https://docs.novu.co/platform/additional-resources/security
3. Novu Docs, Inbox Overview — https://docs.novu.co/platform/inbox/overview
4. Novu Docs, `@novu/react` — https://docs.novu.co/platform/sdks/react ; Inbox Setup (EU `backendUrl`/`socketUrl`) — https://docs.novu.co/platform/inbox/setup-inbox
5. Novu Docs, Self-hosted vs. Novu Cloud — https://docs.novu.co/community/self-hosted-and-novu-cloud
6. Novu GitHub (MIT Core, `enterprise/` kommerziell) — https://github.com/novuhq/novu
7. Novu Docs, Self-Hosting Overview — https://docs.novu.co/community/self-hosting-novu/overview
8. Knock Docs, Plans and usage (EU data residency „coming soon“) — https://docs.knock.app/manage-your-account/knock-plans
9. Knock Privacy Policy — https://knock.app/legal/privacy-policy
10. Knock Data Processing Addendum — https://knock.app/legal/data-processing-addendum
11. Knock Docs, React In-App UI — https://docs.knock.app/in-app-ui/react/overview
12. Knock Docs, In-App Feeds — https://docs.knock.app/in-app-ui/feeds/overview
13. Knock Pricing — https://knock.app/pricing (Message-Zählung: [8])
14. Courier Docs, EU Datacenter — https://www.courier.com/docs/platform/workspaces/eu-datacenter
15. Courier Pricing — https://www.courier.com/pricing
16. Courier Docs, Inbox Overview — https://www.courier.com/docs/platform/inbox/inbox-overview
17. SuprSend Enterprise — https://www.suprsend.com/enterprise
18. SuprSend Docs, Security — https://docs.suprsend.com/docs/security
19. SuprSend Pricing — https://www.suprsend.com/pricing
20. SuprSend Docs, React Inbox — https://docs.suprsend.com/docs/inbox-react
21. MagicBell Trust Centre — https://www.magicbell.com/security
22. MagicBell Docs, React — https://www.magicbell.com/docs/libraries/react
23. MagicBell Pricing — https://www.magicbell.com/pricing
24. Pingram (ex NotificationAPI) Startseite — https://www.notificationapi.com/
25. NotificationAPI Blog, React 19 Support — https://www.notificationapi.com/blog/react-19-support
26. Pingram Pricing — https://www.notificationapi.com/pricing
27. React Router Docs, Resource Routes — https://reactrouter.com/how-to/resource-routes
