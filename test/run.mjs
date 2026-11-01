/**
 * Offline verification for dsh-cookie-guard against a real node:http server.
 * Run: node test/run.mjs
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request } from "node:http";

import { apply, Config, inject, name } from "../lib/index.js";

const b64url = (value) => Buffer.from(value).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");

/** Mint a dsh-auth cookie value exactly the way dsh-client-connection does. */
function mintCookieValue(authority) {
	const payload = {
		version: 1,
		authority,
		issuedAt: Date.now(),
		expiresAt: Date.now() + 30 * 86400_000,
	};
	const signature = createHash("sha256").update(`signature-for:${authority}`).digest();
	return `v1.${b64url(JSON.stringify(payload))}.${b64url(signature)}`;
}

/** Production cookie name: dsh-auth- + base64url(sha256(authority)). */
const cookieNameFor = (authority) => `dsh-auth-${b64url(createHash("sha256").update(authority).digest())}`;

function cookieHeaderFor(authorities) {
	return authorities.map((authority) => `${cookieNameFor(authority)}=${mintCookieValue(authority)}`).join("; ");
}

const fakeContext = (server, protocol = "http:") => {
	const logs = [];
	const disposers = [];
	return {
		logs,
		ctx: {
			webServer: { server, protocol },
			logger: {
				info: (line) => logs.push(["info", line]),
				warn: (line) => logs.push(["warn", line]),
				error: (line) => logs.push(["error", line]),
			},
			effect: (callback) => {
				const dispose = callback();
				disposers.push(dispose);
				return dispose;
			},
		},
		disposeAll: () => disposers.reverse().forEach((dispose) => dispose?.()),
	};
};

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

function get(port, { path = "/", cookie, method = "GET" } = {}) {
	return new Promise((resolve, reject) => {
		const headers = {};
		if (cookie !== undefined) headers.cookie = cookie;
		const req = request({ host: "127.0.0.1", port, path, method, headers, agent: false }, (res) => {
			let body = "";
			res.on("data", (chunk) => {
				body += chunk;
			});
			res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
		});
		req.on("error", reject);
		req.end();
	});
}

