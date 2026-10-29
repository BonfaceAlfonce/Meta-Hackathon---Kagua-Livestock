# Kagua Livestock

**AI-powered poultry monitoring that sees, reasons and alerts — built for farmers across Africa.**

Kagua combines low-cost ESP32 sensors and cameras with Meta's AI models to detect environmental hazards and early signs of flock distress, then alerts farmers wherever they are — even when the farm is hours away.

> Built for the **Meta Global AI Developer Hackathon** (Oct 27 – Nov 4, 2026).

---

## The problem

The first weeks of a chick's life are the riskiest and most expensive period in poultry farming. Losses come from:

- **Unstable temperature and humidity** — chicks are highly sensitive; small swings cause heat stress, huddling and death.
- **Ammonia build-up** — poor ventilation causes respiratory distress and stunted growth before signs are visible.
- **Late detection of abnormal behaviour** — lethargy, clustering, or reduced feeding are noticed too late.
- **Remote farm owners** — no real-time visibility when they are away from the farm.

## The solution

| Layer | What it does |
|---|---|
| **Sense** | ESP32 devices stream temperature, humidity, ammonia and CO2 readings plus camera snapshots. |
| **Store** | Supabase stores telemetry, snapshots and alerts per farm, secured with Row Level Security. |
| **Understand** | Meta's Muse Spark analyses sensor trends and camera images to identify risks (e.g. chick crowding = heat/cold stress). |
| **Alert** | Farmers receive alerts on WhatsApp/SMS and see live data on the dashboard. |
| **Protect the region** | Anonymised alerts across farms reveal emerging disease clusters by county. |

---

## Project status

To comply with the hackathon's *new work only* rule, work is clearly separated.

### ✅ Pre-hackathon baseline (tag `v0-baseline`)
- React + Vite farm dashboard (overview, readings, records, photos, packages, settings)
- Supabase multi-farm schema: farms, members/roles, zones, devices, telemetry, camera snapshots, alert rules, alerts, notification preferences, reports, subscriptions
- Row Level Security on all tables; hashed device credentials in a private schema
- Realtime updates for telemetry, alerts and snapshots
- Demo seed data

### 🚧 Built during the hackathon
| Feature | Meta model | Status |
|---|---|---|
| AI analysis of sensor readings + camera snapshots | Muse Spark | Planned |
| Flock behaviour detection (huddling, spreading, immobile birds) | SAM 3.1 + Muse Spark | Planned |
| WhatsApp / SMS alerts | — | Planned |
| Regional disease early warning (anonymised cross-farm clusters) | Muse Spark | Planned |

_Update this table as features ship. Each feature links to its pull request._

---

## Architecture

```
ESP32 sensors + camera
        │  (Edge Function ingestion, device token)
        ▼
   Supabase (Postgres · Storage · Realtime · RLS)
        │
        ├──► React dashboard (live readings, alerts, photos)
        │
        └──► AI layer (Meta Model API)
               ├─ Muse Spark: sensor + image analysis → farm_alerts
               ├─ SAM 3.1: flock segmentation
               └─ Regional early warning → regional_signals
                        │
                        ▼
               WhatsApp / SMS alerts
```

## Tech stack

- **Frontend:** React, Vite, lucide-react
- **Backend:** Supabase (PostgreSQL, Auth, Storage, Realtime, Edge Functions)
- **AI:** Meta Model API — Muse Spark, SAM 3.1
- **Hardware:** ESP32 microcontrollers, temperature/humidity/ammonia/CO2 sensors, camera modules
- **Automation:** n8n
- **Alerts:** WhatsApp, SMS

---

## Getting started

### Prerequisites
- Node.js 18+ and pnpm (or npm)
- A Supabase project

### 1. Clone and install
```bash
git clone https://github.com/BonfaceAlfonce/Meta-Hackathon---Kagua-Livestock.git
cd Meta-Hackathon---Kagua-Livestock
pnpm install
```

### 2. Configure environment
```bash
cp .env.example .env
```
Fill in:
```
VITE_SUPABASE_URL=your-project-url
VITE_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
```
> Never put service-role keys, device secrets, WhatsApp tokens or Meta API keys in `VITE_` variables — they are exposed to the browser. Server-side secrets belong in Supabase Edge Function secrets.

### 3. Set up the database
In the Supabase SQL Editor, run the **entire** file:
```
supabase/migrations/20261026000000_farm_monitoring_schema.sql
```
See `supabase/SQL_EDITOR_ORDER.md` for details, then optionally load demo data from `supabase/demo_seed_*.sql`.

### 4. Run
```bash
pnpm dev
```

---

## Database overview

| Table | Purpose |
|---|---|
| `farms`, `farm_members` | Multi-farm tenancy and roles (owner, admin, operator, viewer) |
| `farm_zones`, `animal_groups`, `farm_animals` | Farm layout and livestock |
| `sensor_devices`, `telemetry_events` | Devices and time-series readings |
| `camera_snapshots` | Images in private storage, with `ai_summary` / `ai_labels` |
| `alert_rules`, `farm_alerts` | Threshold rules and generated alerts |
| `notification_preferences` | In-app, web push, WhatsApp (with consent) and email |
| `farm_reports`, `farm_subscriptions` | Reports and service packages |

## Security
- Row Level Security on every public table; users only see farms they belong to.
- Device credentials stored as hashes in a non-exposed schema.
- WhatsApp alerts require recorded consent.
- Cross-farm features expose aggregates only, never another farm's data.

---

## Team

| Name | Role |
|---|---|
| Bonface Alfonce | Project lead · hardware, backend, dashboard |
| Jean-Claude Adjanohoun | AI integration · regional early warning |
| Soumyajit Das | AI · computer vision |

## Roadmap
- Poultry MVP → cattle, goats, sheep
- Offline-first alerts for low-connectivity farms
- Local-language voice alerts

## License
MIT
