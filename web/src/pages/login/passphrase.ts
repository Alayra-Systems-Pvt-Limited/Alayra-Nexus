// Generating a backup passphrase the operator can read back over the phone (Phase C6).
//
// ── Why words, and why this many ──────────────────────────────────────────────────────────────
//
// The passphrase protects every backup this gateway will ever take. It is also the one thing an
// operator has to still possess a year later, possibly on paper, possibly transcribed by someone
// else. Random bytes are stronger per character and useless for that; words are not.
//
// The list below holds exactly 256 words, so each word contributes exactly 8 bits and the arithmetic
// is something anyone can check rather than something this comment asserts. Eight words is 64 bits,
// and the server puts scrypt (N=32768) between a guesser and the file — so an attacker who steals a
// backup is not doing 2^64 hashes, they are doing 2^64 scrypt derivations.
//
// Six words would be 48 bits, which is the sort of number that looks fine in a comment and is not.
//
// ── Why the browser generates it ──────────────────────────────────────────────────────────────
//
// `crypto.getRandomValues` is the same CSPRNG quality as the server's, and generating here means a
// passphrase the operator rejects and regenerates never leaves the machine at all. The one they keep
// is sent with the claim, because the server must derive the recovery key from it.

/** Exactly 256 short, unambiguous words. Length is asserted below, not trusted. */
const WORDS = [
  'able', 'acid', 'acre', 'aged', 'alarm', 'album', 'alert', 'alley', 'amber', 'anchor', 'angle', 'ankle', 'apple', 'april', 'arbor', 'arch',
  'arena', 'armor', 'arrow', 'ash', 'aspen', 'atlas', 'attic', 'auburn', 'audio', 'autumn', 'awake', 'axis', 'bacon', 'badge', 'bagel', 'baker',
  'balcony', 'bamboo', 'banjo', 'barge', 'basil', 'basin', 'batch', 'beacon', 'beam', 'bean', 'bear', 'beech', 'belt', 'bench', 'berry', 'birch',
  'bison', 'blade', 'blaze', 'bloom', 'blue', 'board', 'bolt', 'bonus', 'boot', 'borrow', 'bottle', 'boulder', 'brace', 'brass', 'bread', 'brick',
  'bridge', 'brief', 'bright', 'bronze', 'brook', 'brush', 'bubble', 'bucket', 'buffer', 'bundle', 'burrow', 'butter', 'cabin', 'cable', 'cactus', 'camel',
  'candle', 'canoe', 'canvas', 'canyon', 'cargo', 'carrot', 'carve', 'castle', 'cedar', 'cellar', 'chalk', 'charm', 'cheese', 'cherry', 'chess', 'chime',
  'cider', 'cinder', 'circle', 'citrus', 'clay', 'clever', 'cliff', 'cloud', 'clover', 'coach', 'coast', 'cobalt', 'cocoa', 'coffee', 'coin', 'comet',
  'compass', 'copper', 'coral', 'cotton', 'cove', 'crane', 'crate', 'cream', 'crest', 'crisp', 'crown', 'crystal', 'cube', 'curve', 'cyan', 'daisy',
  'dawn', 'deck', 'delta', 'denim', 'desert', 'diamond', 'dock', 'dolphin', 'domain', 'donut', 'draft', 'dragon', 'drift', 'drum', 'dune', 'dusk',
  'eagle', 'earth', 'east', 'echo', 'eddy', 'elder', 'ember', 'emerald', 'engine', 'ermine', 'ether', 'fable', 'falcon', 'fjord', 'farm', 'feather',
  'fennel', 'fern', 'ferry', 'fiber', 'fiddle', 'field', 'fig', 'filter', 'finch', 'flame', 'flask', 'fleet', 'flint', 'float', 'flour', 'flute',
  'foam', 'forest', 'forge', 'fossil', 'fox', 'frame', 'frost', 'garden', 'garnet', 'gate', 'gecko', 'ginger', 'glacier', 'glass', 'glide', 'globe',
  'gold', 'grain', 'granite', 'grape', 'grass', 'gravel', 'green', 'grove', 'guitar', 'gulf', 'hammer', 'harbor', 'harvest', 'hazel', 'heather', 'hedge',
  'helm', 'heron', 'hollow', 'honey', 'horizon', 'hostel', 'ice', 'indigo', 'iris', 'iron', 'island', 'ivory', 'ivy', 'jade', 'jasper', 'jetty',
  'jewel', 'juniper', 'kayak', 'kelp', 'kernel', 'kettle', 'keystone', 'kite', 'lace', 'lagoon', 'lake', 'lamp', 'lantern', 'larch', 'laurel', 'lava',
  'ledge', 'lemon', 'lentil', 'level', 'lilac', 'lily', 'linen', 'lobby', 'locket', 'lodge', 'lotus', 'lumen', 'lunar', 'lyric', 'maple', 'marble',
] as const;

/**
 * A hard failure at import rather than a quiet weakening.
 *
 * If a word is ever added or removed, every word stops being worth 8 bits and the entropy this
 * module claims silently stops being true. That is precisely the kind of change nobody notices, so
 * it is made impossible instead of discouraged.
 */
if (WORDS.length !== 256) {
  throw new Error(`The passphrase wordlist must hold exactly 256 words; it holds ${WORDS.length}.`);
}
if (new Set(WORDS).size !== WORDS.length) {
  throw new Error('The passphrase wordlist contains a duplicate, so its words are not equally likely.');
}

/** Words per generated passphrase. Eight × 8 bits = 64 bits. */
export const PASSPHRASE_WORDS = 8;

/** How much entropy a generated passphrase carries, for the UI to state plainly. */
export const PASSPHRASE_BITS = PASSPHRASE_WORDS * 8;

/**
 * A fresh passphrase.
 *
 * One random byte per word, indexed directly into a 256-word list — so there is no modulo and
 * therefore no modulo bias, which is the usual way a generator like this ends up weaker than its
 * arithmetic claims.
 */
export function generatePassphrase(): string {
  const bytes = new Uint8Array(PASSPHRASE_WORDS);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => WORDS[b]).join('-');
}
