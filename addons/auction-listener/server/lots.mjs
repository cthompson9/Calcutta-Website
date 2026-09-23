// Rehearsal inventory only. Replace in the UI with the actual auction's known lots.
export const defaultLots = [
  'Arizona Cardinals','Atlanta Falcons','Baltimore Ravens','Buffalo Bills',
  'Carolina Panthers','Chicago Bears','Cincinnati Bengals','Cleveland Browns',
  'Dallas Cowboys','Denver Broncos','Detroit Lions','Green Bay Packers',
  'Houston Texans','Indianapolis Colts','Jacksonville Jaguars','Kansas City Chiefs',
  'Las Vegas Raiders','Los Angeles Chargers','Los Angeles Rams','Miami Dolphins',
  'Minnesota Vikings','New England Patriots','New Orleans Saints','New York Giants',
  'New York Jets','Philadelphia Eagles','Pittsburgh Steelers','San Francisco 49ers',
  'Seattle Seahawks','Tampa Bay Buccaneers','Tennessee Titans','Washington Commanders',
].map((name, index) => ({ id: String(index + 1), name, aliases: [name.split(' ').at(-1)] }));

export function validateLots(input) {
  if (!Array.isArray(input) || !input.length || input.length > 500) throw new Error('Supply between 1 and 500 lots.');
  const names = new Set();
  return input.map((lot, i) => {
    const name = typeof lot === 'string' ? lot.trim() : lot.name?.trim();
    if (!name || name.length > 120 || names.has(name.toLowerCase())) throw new Error('Lot names must be unique and between 1 and 120 characters.');
    names.add(name.toLowerCase());
    const aliases = typeof lot === 'string' ? [] : lot.aliases ?? [];
    if (!Array.isArray(aliases) || aliases.some(a => typeof a !== 'string' || !a.trim() || a.length > 120)) throw new Error('Invalid lot aliases.');
    return { id: String(i + 1), name, aliases: aliases.map(a => a.trim()) };
  });
}
