# zen-gateway

[English](README.en.md) | [中文](README.md)

zen-gateway is a local gateway for [OpenCode Zen](https://opencode.ai/zen). It
accepts OpenAI-compatible Chat Completions and Responses requests and Anthropic
Messages requests, forwards only models that its rules treat as free, and sends each
request through a Worker bound to a direct, proxy or Clash egress.

It is a single-user tool. The upstream is fixed to Zen, the gateway listens only on
loopback, and the admin console can be opened to the LAN after setting an access
password. It is not a multi-tenant service or a general provider platform. Request
bodies are forwarded as raw bytes; the gateway parses only the fields it needs for
routing, model checks and stream events.

The detailed documentation, the admin console and the project rules are in Chinese.
This page is an overview only.

## Quick start

Requires Node.js 24 or later.

```bash
npm install
npm start      # build and start; admin console at http://127.0.0.1:5173
npm run open   # optional: open the admin console in a browser
```

The gateway port (default 9876) serves only `/health`, `/v1/*`, unprefixed protocol
aliases and `/api/*`. On first start the gateway creates `data/config.json` and a
Relay Token. Add Workers in the admin console: authenticated Workers use your own Zen
API key, anonymous Workers send no upstream credential. Client setup for OpenCode 1.x
and 2.x is in [`docs/usage.md`](docs/usage.md#客户端接入).

## Features

- Three protocol surfaces: `/v1/chat/completions`, `/v1/responses` and
  `/v1/messages`, plus aliases without the `/v1` prefix.
- Free-model rules: a model suffix plus an explicit allow list, intersected with the
  live upstream catalog when it is available.
- Worker scheduling with session affinity, cooldown after failures and bounded
  retries; the client's Relay Token is never forwarded upstream.
- Per-Worker egress (direct, HTTP/SOCKS proxy or Clash), with probes that report
  which Workers share a public IP.
- Admin console for setup, Workers, egress, client config, models, usage and
  diagnostics. Credentials are shown only as "present + fingerprint".

## Development

Every change runs the same gate locally and in CI:

```bash
npm run validate
```

It covers a sensitive-file check, type checks, builds and the full test suite. Tests
run offline: an import hook makes any outbound network access fail, and upstreams are
replaced by local fake servers. CI uses no repository secrets. Contribution rules are
in [`AGENTS.md`](AGENTS.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md); report security
issues privately as described in [`SECURITY.md`](SECURITY.md).

## Documentation (Chinese)

- [`docs/usage.md`](docs/usage.md): installation, configuration, API, egress and troubleshooting.
- [`docs/requirements.md`](docs/requirements.md): scope and acceptance matrix.
- [`docs/architecture.md`](docs/architecture.md): modules and request flow.
- [`docs/upstream-quirks.md`](docs/upstream-quirks.md): dated observations of upstream behavior.

## License

[MIT](LICENSE).
