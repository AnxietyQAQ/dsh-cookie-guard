/**
 * dsh-cookie-guard — stop the "第 72 次打开必崩" failure of the DSH desktop app.
 *
 * Every launch the host listens on a fresh ephemeral port, and the browser
 * session cookie is keyed by the request authority (`host:port`), so each launch
 * mints a *new* persistent `dsh-auth-…` cookie instead of refreshing one. After
 * ~65 launches the accumulated `Cookie` request header crosses Node's 16 KiB
 * `maxHeaderSize`, the HTTP parser answers 431 before any application code runs,
 * and the desktop shell can only report "Web authentication failed" — a state no
 * reinstall or account switch can escape.
 *
 * This plugin repairs both halves of the failure from inside the host process:
 *
 * 1. It raises the listener's header budget (`server.maxHeaderSize`), so a
 *    bloated but legitimate cookie header no longer aborts the connection before
 *    authentication can even look at it.
 * 2. It expires the stale `dsh-auth-…` cookies. Each cookie's signed payload
 *    carries the authority it was minted for; every cookie whose authority is a
 *    port that is no longer listening is answered with a `Max-Age=0` deletion
 *    cookie. A port that *is* listening belongs to another running instance, so
 *    its cookie is left alone. The browser jars (desktop, in-app, external) are
 *    therefore self-healing on first load instead of growing forever.
 *
 * Everything is defensive: a failure here never breaks boot.
 */

import { connect } from "node:net";

export const name = "cookie-guard";
export const inject = ["webServer"];

const AUTH_COOKIE_PREFIX = "dsh-auth-";
const COOKIE_PAYLOAD_VERSION_PREFIX = "v1.";
const PROBE_TIMEOUT_MS = 400;
const RETRY_INTERVAL_MS = 100;
const RETRY_LIMIT = 600;

const DEFAULTS = Object.freeze({
	maxHeaderSize: 131072,
	cleanStale: true,
	log: true,
});

/** Options accepted from the profile patch entry. */
export const Config = {
	"~standard": {
		vendor: "dsh-cookie-guard",
		version: 1,
		validate(raw) {
			const issues = [];
			const value = { ...DEFAULTS };
			if (raw !== undefined && raw !== null) {
				if (typeof raw !== "object" || Array.isArray(raw)) {
					issues.push({ message: "cookie-guard config must be an object", path: [] });
				} else {
					for (const [key, input] of Object.entries(raw)) {
						if (!(key in DEFAULTS)) {
							issues.push({ message: `unknown option ${JSON.stringify(key)}`, path: [key] });
							continue;
						}
						if (typeof DEFAULTS[key] === "boolean") {
							if (typeof input !== "boolean") issues.push({ message: `${key} must be a boolean`, path: [key] });
							else value[key] = input;
							continue;
						}
						if (typeof input !== "number" || !Number.isInteger(input) || input < 16384 || input > 1048576) {
							issues.push({ message: `${key} must be an integer between 16384 and 1048576`, path: [key] });
							continue;
						}
						value[key] = input;
					}
				}
			}
			if (issues.length > 0) return { issues };
			return { value };
		},
	},
};

function resolvedConfig(raw) {
	const outcome = Config["~standard"].validate(raw);
	return outcome.issues === undefined ? outcome.value : { ...DEFAULTS };
}

function encodeBase64Url(buffer) {
	return Buffer.from(buffer).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** Mirror of the connection package's strict base64url decoder. */
function decodeBase64Url(text) {
	if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/u.test(text) || text.length % 4 === 1) return undefined;
	const padding = "=".repeat((4 - (text.length % 4)) % 4);
	const decoded = Buffer.from(text.replaceAll("-", "+").replaceAll("_", "/") + padding, "base64");
	return encodeBase64Url(decoded) === text ? decoded : undefined;
}

/**
 * Read the authority baked into one `dsh-auth-…` value (`v1.<payload>.<sig>`).
 * @returns the authority string, or `undefined` when the value is unreadable.
 */
function cookieAuthority(value) {
	if (typeof value !== "string" || !value.startsWith(COOKIE_PAYLOAD_VERSION_PREFIX)) return undefined;
	const parts = value.split(".");
	if (parts.length !== 3 || parts[0] !== "v1") return undefined;
	const body = decodeBase64Url(parts[1]);
	if (body === undefined) return undefined;
	try {
		const payload = JSON.parse(body.toString("utf8"));
		if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
		const authority = payload.authority;
		return typeof authority === "string" && authority.length > 0 ? authority : undefined;
	} catch {
		return undefined;
	}
}

