import * as cheerio from 'cheerio';
import { HttpError, get } from './http.js';
import { textOf } from './html.js';

/** The article page is a 404 or 410: removed, or never public. */
export class ArticleGone extends Error {}

/** The page loaded but the body selector matched nothing, or an element with no text or media. */
export class BodyNotFound extends Error {}

/** Blizzard redirects this slug-less URL to the full one, for every game's articles. */
export const articleUrl = (locale, articleId) => `https://news.blizzard.com/${locale}/article/${articleId}`;

export async function fetchBody(locale, articleId, selector) {
	let response;
	try {
		response = await get(articleUrl(locale, articleId));
	} catch (error) {
		if (error instanceof HttpError && (error.status === 404 || error.status === 410)) {
			throw new ArticleGone(articleId);
		}
		throw error;
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
