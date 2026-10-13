const routeFor = (channel, video) => channel.routes.find((route) => route.pattern.test(video.title));

/** The feed labels a video goes to: none for a kind the channel keeps out of the feeds, else the first route its title
 * matches, else the channel's own feeds. #youtube gets every video and isn't a feed. */
export function feedsFor(channel, video) {
	if (!channel.kinds.includes(video.kind)) {
		return [];
	}
	return routeFor(channel, video)?.feeds ?? channel.feeds;
}

/** The game logo shown beside the post: the matching route's, else the channel's, else none. */
export const logoFor = (channel, video) => routeFor(channel, video)?.logo ?? channel.logo;

const [SCHEDULED, LIVE] = ['scheduled', 'live'];
/** What a stream's posts are called, so a later change finds the post to edit. */
export const streamRef = (id, phase) => `yt:${id}:${phase}`;

/** How a change from the differ is posted: the kind of entry, the tiers it goes to, and whether it edits an earlier post
 * (ref) instead. A stream is posted when scheduled and again when it goes live; its end and a new start time edit those posts. */
export function postFor(change, video) {
	switch (change.type) {
	case 'new':
		return { kind: 'video', tiers: ['all', 'new'], edit: false, ref: video.kind === 'stream' ? streamRef(video.id, video.live === 'upcoming' ? SCHEDULED : LIVE) : null };
	case 'live':
		if (change.to !== 'upcoming') {
			return { kind: 'video', tiers: ['all', 'new'], edit: change.to === 'ended', ref: streamRef(video.id, LIVE) };
		}
		return { kind: 'video', tiers: ['all', 'new'], edit: true, ref: streamRef(video.id, SCHEDULED) }; // back to upcoming: like a new start time
	case 'rescheduled':
		return { kind: 'video', tiers: ['all', 'new'], edit: true, ref: streamRef(video.id, SCHEDULED) };
	case 'edited':
		return { kind: 'video_updated', tiers: ['all', 'updated'], edit: false, ref: null };
	default:
		throw new Error(`unknown YouTube change: ${change.type}`);
	}
}
