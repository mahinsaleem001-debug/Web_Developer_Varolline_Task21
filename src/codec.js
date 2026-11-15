'use strict';
// Maps a sequential counter to a 7-char base62 code. Multiplying by a number coprime to
// 62^7 (=2^7 * 31^7) is a bijection, so codes never collide, yet are not sequential/guessable.
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LEN = 7;
const SPACE = 62n ** BigInt(LEN); // ~3.5 trillion codes
const MULT = 2654435761n;         // odd, and not divisible by 31
const OFFSET = 12345n;

function encode(counter) {
  let n = (BigInt(counter) * MULT + OFFSET) % SPACE;
  let out = '';
  for (let i = 0; i < LEN; i++) { out = ALPHABET[Number(n % 62n)] + out; n /= 62n; }
  return out;
}
const ALIAS_RE = /^[A-Za-z0-9_-]{3,32}$/;
module.exports = { encode, ALIAS_RE, SPACE };
