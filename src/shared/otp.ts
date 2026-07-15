// Extract verification codes and confirmation links from email content.
// Heuristic by nature: scores candidates by proximity to signal words and
// shape (6-digit codes beat 4-digit years, links with "verify" beat logos).

export interface OtpExtraction {
  code: string | null;
  link: string | null;
}

const CODE_KEYWORDS =
  /\b(code|otp|pin|passcode|password|verification|verify|confirm|confirmation|2fa|one[- ]?time|security|activation|token)\b/gi;

const LINK_POSITIVE =
  /(verify|verification|confirm|activate|activation|validate|magic|invite|welcome|signup|sign-up|register|onboard|token=|code=|auth)/i;

const LINK_NEGATIVE =
  /(unsubscribe|preferences|privacy|terms|support|help|logo|image|img|facebook|twitter|linkedin|instagram|youtube|\.png|\.jpg|\.gif|fonts|mailto:)/i;

export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|td)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*/g, "\n")
    .trim();
}

function extractHrefs(html: string): string[] {
  const hrefs: string[] = [];
  const re = /href\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) hrefs.push(m[1]!);
  return hrefs;
}

function keywordPositions(text: string): number[] {
  const positions: number[] = [];
  CODE_KEYWORDS.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CODE_KEYWORDS.exec(text)) !== null) positions.push(m.index);
  return positions;
}

interface CodeCandidate {
  value: string;
  score: number;
}

function urlRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const re = /https?:\/\/[^\s"'<>\])]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

export function extractCode(subject: string, text: string): string | null {
  const combined = `${subject}\n${text}`;
  const keywords = keywordPositions(combined.toLowerCase());
  if (keywords.length === 0) return null;
  const urls = urlRanges(combined);

  const candidates: CodeCandidate[] = [];
  // Digit codes (possibly split like "123 456" or "123-456"), and
  // uppercase alphanumeric codes containing at least one digit (e.g. "7GX4KQ").
  const patterns = [
    /\b(\d{3}[ -]\d{3})\b/g,
    /\b(\d{4,8})\b/g,
    /\b([A-Z0-9]{5,8})\b/g,
  ];

  for (const re of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(combined)) !== null) {
      const raw = m[1]!;
      const idx = m.index;
      const value = raw.replace(/[ -]/g, "");
      if (!/\d/.test(value)) continue;
      // Years and obviously non-code numbers.
      if (/^(19|20)\d{2}$/.test(value)) continue;
      // Skip numbers that are part of a URL (tracking ids, ports, paths).
      if (urls.some(([start, end]) => idx >= start && idx < end)) continue;

      const dist = Math.min(...keywords.map((k) => Math.abs(k - idx)));
      if (dist > 300) continue;

      let score = 300 - dist;
      if (value.length === 6) score += 120;
      else if (value.length === 5 || value.length === 7) score += 60;
      else if (value.length === 4 || value.length === 8) score += 40;
      if (/^\d+$/.test(value)) score += 50;
      if (m.index < subject.length) score += 80; // appeared in the subject line
      candidates.push({ value, score });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]!.value;
}

export function extractLink(text: string, html: string): string | null {
  const urls = new Set<string>();
  const re = /https?:\/\/[^\s"'<>\])]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) urls.add(m[0]);
  for (const href of extractHrefs(html)) urls.add(href);

  let best: string | null = null;
  let bestScore = 0;
  for (const url of urls) {
    if (LINK_NEGATIVE.test(url)) continue;
    if (!LINK_POSITIVE.test(url)) continue;
    let score = 1;
    if (/verify|confirm|activate/i.test(url)) score += 3;
    if (/token=|code=/i.test(url)) score += 2;
    if (url.length > 40) score += 1; // signed links tend to be long
    if (score > bestScore) {
      bestScore = score;
      best = url;
    }
  }
  return best;
}

export function extractOtp(subject: string | null, textBody: string | null, htmlBody: string | null): OtpExtraction {
  const subj = subject ?? "";
  const html = htmlBody ?? "";
  const text = textBody && textBody.trim().length > 0 ? textBody : htmlToText(html);
  return {
    code: extractCode(subj, text),
    link: extractLink(text, html),
  };
}
