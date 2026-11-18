// Zero-allocation single-pass word & CJK character counter shared by Markdown, DOCX, EPUB and DOC.

function isCjkCodePoint(cp: number): boolean {
  return (cp >= 0x3400 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff);
}

function isWordChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    code === 95 || // _
    code === 39 || // '
    code === 45 // -
  );
}

export function countDocumentWords(text: string): number {
  let words = 0;
  let inLatinWord = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (isCjkCodePoint(code)) {
      if (inLatinWord) {
        words++;
        inLatinWord = false;
      }
      words++;
    } else if (isWordChar(code)) {
      inLatinWord = true;
    } else if (inLatinWord) {
      words++;
      inLatinWord = false;
    }
  }
  if (inLatinWord) {
    words++;
  }
  return words;
}