/** The authority the host would mint for this request; mirrors `requestAudience`. */
function requestAuthority(hostHeader, secure) {
	if (typeof hostHeader !== "string" || hostHeader.length === 0) return undefined;
	try {
		const url = new URL(`${secure ? "https:" : "http:"}//${hostHeader}`);
		return secure ? url.origin : url.host;
	} catch {
		return undefined;
	}
}

/** Split a request `Cookie` header down to the `dsh-auth-…` pairs it carries. */
function authCookies(header) {
	if (typeof header !== "string" || !header.includes(AUTH_COOKIE_PREFIX)) return [];
	const found = [];
	for (const segment of header.split(";")) {
		const at = segment.indexOf("=");
		if (at === -1) continue;
		const cookieName = segment.slice(0, at).trim();
		if (!cookieName.startsWith(AUTH_COOKIE_PREFIX)) continue;
		found.push({ name: cookieName, value: segment.slice(at + 1).trim() });
	}
	return found;
}

function loopbackTarget(authority) {
	try {
		const url = new URL(authority.includes("://") ? authority : `http://${authority}`);
		const host = url.hostname.replace(/^\[/u, "").replace(/\]$/u, "");
		if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") return undefined;
		const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
		if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
		return { host, port };
	} catch {
		return undefined;
	}
}

function probePort(target) {
	return new Promise((resolve) => {
		let settled = false;
		const socket = connect({ host: target.host, port: target.port });
		const settle = (alive) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(alive);
		};
		socket.setTimeout(PROBE_TIMEOUT_MS, () => settle(true));
		socket.once("connect", () => settle(true));
		socket.once("error", (error) => settle(error?.code === "ECONNREFUSED" ? false : true));
	});
}

/**
 * Authority liveness, so a cookie belonging to a running instance is never
 * deleted. `undefined` means "not known yet": the probe runs in the background
 * and the caller keeps the cookie for this response.
 */
function createLiveness() {
	const known = new Map();
	const pending = new Set();
	return {
		status(authority) {
			const settled = known.get(authority);
			if (settled !== undefined) return settled;
			if (pending.has(authority)) return undefined;
			const target = loopbackTarget(authority);
			if (target === undefined) return true;
			pending.add(authority);
			probePort(target).then(
				(alive) => {
					pending.delete(authority);
					known.set(authority, alive);
				},
				() => {
					pending.delete(authority);
					known.set(authority, true);
				},
			);
			return undefined;
		},
	};
}

function expiredCookie(cookieName, secure) {
	const attributes = [
		`${cookieName}=`,
		"Max-Age=0",
		"Path=/",
		"Expires=Thu, 01 Jan 1970 00:00:00 GMT",
		"HttpOnly",
		"SameSite=Strict",
	];
	if (secure) attributes.push("Secure");
	return attributes.join("; ");
}

function isCookieHeaderName(name) {
	return typeof name === "string" && name.toLowerCase() === "set-cookie";
}

/** Merge deletion cookies into whatever the route already decided to send. */
function mergeSetCookie(existing, cookies) {
	if (existing === undefined || existing === null) return cookies.slice();
	const values = (Array.isArray(existing) ? existing : [existing]).filter((value) => value !== undefined && value !== null);
	return [...values.map(String), ...cookies];
}

function mergeHeaderObject(headers, cookies) {
	if (Array.isArray(headers)) {
		const output = [];
		let merged = false;
		for (let index = 0; index < headers.length; index += 2) {
			const key = headers[index];
			const value = headers[index + 1];
			if (isCookieHeaderName(key)) {
				output.push(key, mergeSetCookie(value, cookies));
				merged = true;
			} else output.push(key, value);
		}
		if (!merged) output.push("set-cookie", cookies.slice());
		return output;
	}
	const output = {};
	let merged = false;
	for (const key of Object.keys(headers)) {
		if (isCookieHeaderName(key)) {
			output[key] = mergeSetCookie(headers[key], cookies);
			merged = true;
		} else output[key] = headers[key];
	}
	if (!merged) output["set-cookie"] = cookies.slice();
	return output;
}

/**
 * Attach deletion cookies to this response. The header is set eagerly for
 * handlers that rely on an implicit `writeHead`, and `writeHead` is wrapped so a
 * route's own `set-cookie` (the fresh mint) is merged rather than replaced.
 */
