// ULIDs (https://github.com/ulid/spec): 48 bits of time and 80 random bits in Crockford base32, so
// entry ids sort by creation and are never reused.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID shape: 26 Crockford base32 characters. */
export const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function ulid(now = Date.now()): string {
  let time = "";
  let t = Math.max(0, Math.floor(now));
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const random = crypto.getRandomValues(new Uint8Array(16));
  let rest = "";
  for (let i = 0; i < 16; i++) rest += ALPHABET[(random[i] as number) % 32];
  return time + rest;
}
