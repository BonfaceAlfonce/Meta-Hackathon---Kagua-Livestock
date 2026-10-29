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
| **Outbreak Shield**: outbreak detection, spread tracking and anonymised regional warning ([details](#outbreak-shield)) | Muse Spark (`muse-spark-1.3`) | Built, in review |

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
               └─ Outbreak Shield (Muse Spark explanations)
                    → outbreak_assessments, regional_signals
                        │
                        ▼
               WhatsApp / SMS alerts
```

## Outbreak Shield

Early warning when flock signs suggest a **contagious outbreak**, on the farm and in the surrounding county.

1. **Detect.** Each zone gets a daily risk level (`none` / `low` / `medium` / `high`) from deterministic rules in code: deaths against the zone's own 7-day baseline, feed and water intake, sensor activity, and reported breathing problems. High risk requires a mortality spike plus at least one other signal.
2. **Track spread.** When two or more zones of a farm reach medium or higher within 2 days, the page shows the order they were hit.
3. **Warn the region.** When 3 or more farms in a county show warning signs within 7 days, every farm in that county sees an anonymous warning. Farms are never named; a database `CHECK` constraint rejects any regional row for fewer than 3 farms.
4. **Explain with Muse Spark.** Medium and high results get a plain-language explanation, a short farmer message and a vet summary.

Checks run when a farmer saves a daily flock log, when someone presses **Run check**, and automatically every hour (Supabase Cron).

### Meta AI usage

**Every model this project calls at runtime is a Meta model.** Outbreak Shield calls exactly one: **Muse Spark (`muse-spark-1.3`) through the Meta Model API** (`https://api.meta.ai/v1/chat/completions`).

| Call | When | Input | Output (strict JSON schema) |
|---|---|---|---|
| Zone explanation | Each zone whose result is medium or high **and changed** since the last run | The zone's computed signals (numbers only, no farm IDs) | `explanation`, `farmerMessage`, `vetSummary` |
| Regional summary | Each new or changed county warning | County aggregates only | `summary` |

- Client: `supabase/functions/_shared/museSpark.ts` (strict `json_schema` output, timeouts, retries only on 429/500/503). Called from the `outbreak-shield` Edge Function; the key never reaches the browser.
- **Code decides the risk; Muse Spark only explains it.** Every answer is validated in code: length limits plus a guardrail that rejects disease names, drugs and treatment advice. If a call fails or is rejected, a built-in template is shown instead and the card is labelled accordingly.
- The page labels AI text **"Explained by Muse Spark"**, and each run reports how many explanations were generated.

### Setup (after the base schema)

1. **Database:** apply the migrations in order (`npx supabase db push`, or run each file in the SQL Editor):
   - `20261028000000_outbreak_shield.sql` (tables, RLS, privacy constraint)
   - `20261029000000_outbreak_shield_schedule.sql` (hourly job; enables `pg_cron` and `pg_net`)
2. **Secrets** for the Edge Function:
   ```bash
   npx supabase secrets set OUTBREAK_CRON_SECRET=<random, 16+ characters>
   npx supabase secrets set MODEL_API_KEY=<Meta Model API key>
   ```
3. **Deploy:**
   ```bash
   npx supabase functions deploy outbreak-shield --use-api --no-verify-jwt
   ```
   `--no-verify-jwt` is intentional: the function checks either the cron secret or the user's token and farm role itself.
4. **Hourly schedule:** add two Vault secrets (Dashboard → Integrations → Vault): `outbreak_shield_url` = `https://<project-ref>.supabase.co`, and `outbreak_cron_secret` = the same value as `OUTBREAK_CRON_SECRET`. Until both exist, the job does nothing.
5. **Demo data (sandbox only):** set your login email in `supabase/demo_seed_outbreak_shield.sql`, run it, then call the function for yesterday and today.

### Tests
```bash
npm test
```
Node's built-in test runner covers scoring, spread and regional aggregation, the Muse Spark client, guardrails and fallbacks, and the page's view logic.

> Outbreak Shield flags unusual patterns for follow-up. It does not diagnose disease or recommend treatment.

---

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
See `supabase/SQL_EDITOR_ORDER.md` for details, then optionally load demo data from `supabase/demo_seed_*.sql`. For Outbreak Shield, also apply the later migrations; see [Outbreak Shield setup](#setup-after-the-base-schema).

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
| Jean-Claude Adjanohoun | Outbreak Shield · Muse Spark integration |
| Soumyajit Das | AI · computer vision |

## Roadmap
- Poultry MVP → cattle, goats, sheep
- Offline-first alerts for low-connectivity farms
- Local-language voice alerts

## License
MIT
