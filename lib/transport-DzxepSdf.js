import { LlmError } from "@deepseek-ai/dsh-llm";
import { request } from "node:http";
import { request as request$1 } from "node:https";
import { connect } from "node:tls";

//#region lib/types/transport.js
/** Default port for each supported proxy scheme. */
const PROXY_PORTS = {
	"http:": 80,
	"https:": 443
};
/**
* Validate a proxy URL at its configuration boundary.
* @param raw - the configured proxy URL.
* @returns the parsed URL.
* @throws when the value is not a URL, or names a scheme this transport cannot open.
*/
function parseProxyUrl(raw) {
	let url;
	try {
		url = new URL(raw);
	} catch (error) {
		throw new Error(`llm-kiro: proxyUrl "${raw}" is not a valid URL`, { cause: error });
	}
	if (!(url.protocol in PROXY_PORTS)) throw new Error(`llm-kiro: proxyUrl scheme "${url.protocol}" is not supported; use http:// or https://`);
	if (url.hostname.length === 0) throw new Error(`llm-kiro: proxyUrl "${raw}" names no host`);
	return url;
}
/**
* Open a `CONNECT` tunnel to `host:port` through an HTTP proxy.
* @param proxy - the validated proxy URL.
* @param host - target hostname.
* @param port - target port.
* @param signal - caller cancellation.
* @returns the tunneled socket, ready for TLS.
* @throws `LlmError('TRANSPORT')` when the proxy refuses or the connection fails.
*/
function openTunnel(proxy, host, port, signal) {
	return new Promise((resolve, reject) => {
		const request$2 = (proxy.protocol === "https:" ? request$1 : request)({
			host: proxy.hostname,
			port: proxy.port.length > 0 ? Number(proxy.port) : PROXY_PORTS[proxy.protocol],
			method: "CONNECT",
			path: `${host}:${port}`,
			signal,
			headers: {
				host: `${host}:${port}`,
				...proxy.username.length > 0 ? { "proxy-authorization": `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}` } : {}
			}
		});
		request$2.once("connect", (response, socket) => {
			if (response.statusCode !== 200) {
				socket.destroy();
				reject(new LlmError(`Kiro proxy ${proxy.host} refused CONNECT with HTTP ${String(response.statusCode)}`, "TRANSPORT"));
				return;
			}
			resolve(socket);
		});
		request$2.once("error", (error) => {
			reject(new LlmError(`Kiro proxy ${proxy.host} connection failed`, "TRANSPORT", { cause: error }));
		});
		request$2.end();
	});
}
/**
* POST one request and resolve as soon as response headers arrive, so the
* caller streams the body itself.
* @param options - target, headers, body, cancellation, and optional proxy.
* @returns status, headers, and the body byte stream.
* @throws `LlmError('TRANSPORT')` on a pre-response transport failure, or
*   `LlmError('ABORTED')` when the caller cancelled first.
*/
async function send(options) {
	const target = new URL(options.url);
	const port = target.port.length > 0 ? Number(target.port) : 443;
	const tunnel = options.proxyUrl === void 0 ? void 0 : await openTunnel(parseProxyUrl(options.proxyUrl), target.hostname, port, options.signal);
	return new Promise((resolve, reject) => {
		const request$2 = request$1({
			host: target.hostname,
			port,
			path: `${target.pathname}${target.search}`,
			method: options.method,
			signal: options.signal,
			...tunnel === void 0 ? {} : { createConnection: () => connect({
				socket: tunnel,
				servername: target.hostname
			}) },
			headers: {
				...options.headers,
				...options.body === void 0 ? {} : { "content-length": String(Buffer.byteLength(options.body)) }
			}
		}, (response) => {
			resolve({
				status: response.statusCode ?? 0,
				headers: response.headers,
				body: response
			});
		});
		request$2.once("error", (error) => {
			tunnel?.destroy();
			if (options.signal.aborted) {
				reject(new LlmError("Kiro request aborted by caller", "ABORTED", { cause: error }));
				return;
			}
			reject(new LlmError(`Kiro request to ${target.host} failed`, "TRANSPORT", { cause: error }));
		});
		request$2.end(options.body);
	});
}
function post(options) {
	return send({
		...options,
		method: "POST"
	});
}
async function responseJson(response) {
	const chunks = [];
	for await (const chunk of response.body) chunks.push(chunk);
	const text = Buffer.concat(chunks).toString("utf8");
	try {
		return {
			status: response.status,
			body: JSON.parse(text)
		};
	} catch {
		return {
			status: response.status,
			body: void 0
		};
	}
}
/**
* POST JSON and read the whole response, for the small non-streaming calls
* (token refresh) that share this transport's egress.
* @param url - absolute `https:` URL.
* @param body - value serialized as the JSON request body.
* @param proxyUrl - optional proxy egress.
* @param signal - caller cancellation.
* @returns the status and parsed JSON body; an unparsable body resolves as `undefined`.
*/
async function postJson(url, body, proxyUrl, signal) {
	return postJsonWithHeaders(url, body, {}, proxyUrl, signal);
}
/**
* POST and parse JSON while supplying operation-specific headers.
* @param url - absolute HTTPS URL.
* @param body - JSON request value.
* @param headers - extra request headers such as Kiro authorization.
* @param proxyUrl - optional proxy egress.
* @param signal - caller cancellation.
* @returns status and parsed response body.
*/
async function postJsonWithHeaders(url, body, headers, proxyUrl, signal) {
	return responseJson(await post({
		url,
		headers: {
			"content-type": "application/json",
			accept: "application/json",
			...headers
		},
		body: JSON.stringify(body),
		signal,
		...proxyUrl === void 0 ? {} : { proxyUrl }
	}));
}
/** POST an OAuth form and parse its small JSON response. */
async function postForm(url, body, proxyUrl, signal) {
	return responseJson(await post({
		url,
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			accept: "application/json"
		},
		body: body.toString(),
		signal,
		...proxyUrl === void 0 ? {} : { proxyUrl }
	}));
}
/**
* GET and parse a small JSON response through the same optional proxy.
* @param url - absolute HTTPS URL.
* @param headers - request headers.
* @param proxyUrl - optional proxy egress.
* @param signal - caller cancellation.
* @returns status and parsed response body.
*/
async function getJson(url, headers, proxyUrl, signal) {
	return responseJson(await send({
		url,
		method: "GET",
		headers: {
			accept: "application/json",
			...headers
		},
		signal,
		...proxyUrl === void 0 ? {} : { proxyUrl }
	}));
}

//#endregion
export { postJson as a, postForm as i, parseProxyUrl as n, postJsonWithHeaders as o, post as r, getJson as t };