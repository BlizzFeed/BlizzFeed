import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpError } from './http.js';
import * as article from './article.js';

const SELECTOR = 'article.Content section.blog';

/** Answers every fetch with this status and page. */
function answer(t, status, page = '') {
	t.mock.method(globalThis, 'fetch', async () => new Response(page, { status }));
}

test('returns the body HTML', async (t) => {
	for (const body of ['<p>Hi</p>', '<iframe src="https://v/1"></iframe>', '<img src="https://i/1.png">']) {
		answer(t, 200, `<article class="Content"><section class="blog">${body}</section></article>`);
		assert.equal(await article.fetchBody('en-gb', '1', SELECTOR), `<section class="blog">${body}</section>`);
	}
});

test('a 404 or 410 is gone, a server error is not', async (t) => {
	for (const status of [404, 410]) {
		answer(t, status);
		await assert.rejects(article.fetchBody('en-gb', '1', SELECTOR), article.ArticleGone);
	}
	answer(t, 500);
	await assert.rejects(article.fetchBody('en-gb', '1', SELECTOR, 0), (e) => e instanceof HttpError && !(e instanceof article.ArticleGone));
});

test('a 5xx is tried once more, and only once', async (t) => {
	const page = '<article class="Content"><section class="blog"><p>Hi</p></section></article>';
	const replies = [new Response('', { status: 502 }), new Response(page)];
	const fetch = t.mock.method(globalThis, 'fetch', async () => replies.shift());
	assert.equal(await article.fetchBody('en-gb', '1', SELECTOR, 0), '<section class="blog"><p>Hi</p></section>');
	answer(t, 502);
	await assert.rejects(article.fetchBody('en-gb', '1', SELECTOR, 0), HttpError);
	assert.equal(fetch.mock.callCount(), 2);
});

test('a missing or empty body is not found', async (t) => {
	for (const page of ['<p>no body</p>', '<article class="Content"><section class="blog"> </section></article>']) {
		answer(t, 200, page);
		await assert.rejects(article.fetchBody('en-gb', '1', SELECTOR), article.BodyNotFound);
	}
});
