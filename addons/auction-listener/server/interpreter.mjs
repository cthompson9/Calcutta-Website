// Intentionally bounded v0 grammar. Recall handles speech recognition; this module
// validates explicit auction commands instead of guessing from general conversation.
export const normalize = value => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function matchLot(name, lots) {
  const needle = normalize(name.replace(/^(?:the\s+)/i, ''));
  const matches = lots.filter(lot => [lot.name, ...(lot.aliases ?? [])].some(a => normalize(a) === needle));
  return matches.length === 1 ? matches[0] : null;
}

const small = ['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];
const tens = { twenty:20, thirty:30, forty:40, fifty:50, sixty:60, seventy:70, eighty:80, ninety:90 };
export function priceCents(raw) {
  const s = raw.trim().toLowerCase().replace(/\.$/, '').replace(/^\$/, '').replace(/\s+dollars?$/, '').trim();
  if (/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(s)) {
    const n = Math.round(Number(s.replaceAll(',', '')) * 100);
    return Number.isSafeInteger(n) && n > 0 && n <= 100000000 ? n : null;
  }
  const parts = s.replaceAll('-', ' ').split(/\s+/).filter(w => w !== 'and');
  let total = 0, group = 0, last = '', usedThousand = false;
  for (const w of parts) {
    if (small.includes(w)) {
      const n = small.indexOf(w);
      if (last === 'small' || (last === 'tens' && (n === 0 || n >= 10))) return null;
      group += n; last = 'small';
    } else if (w in tens) {
      if (last === 'small' || last === 'tens') return null;
      group += tens[w]; last = 'tens';
    } else if (w === 'hundred') {
      if (last !== 'small' || group < 1 || group > 9) return null;
      group *= 100; last = 'hundred';
    } else if (w === 'thousand') {
      if (!group || usedThousand) return null;
      total += group * 1000; group = 0; last = ''; usedThousand = true;
    } else return null;
  }
  const n = (total + group) * 100;
  return n > 0 && n <= 100000000 ? n : null;
}

export function parseOwners(raw) {
  let ownerText = raw.trim().replace(/[,;]+$/, '');
  let equal = false;
  const split = /(?:,?\s+)(fifty[ -]fifty|50[ /-]50|equally|equal shares)$/i;
  if (split.test(ownerText)) { equal = true; ownerText = ownerText.replace(split, ''); }
  const names = ownerText.split(/\s+(?:and|&)\s+|\s*,\s*/).map(s => s.trim());
  if (!names.length || names.length > 8 || names.some(n => !/^[\p{L}][\p{L}\p{M} .'-]{0,79}$/u.test(n) || /\b(?:sold|for|percent|once|twice|not|correction|actually|maybe)\b/i.test(n))) return null;
  if (new Set(names.map(normalize)).size !== names.length) return null;
  if (names.length === 1) return [{ name: names[0], basisPoints: 10000 }];
  if (!equal) return names.map(name => ({ name, basisPoints: null }));
  if (/fifty|50/i.test(raw) && names.length !== 2) return null;
  const base = Math.floor(10000 / names.length);
  return names.map((name, i) => ({ name, basisPoints: base + (i < 10000 % names.length ? 1 : 0) }));
}

export function interpret(text, state) {
  const raw = text.trim().replace(/^(?:all right|alright|okay|ok)[, ]+/i,'').replace(/[.!?]+$/, '').trim();
  if (/\b(?:not sold|unsold|don't sell|do not sell|correction|actually|cancel|scratch that|wait|hold on|maybe|if|example|would|could)\b/i.test(raw)) {
    return { kind: 'review', reason: 'Possible correction or conditional statement. Edit the result manually.' };
  }
  const next = /^(?:next(?: lot)?(?: up)?(?: is| we have)?|up next(?: is| we have)?|nominat(?:e|ing))\s*[:,]?\s+(.+)$/i.exec(raw);
  if (next) {
    const lot = matchLot(next[1], state.lots);
    if (!lot) return { kind:'review', reason:'Nomination did not match exactly one known lot.' };
    if (state.sales.some(s => s.lotId === lot.id)) return { kind:'review', reason:'That lot is already sold.' };
    return { kind:'nomination', lotId:lot.id };
  }
  // Ignore the auction's ordinary bids and countdown, but never infer a sale from them.
  if (!/\bsold\b/i.test(raw)) return { kind:'ignore' };
  const cleaned = raw.replace(/^(?:going\s+)?once[, .]*\s*(?:(?:going\s+)?twice[, .]*\s*)?/i, '').replace(/^twice[, .]*\s*/i, '');
  const sale = /^(?:(.+?)\s+)?sold\s+to\s+(.+?)\s+for\s+(.+)$/i.exec(cleaned);
  if (!sale) return { kind:'pending', reason:'Waiting for a complete “sold to [owners] for [price]” announcement.' };
  const lot = sale[1] ? matchLot(sale[1], state.lots) : state.lots.find(l => l.id === state.currentLotId);
  if (!lot) return { kind:'review', reason:'Name the lot explicitly or nominate it first.' };
  const owners = parseOwners(sale[2]);
  const cents = priceCents(sale[3]);
  if (!owners || cents === null) return { kind:'review', reason:'Could not safely read the owners or price. Use the example phrase or edit manually.' };
  const existing = state.sales.find(s => s.lotId === lot.id);
  if (existing) {
    const same = existing.priceCents === cents && JSON.stringify(existing.owners.map(o => [normalize(o.name),o.basisPoints])) === JSON.stringify(owners.map(o => [normalize(o.name),o.basisPoints]));
    return same ? { kind:'ignore' } : { kind:'review', reason:'That lot already has a result. A commissioner must edit it; speech cannot overwrite it.' };
  }
  return { kind:'sale', lotId:lot.id, priceCents:cents, owners, needsShares:owners.some(o => o.basisPoints === null) };
}