const lines = (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
const cookieNames = (setCookie) =>
	lines(setCookie)
		.map((line) => line.split(";")[0].split("=")[0])
		.filter((cookieName) => cookieName.length > 0);

let passed = 0;
function ok(label, condition, detail) {
	assert.ok(condition, detail === undefined ? label : `${label}: ${detail}`);
	passed += 1;
	console.log(`  ok  ${label}`);
}

// ---------------------------------------------------------------------------
// 1. module shape
// ---------------------------------------------------------------------------
ok("plugin exports a name", name === "cookie-guard");
ok("plugin injects webServer", inject.includes("webServer"));
ok("config rejects an out-of-range header budget", Config["~standard"].validate({ maxHeaderSize: 10 }).issues !== undefined);
ok("config accepts defaults omission", Config["~standard"].validate(undefined).value.maxHeaderSize === 131072);

// ---------------------------------------------------------------------------
// 2. the crash itself: 70 accumulated cookies => 431 without the guard
// ---------------------------------------------------------------------------
const deadAuthorities = Array.from({ length: 80 }, (_, index) => `127.0.0.1:${9000 + index}`);
const bloated = cookieHeaderFor(deadAuthorities);

const bare = createServer((req, res) => {
	res.writeHead(200, { "content-type": "text/plain" });
	res.end("served");
});
const barePort = await listen(bare);
const bareResponse = await get(barePort, { cookie: bloated });
ok(
	"unpatched listener rejects the bloated cookie header with 431",
	bareResponse.status === 431,
	`status ${bareResponse.status}, header ${Buffer.byteLength(bloated)} bytes`,
);
bare.close();

// ---------------------------------------------------------------------------
// 3. with the guard: same request is served, then stale cookies are expired
// ---------------------------------------------------------------------------
const app = createServer((req, res) => {
	if (req.url === "/mint") {
		res.writeHead(303, { location: "./", "set-cookie": `${cookieNameFor("current")}=fresh; Path=/; HttpOnly` });
		res.end();
		return;
	}
	res.writeHead(200, { "content-type": "text/plain" });
	res.end("served");
});
const appPort = await listen(app);
const guard = fakeContext(app);
apply(guard.ctx, undefined);

// A cookie minted for this very listener must never be expired.
const currentAuthority = `127.0.0.1:${appPort}`;
const currentCookie = `${cookieNameFor(currentAuthority)}=${mintCookieValue(currentAuthority)}`;

const first = await get(appPort, { cookie: `${currentCookie}; ${bloated}` });
ok("guarded listener serves the request instead of 431", first.status === 200, `status ${first.status}`);
ok("first response carries no deletion yet (ports still being probed)", cookieNames(first.headers["set-cookie"]).length === 0);

// Let the loopback probes settle, then the next response retires the dead ones.
await new Promise((resolve) => setTimeout(resolve, 250));
const second = await get(appPort, { cookie: `${currentCookie}; ${bloated}` });
const deletions = cookieNames(second.headers["set-cookie"]);
ok("stale cookies of dead authorities are expired", deletions.length === deadAuthorities.length, `expired ${deletions.length}`);
ok("the current authority's cookie is preserved", !deletions.includes(cookieNameFor(currentAuthority)));
ok("deletions are Max-Age=0 with Path=/", lines(second.headers["set-cookie"]).every((line) => line.includes("Max-Age=0") && line.includes("Path=/")));

// ---------------------------------------------------------------------------
// 4. a live instance keeps its cookie
// ---------------------------------------------------------------------------
const livePeer = createServer((req, res) => res.end("peer"));
const livePeerPort = await listen(livePeer);
const liveCookie = `${cookieNameFor(`127.0.0.1:${livePeerPort}`)}=${mintCookieValue(`127.0.0.1:${livePeerPort}`)}`;
const probeRound = await get(appPort, { cookie: `${currentCookie}; ${liveCookie}` });
await new Promise((resolve) => setTimeout(resolve, 250));
const liveRound = await get(appPort, { cookie: `${currentCookie}; ${liveCookie}` });
ok(
	"a cookie from a still-listening instance is never expired",
	cookieNames(liveRound.headers["set-cookie"]).length === 0,
	`first ${cookieNames(probeRound.headers["set-cookie"]).length} / second ${cookieNames(liveRound.headers["set-cookie"]).length}`,
);
livePeer.close();

// ---------------------------------------------------------------------------
// 5. the route's own set-cookie survives next to the deletions
// ---------------------------------------------------------------------------
const mintRound = await get(appPort, { path: "/mint", cookie: `${currentCookie}; ${bloated}` });
const mintNames = cookieNames(mintRound.headers["set-cookie"]);
ok("route set-cookie is merged, not replaced", mintNames.includes(cookieNameFor("current")), mintNames.join(","));
ok("deletions ride along with the route's own cookie", mintNames.length > 1, `names ${mintNames.length}`);
ok("redirect status is untouched", mintRound.status === 303, `status ${mintRound.status}`);

// ---------------------------------------------------------------------------
// 6. unknown value formats and unrelated cookies are left alone
// ---------------------------------------------------------------------------
const unknown = "dsh-auth-legacy=not-a-v1-value; other=1";
const unknownRound = await get(appPort, { cookie: unknown });
ok("unreadable dsh-auth values are not deleted", cookieNames(unknownRound.headers["set-cookie"]).length === 0);

// ---------------------------------------------------------------------------
// 7. teardown restores the listener and detaches the guard
// ---------------------------------------------------------------------------
guard.disposeAll();
ok("dispose restores the original header budget", app.maxHeaderSize === undefined, String(app.maxHeaderSize));
const afterDispose = await get(appPort, { cookie: bloated });
ok("a disposed guard no longer serves the bloated request", afterDispose.status === 431, `status ${afterDispose.status}`);

app.close();
ok("activation was logged", guard.logs.some(([, line]) => line.includes("cookie-guard") && line.includes("header budget")));

// ---------------------------------------------------------------------------
// 8. plugin lifecycle: apply() waits for the service, then disposes cleanly
// ---------------------------------------------------------------------------
const lateApp = createServer((_req, res) => {
	res.writeHead(200, { "content-type": "text/plain" });
	res.end("ok");
});
const latePort = await listen(lateApp);
const late = fakeContext(undefined);
apply(late.ctx, { maxHeaderSize: 40960, cleanStale: false, log: true });
ok("apply waits while the web server is not exposed yet", lateApp.maxHeaderSize === undefined);

late.ctx.webServer.server = lateApp;
await new Promise((resolve) => setTimeout(resolve, 250));
ok("apply attaches once webServer exposes its server", lateApp.maxHeaderSize === 40960, String(lateApp.maxHeaderSize));

const lateAuthorities = Array.from({ length: 80 }, (_, index) => `127.0.0.1:${9000 + index}`);
const lateRound = await get(latePort, { cookie: cookieHeaderFor(lateAuthorities) });
ok("the applied guard serves the bloated request", lateRound.status === 200, `status ${lateRound.status}`);

late.disposeAll();
ok("disposing the plugin restores the header budget", lateApp.maxHeaderSize === undefined, String(lateApp.maxHeaderSize));
lateApp.close();

console.log(`\n${passed} assertions passed`);
process.exit(0);
