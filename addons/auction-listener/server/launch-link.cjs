// Protocol links contain a short-lived ticket, never an admin or Recall key.
const PROTOCOL = 'calcutta-listener';
const DEFAULT_ORIGINS = ['https://thecalcutta.app', 'https://www.thecalcutta.app'];
function parseLaunchLink(raw, allowedOrigins = DEFAULT_ORIGINS) {
  if (typeof raw !== 'string' || raw.length > 2048) throw new Error('Invalid listener link.');
  const link = new URL(raw);
  if (link.protocol !== `${PROTOCOL}:` || link.hostname !== 'connect' ||
      !['', '/'].includes(link.pathname) || link.username || link.password || link.port || link.search) {
    throw new Error('Invalid listener link.');
  }
  const fields = new URLSearchParams(link.hash.slice(1));
  if ([...fields.keys()].sort().join(',') !== 'origin,ticket') throw new Error('Invalid listener link.');
  const origin = fields.get('origin');
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin || !allowedOrigins.includes(origin)) {
    throw new Error('This website is not configured for the listener.');
  }
  const ticket = fields.get('ticket');
  if (!/^[A-Za-z0-9_-]{43}$/.test(ticket || '')) throw new Error('Invalid connection ticket.');
  return {origin, ticket};
}
function findLaunchLink(argv) {
  return argv.find(value => typeof value === 'string' && value.startsWith(`${PROTOCOL}://`));
}
module.exports = {PROTOCOL, DEFAULT_ORIGINS, parseLaunchLink, findLaunchLink};
