# WhatsApp Connection API

A small, UI-free HTTP service for maintaining multiple WhatsApp Web connections with Baileys. Credentials and Signal keys are stored in PostgreSQL, and accounts reconnect after service restarts or transient disconnects.

> Baileys is an unofficial WhatsApp Web client. Use it only for accounts you control and follow WhatsApp's terms. It is not the official WhatsApp Business Cloud API.

## Run

Requires Node.js 20 or newer and PostgreSQL.

```bash
npm install
```

Create a dedicated database and user, then set the environment variables. The application automatically creates `whatsapp_sessions` and `whatsapp_auth_keys`; the database user therefore needs permission to create tables and indexes on the target database. This project does not load `.env` files automatically.

```bash
DATABASE_URL="postgresql://waconnect:password@localhost:5432/waconnect" \
API_KEY="a-long-random-secret" PORT=3000 npm start
```

On PowerShell:

```powershell
$env:API_KEY = "a-long-random-secret"
$env:DATABASE_URL = "postgresql://waconnect:password@localhost:5432/waconnect"
npm start
```

## API

Every `/v1` request requires `X-API-Key`. `/health` is public for load balancer health checks.

Create an account connection:

```bash
curl -X POST http://localhost:3000/v1/sessions \
  -H "X-API-Key: a-long-random-secret" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"support-account"}'
```

Fetch the QR payload until it is available, then render that string as a QR code in the consuming application:

```bash
curl http://localhost:3000/v1/sessions/support-account/qr \
  -H "X-API-Key: a-long-random-secret"
```

Alternatively request a phone pairing code (country code included, digits only):

```bash
curl -X POST http://localhost:3000/v1/sessions/support-account/pairing-code \
  -H "X-API-Key: a-long-random-secret" \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber":"919876543210"}'
```

Other routes:

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/health` | Service health |
| `GET` | `/v1/sessions` | List connection states |
| `GET` | `/v1/sessions/:id` | Read one connection state |
| `POST` | `/v1/sessions/:id/reconnect` | Force a reconnect |
| `DELETE` | `/v1/sessions/:id` | Log out and delete credentials |
| `DELETE` | `/v1/sessions/:id?logout=false` | Delete local credentials without requesting WhatsApp logout |

Status values include `connecting`, `waiting_for_qr_scan`, `connected`, `reconnecting`, `registration_failed`, and `logged_out`.

## Server deployment

- Serve the API behind HTTPS (a reverse proxy or managed load balancer).
- Keep `API_KEY` secret and never put it in browser-side code.
- Back up the database and restrict access to it: it contains credentials that control the linked WhatsApp accounts.
- Run one application replica for now. PostgreSQL makes auth updates durable, but distributed session ownership locking is still required before multiple replicas can safely run the same WhatsApp account.
- Enable `DATABASE_SSL=true` when required by your managed PostgreSQL provider.
- The two auth tables should only be accessed by this service. Never expose their contents through an API.

## Docker

Build the production image:

```bash
docker build -t waconnect:latest .
```

Run it directly:

```bash
docker run -d \
  --name waconnect \
  --restart unless-stopped \
  --init \
  -p 3000:3000 \
  -e API_KEY="a-long-random-secret" \
  -e DATABASE_URL="postgresql://waconnect:password@database:5432/waconnect" \
  waconnect:latest
```

For local Docker Compose, create an untracked `.env` file containing `API_KEY` and `DATABASE_URL`, then run:

```bash
docker compose up -d --build
```

The image runs as the non-root `node` user, contains production dependencies only, and checks `/health` every 30 seconds. WhatsApp credentials live in PostgreSQL, so the application container does not need a persistent volume.

## EasyPanel deployment

1. Create an **App** service connected to this repository and choose **Dockerfile** as the build method. EasyPanel should find the root-level `Dockerfile` automatically.
2. Configure these environment variables:

   ```text
   NODE_ENV=production
   HOST=0.0.0.0
   PORT=3000
   API_KEY=<long-random-secret>
   DATABASE_URL=<postgresql-connection-string>
   DATABASE_SSL=false
   DATABASE_POOL_MAX=10
   LOG_LEVEL=info
   ```

3. Set the application/container port to `3000` and attach the desired public HTTPS domain.
4. Use `/health` as the health-check path if EasyPanel asks for one. The Docker image also contains its own health check.
5. Keep the replica count at **1**. Running the same WhatsApp session on multiple replicas is unsafe until distributed session ownership locking is added.

On every container start, the application idempotently creates any missing database tables and restores saved WhatsApp connections. Do not add the database password or API key to the Dockerfile, repository, or image build arguments; keep both in EasyPanel's environment/secret settings.
