# MiSonos UX11

Modern TypeScript Sonos controller targeting fast LAN control first and Capacitor packaging later.

## Architecture

- `apps/web`: React + Vite controller UI.
- `apps/bridge`: local Node TypeScript LAN bridge for SSDP discovery and Sonos SOAP calls.
- `packages/sonos-protocol`: shared Sonos models plus SOAP/DIDL/XML helpers.

The web app talks to the bridge through a typed HTTP/SSE API. That boundary is intended to survive the later Capacitor phase, where a native LAN transport can replace the local Node bridge.

## Local Development

```sh
npm install
npm run dev
```

The bridge listens on port `4317` and the web app defaults to `http://127.0.0.1:6173`.
For Sonos event subscriptions, the bridge binds to `0.0.0.0` by default so speakers can reach its callback endpoint.

If multicast discovery is unavailable, set known speakers manually:

```sh
MISONOS_SPEAKER_IPS=192.168.1.101,192.168.1.102 npm run dev:bridge
```

If event subscriptions fail because the bridge chooses the wrong local network interface, set the callback address explicitly:

```sh
MISONOS_CALLBACK_HOST=192.168.1.50 npm run dev:bridge
```

## Checks

```sh
npm run typecheck
npm run test
npm run build
```
