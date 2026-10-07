/** Rational arithmetic: repeating fractions never become rounded stake weights. */
export type ExactFraction = { numerator: bigint; denominator: bigint };
const gcd = (a: bigint, b: bigint): bigint => b === 0n ? (a < 0n ? -a : a) : gcd(b, a % b);
export function fraction(numerator: bigint, denominator: bigint): ExactFraction {
  if (denominator <= 0n) throw new Error("Fraction denominator must be positive.");
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}
export function decimalFraction(value: string | number): ExactFraction {
  const text = String(value);
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) throw new Error("Invalid decimal ownership.");
  const [whole, decimals = ""] = text.split(".");
  const sign = whole!.startsWith("-") ? -1n : 1n;
  return fraction(sign * BigInt(whole!.replace("-", "") + decimals), 10n ** BigInt(decimals.length));
}
export const addFractions = (a: ExactFraction, b: ExactFraction) =>
  fraction(a.numerator * b.denominator + b.numerator * a.denominator, a.denominator * b.denominator);
export const multiplyFractions = (a: ExactFraction, b: ExactFraction) =>
  fraction(a.numerator * b.numerator, a.denominator * b.denominator);
export const fractionNumber = (value: ExactFraction) => Number(value.numerator) / Number(value.denominator);
export const sumFractions = (values: ExactFraction[]) => values.reduce(addFractions, fraction(0n, 1n));

/** Only XIII opts into the commissioner's thirds/sixths interpretation. */
export function exactShareVector(values: number[]): ExactFraction[] {
  if (!values.length || values.some(value => !Number.isFinite(value) || value <= 0 || value > 1)) {
    throw new Error("Ownership shares must be positive and at most 100%.");
  }
  const thirds = values.length === 3 && values.every(value => value === .33 || value === .34) &&
    (Math.abs(values.reduce((a, b) => a + b, 0) - 1) < 1e-9 || values.every(value => value === .33));
  const candidates = [fraction(1n, 3n), fraction(2n, 3n), fraction(1n, 6n), fraction(5n, 6n)];
  const shares = values.map(value => thirds ? fraction(1n, 3n) :
    candidates.find(candidate => Math.abs(fractionNumber(candidate) - value) <= .000101 ||
      (value === .33 && candidate.numerator === 1n && candidate.denominator === 3n) ||
      ((value === .66 || value === .67) && candidate.numerator === 2n && candidate.denominator === 3n)) ??
    decimalFraction(value));
  const total = sumFractions(shares);
  if (total.numerator !== total.denominator) throw new Error("Exact owner fractions must total 100%.");
  return shares;
}

/** Signed largest-remainder allocation, with exact rational weights and stable ties. */
export function allocateExactCents(total: number, rows: Array<{ id: number; share: ExactFraction }>): Map<number, number> {
  if (!Number.isSafeInteger(total) || total < 0 || !rows.length || new Set(rows.map(row => row.id)).size !== rows.length) {
    throw new Error("Invalid exact cent allocation.");
  }
  const sum = sumFractions(rows.map(row => row.share));
  if (sum.numerator !== sum.denominator) throw new Error("Signed ownership must reconcile to 100%.");
  const staged = rows.map(({ id, share }) => {
    const numerator = BigInt(total) * share.numerator;
    let cents = numerator / share.denominator;
    let remainder = numerator % share.denominator;
    if (remainder < 0n) { cents--; remainder += share.denominator; }
    return { id, cents, remainder, denominator: share.denominator };
  });
  let remaining = BigInt(total) - staged.reduce((sum, row) => sum + row.cents, 0n);
  const order = [...staged].sort((a, b) => {
    const delta = b.remainder * a.denominator - a.remainder * b.denominator;
    return delta > 0n ? 1 : delta < 0n ? -1 : a.id - b.id;
  });
  if (remaining < 0n || remaining > BigInt(rows.length)) throw new Error("Exact cent remainders do not reconcile.");
  for (const row of order) if (remaining-- > 0n) row.cents++;
  return new Map(staged.map(row => {
    const cents = Number(row.cents);
    if (!Number.isSafeInteger(cents)) throw new Error("Owner cents exceed supported precision.");
    return [row.id, cents];
  }));
}
