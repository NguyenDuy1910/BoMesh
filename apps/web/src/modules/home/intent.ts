/** Home's greeting (preview `home.js` header): pure, so the wording is testable. */

/** "Good morning" / "Good afternoon" / "Good evening" for the local hour. */
export function greeting(hour = new Date().getHours()): string {
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

/** How Home addresses someone: the given name (last word for three-part Vietnamese names, else the first; never a bare number). */
export function callName(name: string | undefined): string {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  const last = parts[parts.length - 1] ?? "";
  return parts.length >= 3 && /\p{L}/u.test(last) ? last : (parts[0] ?? "");
}
