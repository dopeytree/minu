# minu

A blank page for an Unraid server. Each Docker container, each VM, and the server itself is a scribble drawn on the GPU. The living ones dance. The ink changes when a machine is down, or when ping does not come back.

## Run

```sh
node server.js
```

Open http://127.0.0.1:8787

The address and API key live in `config.json` on this machine. The page never receives the key. Copy `config.example.json` if you need the shape. You can also set them from the pebble in the corner.

To create a key: Unraid → Settings → Management Access → API Keys. Reading the room needs Docker, VM, and dashboard access. Starting and stopping needs update access too.

The drawing talks to `https://<server>/graphql` (the Unraid API, shipped with Unraid Connect). Self-signed certificates are accepted for that host only.

By default the site listens on localhost. `HOST=0.0.0.0` shares it on the LAN — anyone who can open it can also start and stop machines, because the key stays on the server.

`config.json` is gitignored. Leave it that way.

## Install

**Unraid:** add `unraid/minu.xml` as a template (Docker, Add Container), press Apply. **Anything else:** `docker compose up -d` with `docker-compose.yml`.

1. Open the container's log. On the first start it prints your sign-in key once. Keep it in a password manager.
2. Open `http://<server>:8787`, paste the key, then open settings and enter your Unraid address and API key (Unraid, Settings, Management Access, API Keys). Or give them as `MINU_UNRAID_URL` and `MINU_UNRAID_KEY`.
3. Optional: add a passkey (Touch ID and the like) from settings. Passkeys need https and a hostname, see below.

The image is built and published by `.github/workflows/docker.yml` on every push to `main`.

## Signing in

`node server.js set-passcode` makes a random key and shows it once. Sign in with it, then open settings and choose **add a passkey to this device** to use Touch ID / Face ID / a security key from then on. The key stays as the way back in.

Passkeys are a browser rule: the page must be on **https** (or `localhost`) and reached by a **hostname, not an IP address**. Behind a reverse proxy or Tailscale, set `MINU_ORIGIN=https://minu.example.ts.net` so the address is known exactly. `node server.js list-passkeys` and `clear-passkeys` manage them.
