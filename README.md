# MiSonos UX11

Modern TypeScript Sonos controller targeting fast LAN control.

## Screenshots

<!-- Drop PNGs into docs/screenshots/ with these names (see docs/screenshots/README.md). -->

| | | |
| :---: | :---: | :---: |
| ![Now playing](docs/screenshots/now-playing.jpg)<br>**Now playing** | ![Zones](docs/screenshots/now-playing-zones.jpg)<br>**Zones** | ![Browse music](docs/screenshots/music-browse.jpg)<br>**Browse music** |
| ![Zone editor](docs/screenshots/zone-editor.jpg)<br>**Zone editor** | ![EQ editor](docs/screenshots/eq-editor.jpg)<br>**EQ editor** | |

## Architecture

- `apps/web`: React + Vite controller UI.
- `apps/bridge`: local Node TypeScript LAN bridge for SSDP discovery and Sonos SOAP calls.
- `packages/sonos-protocol`: shared Sonos models plus SOAP/DIDL/XML helpers.

The web app talks to the bridge through a typed HTTP/SSE API. That boundary keeps the UI decoupled from the transport, so a native LAN transport could replace the local Node bridge without changing the web app.

## Installation

MiSonos runs the whole stack (bridge + SMAPI sources + web PWA) on a host on your LAN. See **[DEPLOY.md](DEPLOY.md)** for the full setup — either Docker on a Linux host or native Node on any host (including macOS).

To install the app to your phone's home screen, you need HTTPS (the PWA service worker won't install over plain `http://`). The simplest way is [Tailscale](https://tailscale.com): on the host, run `tailscale serve --bg <web-port>` (`6173` for Docker, `4173` for native), then open `https://<host>.<tailnet>.ts.net` on your phone and use "Add to Home Screen". See [DEPLOY.md](DEPLOY.md) for details.

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

## License

MiSonos is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE.md):
free to use, modify, and share for any **noncommercial** purpose. See [LICENSE.md](LICENSE.md)
for the full terms and [NOTICE](NOTICE) for attributions and trademark disclaimers.

MiSonos is an independent, fan-made project and is not affiliated with or endorsed by
Sonos, Google/YouTube, Apple, the Internet Archive, or any artist or service it
interoperates with.
