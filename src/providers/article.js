import { setTimeout as wait } from 'node:timers/promises';
import * as cheerio from 'cheerio';
import { HttpError, get } from './http.js';
import { textOf } from './html.js';

/** The article page is a 404 or 410: removed, or never public. */
export class ArticleGone extends Error {}

/** The page loaded but the body selector matched nothing, or an element with no text or media. */
export class BodyNotFound extends Error {}

/** Blizzard redirects this slug-less URL to the full one, for every game's articles. */
export const articleUrl = (locale, articleId) => `https://news.blizzard.com/${locale}/article/${articleId}`;

/** One more try after a short pause on a 5xx. A 3xx fetch gave up on (Blizzard sometimes sends a doubled Location) is followed once by hand. */
export async function fetchBody(locale, articleId, selector, retryMs = 2000) {
	let response;
	let url = articleUrl(locale, articleId);
	let retried = false;
	while (!response) {
		try {
			response = await get(url);
		} catch (error) {
			if (error instanceof HttpError && (error.status === 404 || error.status === 410)) {
				throw new ArticleGone(articleId);
			}
			const next = error instanceof HttpError && error.status < 400 && error.location?.split(',')[0].trim();
			if (next && url === articleUrl(locale, articleId)) {
				url = new URL(next, error.url).href;
			} else if (error instanceof HttpError && error.status >= 500 && !retried) {
				retried = true;
				await wait(retryMs);
			} else {
				throw error;
			}
		}
	}
	// htmlparser2 keeps odd markup (a link in a link) as written, where the default parser would rearrange it.
	const $ = cheerio.load(await response.text(), { xml: { xmlMode: false } });
	const body = $(selector).first();
	// A trailer or screenshot post can be only a video or images, with no text.
	if (!body.length || !(textOf(body[0]) || body.find('img, iframe, video').length)) {
		throw new BodyNotFound(`${articleId}: '${selector}' matched nothing usable`);
	}
	return $.html(body);
}
