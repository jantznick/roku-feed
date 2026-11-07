import { safeClosePage } from '../src/puppeteer-utils.js';

/** @type {Map<string, { page: import('puppeteer').Page, lastUsed: number }>} */
const embedPages = new Map();

export function setEmbedPage(embedUrl, page) {
    const existing = embedPages.get(embedUrl);
    if (existing?.page && existing.page !== page && !existing.page.isClosed()) {
        void safeClosePage(existing.page);
    }
    embedPages.set(embedUrl, { page, lastUsed: Date.now() });
}

export function getEmbedPage(embedUrl) {
    const entry = embedPages.get(embedUrl);
    if (entry?.page && !entry.page.isClosed()) {
        entry.lastUsed = Date.now();
        return entry.page;
    }
    embedPages.delete(embedUrl);
    return null;
}

/** Touch last-used without requiring a fetch (keeps idle cleanup honest). */
export function touchEmbedPage(embedUrl) {
    const entry = embedPages.get(embedUrl);
    if (entry?.page && !entry.page.isClosed()) {
        entry.lastUsed = Date.now();
        return true;
    }
    return false;
}

export function hasOpenEmbedPages() {
    for (const [url, entry] of embedPages) {
        if (entry?.page && !entry.page.isClosed()) {
            return true;
        }
        embedPages.delete(url);
    }
    return false;
}

/**
 * Embed URLs whose player tab has been idle longer than timeoutMs.
 * @param {number} timeoutMs
 * @returns {string[]}
 */
export function getIdleEmbedUrls(timeoutMs) {
    const now = Date.now();
    const idle = [];
    for (const [url, entry] of embedPages) {
        if (!entry?.page || entry.page.isClosed()) {
            embedPages.delete(url);
            continue;
        }
        if (now - entry.lastUsed >= timeoutMs) {
            idle.push(url);
        }
    }
    return idle;
}

export function clearEmbedPage(embedUrl) {
    const entry = embedPages.get(embedUrl);
    if (entry?.page) {
        void safeClosePage(entry.page);
    }
    embedPages.delete(embedUrl);
}

export function clearAllEmbedPages() {
    for (const entry of embedPages.values()) {
        if (entry?.page) {
            void safeClosePage(entry.page);
        }
    }
    embedPages.clear();
}
