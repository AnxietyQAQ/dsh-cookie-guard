# dsh-cookie-guard

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![deps: none](https://img.shields.io/badge/dependencies-none-success.svg)](package.json)
[![tests: 22 assertions](https://img.shields.io/badge/tests-22%20assertions-success.svg)](test/run.mjs)

Stop the DSH desktop **"crash on the 72nd launch"** — the `dsh-auth` cookie pile-up that ends in
`Web authentication failed`. 修复 DSH 桌面版「第 72 次打开必崩」的问题。

A zero-dependency Cordis plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
it raises the host's HTTP header budget so a bloated-but-valid `Cookie` header is never rejected,
and it expires the `dsh-auth-*` cookies that dead ports left behind.

---

## The bug / 问题是什么

Every DSH desktop launch serves the UI on `127.0.0.1:<random port>` and authenticates it with a
`dsh-auth-<sha256(host:port)>` cookie (`@deepseek-ai/dsh-client-connection` → `cookieName()` /
`authorizeIndex`). The cookie is persistent (`Max-Age`, `Path=/`) and **never** cleaned up.

Because the port is random every launch (`dsh-desktop-host` passes `--port 0`), each start mints a
**new cookie name**. At roughly 71 cookies the `Cookie` request header passes Node's default 16 KB
`maxHeaderSize`; Node rejects the request with **431 before any JavaScript runs**, and Electron's main
process only sees `Web authentication failed`. Reinstalling or switching accounts cannot help.

Measured on a real host: `16,630 B / 66 cookies → 431`, `15,118 B / 60 cookies → 401` (the normal
auth path). The threshold is exactly `16,384` bytes.

## What it does / 怎么修

The plugin joins the web server (`inject: ["webServer"]`) and does two things:

1. **Raise the header budget** — sets the listener's `server.maxHeaderSize` to 128 KB (configurable,
   16384–1048576). A legitimate-but-bloated cookie header now reaches the real auth check instead of
   being stopped at the parser, so DSH starts even with 90 cookies queued up.
2. **Expire zombie cookies** — each `dsh-auth-*` value is `v1.<b64url({authority,issuedAt,expiresAt})>.<sig>`.
   The plugin reads the unsigned `authority` from the payload and compares it with the request's own
   authority. For a *foreign* authority it emits `Set-Cookie: <name>=; Max-Age=0; Path=/` **only after a
   loopback TCP probe proves that port is no longer listening**.

Design constraints, deliberately:

- **No signature check** — only the `authority` field is read, so no secret is needed or touched.
- **Never kills a live instance** — the probe is a real `connect()`; a concurrent instance's cookie is kept.
  The first request that sees an unknown port keeps the cookie while the probe settles.
- **Leaves what it cannot parse alone** — any `dsh-auth-*` value that is not `v1.*` is never touched.
- **Never changes routing** — it wraps `res.writeHead` and *merges* `set-cookie`, so a route's own 303
  redirect and its own cookie survive.
- **Zero dependencies**, and every step is wrapped in `try/catch`: a failure can never break boot.

## Install / 安装

### Official route (published package)

```bash
dsh plugin --profile desktop add dsh-cookie-guard
```

### Local checkout (no pnpm needed)

```bash
git clone https://github.com/Lycor/dsh-cookie-guard.git
cd dsh-cookie-guard
node scripts/install.mjs                 # installs into ~/.dsh/profiles/desktop
node scripts/install.mjs --profile web   # or another profile
node scripts/install.mjs --uninstall     # remove it again
```

The script copies the package into `<profile>/node_modules/dsh-cookie-guard`, then appends a mount row to
`<profile>/cordis.patch.yml` (backing the file up first). Use `--dry-run` to preview.

### Manual

Copy this directory to `~/.dsh/profiles/<profile>/node_modules/dsh-cookie-guard` and append to the
profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: cookie-guard
      name: dsh-cookie-guard
      config:
        maxHeaderSize: 131072
        cleanStale: true
        log: true
```

> **The `- insert:` wrapper is mandatory.** A bare `- id: … / name: …` row at the top level is silently
> treated as an override of an existing plugin and is ignored when that id does not exist — no error, no
> plugin. Verify with `dsh --profile web --patch <that file> --dump-config | grep cookie-guard`:
> the bare form yields nothing, the `insert` form yields the row.

**Restart DSH** after installing.

## Verify / 验证

`log: true` writes one line on activation:

```
[cookie-guard] active: header budget raised from 16384 to 131072 bytes
```

Offline suite (real `node:http` server, production-shaped cookies, 22 assertions):

```bash
npm test
```

Live check against a running host — send ~18 KB of dead-port cookies and look for `401` instead of `431`,
then for `Set-Cookie: … Max-Age=0` on the next request:

| Probe | Without plugin | With plugin |
| --- | --- | --- |
| 18,078 B / 80 cookie header | `431` (empty body) | `401`, then `401` + 80 deletions |
| `GET /?token=…` | `303` + cookie | `303` + cookie (unchanged) |

## Config / 配置

| Key | Default | Meaning |
| --- | --- | --- |
| `maxHeaderSize` | `131072` | Header budget in bytes for the listener (16384–1048576) |
| `cleanStale` | `true` | Expire `dsh-auth-*` cookies of ports that no longer listen |
| `log` | `true` | Log activation and cleanup |

## Uninstall / 卸载

Remove the `- insert:` block from `cordis.patch.yml`, delete
`<profile>/node_modules/dsh-cookie-guard`, restart DSH — or run `node scripts/install.mjs --uninstall`.

If DSH is already stuck and you just need to get in: quit DSH fully and rename
`%APPDATA%\@deepseek-ai\dsh-desktop\Network\Cookies` (it is recreated on the next launch).

## Limits / 已知限制

- The plugin runs in the **Host child process**, so it fixes the *server* side. That covers Electron, the
  in-app browser and any external browser, but it never touches Electron's cookie database directly —
  cleanup happens on the next request, not at boot.
- Only loopback authorities (`127.0.0.1`, `::1`, `localhost`) are probed; anything else is preserved.
- This is containment, not the upstream fix. The real fix is for `dsh-desktop-host` to stop using
  `--port 0` (a stable port overwrites one cookie instead of adding one), or for
  `dsh-client-connection` to garbage-collect `dsh-auth-*`. This plugin modifies **no** shipped files,
  so it survives DSH upgrades and is removed cleanly.
- A plugin-manager reinstall may rebuild `node_modules` and drop the copied package; re-run
  `node scripts/install.mjs` afterwards.

## License

[MIT](LICENSE)
