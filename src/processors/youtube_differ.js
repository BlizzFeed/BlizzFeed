import fs from 'node:fs';
import path from 'node:path';
import { writeJson } from '../json.js';

const TEXT_FIELDS = ['title', 'description'];
const STORED_FIELDS = ['title', 'description', 'published', 'kind', 'premiere', 'duration', 'live', 'scheduled', 'started', 'ended', 'thumbnail'];
const LIVE_FIELDS = ['duration', 'live', 'scheduled', 'started', 'ended', 'thumbnail'];

export const statePath = (dir, handle) => path.join(dir, handle, 'state.json');

export function loadState(dir, handle) {
	const file = statePath(dir, handle);
	return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

const pick = (source, fields) => Object.fromEntries(fields.map((key) => [key, source[key]]));
const active = (video) => (video.live === 'upcoming' || video.live === 'live') && !video.removed;

/** Ids to fetch details for: everything on a baseline, else new videos, the streams still to start or end, and any whose
 * listed text differs from ours (the list can lag the video, so the video itself settles it). */
export function needsDetails(old, listed) {
	if (old === null) {
		return listed.map((entry) => entry.id);
	}
	const wanted = listed.filter((entry) => !(entry.id in old.videos) || TEXT_FIELDS.some((field) => entry[field] !== old.videos[entry.id][field])).map((entry) => entry.id);
	return [...new Set([...wanted, ...Object.keys(old.videos).filter((id) => active(old.videos[id]))])];
}

/** [new state, changes]. old is null on a channel's first run, which reports nothing.
 * listed is the newest uploads (id, title, description); details maps ids to built videos. */
export function sweep(old, listed, details, now) {
	const baseline = old === null;
	const videos = baseline ? {} : structuredClone(old.videos);
	const fresh = [];
	const changes = [];
	const base = (id, video) => ({ id, kind: video.kind, title: video.title, seen: now });

	for (const entry of listed) {
		const detail = details.get(entry.id);
		const prev = videos[entry.id];
		if (!prev) {
			if (detail) {
				videos[entry.id] = { ...pick(detail, STORED_FIELDS), first_seen: now };
				fresh.push({ type: 'new', ...base(entry.id, detail), ...pick(detail, STORED_FIELDS.slice(1)) });
			}
			continue;
		}
		const current = detail ?? entry;
		const edited = TEXT_FIELDS.filter((field) => current[field] !== prev[field]);
		if (edited.length) {
			const fields = Object.fromEntries(edited.map((field) => [field, { from: prev[field], to: current[field] }]));
			Object.assign(prev, pick(current, edited));
			changes.push({ type: 'edited', ...base(entry.id, prev), fields }); // with the new title
		}
	}

	for (const [id, prev] of Object.entries(videos)) {
		const detail = details.get(id);
		if (!detail && active(prev) && !baseline) {
			prev.removed = true; // a stream that is gone stops being asked about
		}
		if (!detail || fresh.some((change) => change.id === id)) {
			continue;
		}
		if (prev.live !== detail.live) {
			changes.push({ type: 'live', ...base(id, prev), from: prev.live, to: detail.live, started: detail.started, ended: detail.ended });
		} else if (prev.scheduled !== detail.scheduled) {
			changes.push({ type: 'rescheduled', ...base(id, prev), from: prev.scheduled, to: detail.scheduled });
		}
		Object.assign(prev, pick(detail, LIVE_FIELDS));
		prev.premiere ||= detail.premiere; // once ended, a premiere looks like any stream, so it stays one
		delete prev.removed;
	}

	fresh.sort((a, b) => a.published.localeCompare(b.published));
	return [{ videos }, baseline ? [] : [...fresh, ...changes]];
}

const renderText = (video) => `# ${video.title}\n\n${video.description}\n`;

/** state.json, and a text file for each new or edited video (every video on a baseline), so a description edit has a diff. */
export function writeChannel(dir, handle, state, changes, baseline) {
	const root = path.join(dir, handle);
	fs.mkdirSync(root, { recursive: true });
	const touched = baseline ? Object.keys(state.videos) : changes.filter((c) => c.type === 'new' || c.type === 'edited').map((c) => c.id);
	for (const id of new Set(touched)) {
		fs.writeFileSync(path.join(root, `${id}.md`), renderText(state.videos[id]));
	}
	writeJson(statePath(dir, handle), state);
}
