// To stderr, so stdout only has what a command prints (the shop's dry run).
const pad = (n) => String(n).padStart(2, '0');

function stamp() {
	const d = new Date();
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function write(level, message) {
	console.error(`${stamp()} | ${level.padEnd(8)} | ${message}`);
}

export const logger = {
	info: (message) => write('INFO', message),
	success: (message) => write('SUCCESS', message),
	warning: (message) => write('WARNING', message),
	error: (message) => write('ERROR', message),
};
