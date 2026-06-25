import { buildFetchHeaders } from '../src/proxy-payload.js';

/**
 * Fetch upstream via Node HTTP (fast path when scrape-time replay returned 200).
 * @param {string} url
 * @param {string} referer
 * @param {Record<string, string>} extraHeaders
 * @param {boolean} isText
 */
export async function fetchViaHttp(url, referer, extraHeaders, isText) {
    const headers = buildFetchHeaders(referer, extraHeaders);
    const response = await fetch(url, { headers, redirect: 'follow' });
    const body = isText
        ? await response.text()
        : Buffer.from(await response.arrayBuffer());

    const responseHeaders = {};
    response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
    });

    return {
        statusCode: response.status,
        headers: responseHeaders,
        body,
    };
}
