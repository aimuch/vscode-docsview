import WordExtractor from 'word-extractor';

/**
 * Legacy binary .doc: pure-JS libraries can only recover the text streams, not layout.
 * Returns the body followed by footnotes/endnotes when present.
 */
export async function extractDocText(bytes: Uint8Array): Promise<string> {
  const doc = await new WordExtractor().extract(Buffer.from(bytes));
  const parts = [doc.getBody()];
  for (const extra of [doc.getFootnotes(), doc.getEndnotes()]) {
    if (extra && extra.trim()) {
      parts.push(extra);
    }
  }
  return parts
    .join('\n\n')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
