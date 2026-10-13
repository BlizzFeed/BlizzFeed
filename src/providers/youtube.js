import { HttpError, get } from './http.js';

const API = 'https://www.googleapis.com/youtube/v3';
const MAX_IDS = 50; // videos.list takes this many ids per call
const GONE_TITLES = new Set(['Private video', 'Deleted video']);
const THUMBNAIL_SIZES = ['maxres', 'standard', 'high', 'medium', 'default'];

let units = 0;
/** Quota units spent this run (1 per call). */
export const quotaUnits = () => units;

const safeParse = (text) => {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
};

/** One API call. An HTTP error reads "endpoint status reason" without the URL, so alerts (cut at 100 characters) keep the
 * reason and never hold the key; any other error has the key scrubbed. */
async function call(key, endpoint, params) {
	units++;
	try {
		return await (await get(`${API}/${endpoint}`, { params: { ...params, key } })).json();
	} catch (error) {
		if (error instanceof HttpError) {
			const reply = safeParse(error.body)?.error;
			error.message = [`${endpoint} ${error.status}`, reply?.errors?.[0]?.reason, reply?.message].filter(Boolean).join(': ');
		}
		error.message = error.message.replaceAll(key, '***');
		throw error;
	}
}

/** A channel's playlist of its uploads (UU), or of only its Shorts (UUSH). */
export const uploadsPlaylist = (channelId, prefix = 'UU') => prefix + channelId.slice(2);

const bestThumbnail = (thumbnails = {}) => thumbnails[THUMBNAIL_SIZES.find((size) => thumbnails[size])]?.url ?? null;

/** The newest uploads, newest first. Private and deleted ones keep a placeholder title in the list, so they are dropped. */
export async function fetchUploads(key, channelId, max = 15) {
	const body = await call(key, 'playlistItems', { part: 'snippet,contentDetails', playlistId: uploadsPlaylist(channelId), maxResults: max });
	return body.items.filter((item) => !GONE_TITLES.has(item.snippet.title))
		.map((item) => ({ id: item.contentDetails.videoId, title: item.snippet.title.trim(), description: item.snippet.description }));
}

/** Ids of the newest Shorts. A channel that never posted one has no such playlist. */
export async function fetchShortIds(key, channelId) {
	try {
		const body = await call(key, 'playlistItems', { part: 'contentDetails', playlistId: uploadsPlaylist(channelId, 'UUSH'), maxResults: MAX_IDS });
		return new Set(body.items.map((item) => item.contentDetails.videoId));
	} catch (error) {
		if (error instanceof HttpError && error.status === 404) {
			return new Set();
		}
		throw error;
	}
}

/** Video resources by id, batched to the 50-id limit. A removed video is missing from the result. */
export async function fetchVideos(key, ids) {
	const found = new Map();
	for (let i = 0; i < ids.length; i += MAX_IDS) {
		const body = await call(key, 'videos', { part: 'snippet,liveStreamingDetails,contentDetails', id: ids.slice(i, i + MAX_IDS).join(',') });
		body.items.forEach((resource) => found.set(resource.id, resource));
	}
	return found;
}

/** none for a non-stream, else the phase of the stream or premiere. */
export function liveStatus(resource) {
	if (!resource.liveStreamingDetails) {
		return 'none';
	}
	const phase = resource.snippet.liveBroadcastContent;
	return phase === 'live' || phase === 'upcoming' ? phase : 'ended';
}

/** Seconds in an ISO 8601 duration (PT1M19S). A stream that hasn't ended is P0D. */
export function seconds(duration = '') {
	const [, d, h, m, s] = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(duration) ?? [];
	return ((Number(d ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(m ?? 0)) * 60 + Number(s ?? 0);
}

/** A resource as the tracker stores it. A Short is only known from the Shorts playlist. A premiere is a stream that
 * already has its length before it ends (a livestream's is 0 until then), so it can only be told while upcoming or live. */
export function buildVideo(resource, shortIds) {
	const live = liveStatus(resource);
	const details = resource.liveStreamingDetails ?? {};
	const duration = seconds(resource.contentDetails?.duration);
	return {
		id: resource.id,
		title: resource.snippet.title.trim(),
		description: resource.snippet.description,
		published: resource.snippet.publishedAt,
		kind: live !== 'none' ? 'stream' : shortIds.has(resource.id) ? 'short' : 'video',
		premiere: (live === 'upcoming' || live === 'live') && duration > 0,
		duration,
		live,
		scheduled: details.scheduledStartTime ?? null,
		started: details.actualStartTime ?? null,
		ended: details.actualEndTime ?? null,
		thumbnail: bestThumbnail(resource.snippet.thumbnails),
	};
}