function attachCookies(res, cookies) {
	try {
		res.setHeader("set-cookie", mergeSetCookie(res.getHeader("set-cookie"), cookies));
	} catch {
		/* headers already flushed: nothing to attach to */
		return;
	}
	const writeHead = res.writeHead;
	res.writeHead = function patchedWriteHead(statusCode, ...rest) {
		if (rest.length === 0) return writeHead.call(this, statusCode, { "set-cookie": cookies.slice() });
		if (typeof rest[0] === "string") {
			if (rest.length === 1) return writeHead.call(this, statusCode, rest[0], { "set-cookie": cookies.slice() });
			rest[1] = mergeHeaderObject(rest[1] ?? {}, cookies);
			return writeHead.call(this, statusCode, rest[0], rest[1]);
		}
		if (rest.length === 1) return writeHead.call(this, statusCode, mergeHeaderObject(rest[0] ?? {}, cookies));
		return writeHead.apply(this, [statusCode, ...rest]);
	};
}

function createLogger(ctx, enabled) {
	const logger = ctx.logger ?? ctx.root?.logger;
	return (message, level = "info") => {
		if (!enabled) return;
		try {
			const sink = logger?.[level];
			if (typeof sink === "function") sink.call(logger, `[cookie-guard] ${message}`);
			else if (level === "warn" || level === "error") console.warn(`[cookie-guard] ${message}`);
		} catch {
			/* logging must never break a request */
		}
	};
}

function createGuard(ctx, config, log) {
	const liveness = createLiveness();
	let reported = false;
	return function guard(req, res) {
		if (!config.cleanStale) return;
		try {
			const cookies = authCookies(req.headers?.cookie);
			if (cookies.length === 0) return;
			const secure = ctx.webServer?.protocol === "https:";
			const current = requestAuthority(req.headers?.host, secure);
			if (current === undefined) return;
			const stale = [];
			for (const cookie of cookies) {
				const authority = cookieAuthority(cookie.value);
				if (authority === undefined || authority === current) continue;
				if (liveness.status(authority) === false) stale.push(expiredCookie(cookie.name, secure));
			}
			if (stale.length === 0) return;
			if (!reported) {
				reported = true;
				log(`expiring ${String(stale.length)} stale ${AUTH_COOKIE_PREFIX}* cookie(s) left by a previous launch`);
			}
			attachCookies(res, stale);
		} catch (error) {
			log(`skipped one request: ${error instanceof Error ? error.message : String(error)}`, "warn");
		}
	};
}

function installOnServer(ctx, server, config, log) {
	const previousHeaderSize = server.maxHeaderSize;
	let raised = false;
	try {
		server.maxHeaderSize = config.maxHeaderSize;
		raised = server.maxHeaderSize === config.maxHeaderSize;
	} catch {
		raised = false;
	}
	const guard = createGuard(ctx, config, log);
	server.prependListener("request", guard);
	// `maxHeaderSize` is `undefined` by default; the parser then uses Node's 16 KB default.
	const effectiveBefore = typeof previousHeaderSize === "number" ? previousHeaderSize : 16384;
	log(
		raised
			? `active: header budget raised from ${String(effectiveBefore)} to ${String(config.maxHeaderSize)} bytes`
			: `active without a header budget change (server rejected it); cookie cleanup stays on`,
		raised ? "info" : "warn",
	);
	return () => {
		server.removeListener("request", guard);
		if (!raised) return;
		try {
			server.maxHeaderSize = previousHeaderSize;
		} catch {
			/* the listener is going away anyway */
		}
	};
}

export function apply(ctx, rawConfig) {
	const config = resolvedConfig(rawConfig);
	const log = createLogger(ctx, config.log);
	let installed;
	let timer;
	const attempt = () => {
		if (installed !== undefined) return;
		try {
			const server = ctx.webServer?.server;
			if (server === undefined || server === null || typeof server.prependListener !== "function") return;
			installed = installOnServer(ctx, server, config, log);
			if (timer !== undefined) {
				clearInterval(timer);
				timer = undefined;
			}
		} catch (error) {
			log(`could not attach to the http server: ${error instanceof Error ? error.message : String(error)}`, "warn");
		}
	};
	ctx.effect(() => {
		attempt();
		if (installed === undefined) {
			let tries = 0;
			timer = setInterval(() => {
				tries += 1;
				attempt();
				if (installed === undefined && tries >= RETRY_LIMIT) {
					if (timer !== undefined) {
						clearInterval(timer);
						timer = undefined;
					}
					log("webServer never exposed its http server; cookie-guard is inactive", "warn");
				}
			}, RETRY_INTERVAL_MS);
			timer.unref?.();
		}
		return () => {
			if (timer !== undefined) {
				clearInterval(timer);
				timer = undefined;
			}
			if (installed !== undefined) {
				installed();
				installed = undefined;
			}
		};
	}, "cookie-guard: http header and dsh-auth cookie hygiene");
}
