/**
 * Wide-character-aware string utilities for terminal layouts.
 * Resolves the discrepancy between JavaScript's standard code unit length
 * and actual visual column width on terminal screens.
 */

/**
 * Returns the visual terminal width (in columns/cells) of a single Unicode code point.
 * 
 * - Control characters and zero-width characters return 0.
 * - CJK ideographs, Hiragana, Katakana, Hangul, and standard Emojis return 2.
 * - Standard ASCII, half-width forms, and basic symbols return 1.
 */
export function getCharWidth(codePoint: number): number {
  // Control characters
  if (codePoint >= 0x0000 && codePoint <= 0x001F) return 0;
  if (codePoint >= 0x007F && codePoint <= 0x009F) return 0;

  // Zero-width characters (combining marks, zero-width spaces, joiners, etc.)
  if (
    codePoint === 0x200B || // Zero Width Space
    codePoint === 0x200C || // Zero Width Non-Joiner
    codePoint === 0x200D || // Zero Width Joiner
    codePoint === 0x200E || // Left-to-Right Mark
    codePoint === 0x200F || // Right-to-Left Mark
    codePoint === 0xFEFF    // Byte Order Mark
  ) {
    return 0;
  }

  // CJK Unified Ideographs & Hangul
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115F) || // Hangul Jamo
    (codePoint >= 0x2E80 && codePoint <= 0x2EFF) || // CJK Radicals Supplement
    (codePoint >= 0x3000 && codePoint <= 0x303F) || // CJK Symbols and Punctuation (e.g., Ideographic Space)
    (codePoint >= 0x3040 && codePoint <= 0x309F) || // Hiragana
    (codePoint >= 0x30A0 && codePoint <= 0x30FF) || // Katakana
    (codePoint >= 0x3100 && codePoint <= 0x312F) || // Bopomofo
    (codePoint >= 0x3130 && codePoint <= 0x318F) || // Hangul Compatibility Jamo
    (codePoint >= 0x3200 && codePoint <= 0x32FF) || // Enclosed CJK Letters and Months
    (codePoint >= 0x3300 && codePoint <= 0x33FF) || // CJK Compatibility
    (codePoint >= 0x3400 && codePoint <= 0x4DBF) || // CJK Unified Ideographs Extension A
    (codePoint >= 0x4E00 && codePoint <= 0x9FFF) || // CJK Unified Ideographs
    (codePoint >= 0xAC00 && codePoint <= 0xD7A3) || // Hangul Syllables
    (codePoint >= 0xF900 && codePoint <= 0xFAFF) || // CJK Compatibility Ideographs
    (codePoint >= 0xFE10 && codePoint <= 0xFE19) || // Vertical forms
    (codePoint >= 0xFE30 && codePoint <= 0xFE4F) || // CJK Compatibility Forms
    (codePoint >= 0xFF00 && codePoint <= 0xFF60) || // Fullwidth Forms
    (codePoint >= 0xFFE0 && codePoint <= 0xFFE6) || // Fullwidth Symbols
    (codePoint >= 0x20000 && codePoint <= 0x2FFFD) || // CJK Extension B/C/D/E/F
    (codePoint >= 0x30000 && codePoint <= 0x3FFFD)
  ) {
    return 2;
  }

  // Emojis and Miscellaneous Symbols / Pictographs
  if (
    (codePoint >= 0x1F300 && codePoint <= 0x1F6FF) || // Misc Symbols and Pictographs, Transport and Map Symbols
    (codePoint >= 0x1F900 && codePoint <= 0x1F9FF) || // Supplemental Symbols and Pictographs
    (codePoint >= 0x1FA70 && codePoint <= 0x1FAFF) || // Symbols and Pictographs Extended-A
    (codePoint >= 0x2600 && codePoint <= 0x26FF) ||   // Misc Symbols (like ⚡ 0x26A1)
    (codePoint >= 0x2700 && codePoint <= 0x27BF) ||   // Dingbats
    (codePoint >= 0x2300 && codePoint <= 0x23FF) ||   // Miscellaneous Technical
    (codePoint >= 0x25B0 && codePoint <= 0x25FF) ||   // Geometric Shapes (includes ▶ 0x25B6)
    (codePoint >= 0x1F100 && codePoint <= 0x1F2FF)    // Enclosed Alphanumeric/Ideographic Supplement
  ) {
    return 2;
  }

  return 1;
}

/**
 * Calculates the visual column width of a string.
 * Strips ANSI color and formatting escape codes before counting.
 */
export function getStringVisualWidth(str: string): number {
  if (!str) return 0;
  
  // Regex to match and strip ANSI escape sequences
  const clean = str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
  
  let width = 0;
  // Iterate by code points to correctly parse surrogate pairs
  for (const char of clean) {
    const cp = char.codePointAt(0);
    if (cp !== undefined) {
      width += getCharWidth(cp);
    }
  }
  return width;
}

/**
 * Pads the right side of a string to a target visual terminal width.
 * Accounts for wide characters and ignores ANSI escape codes in the input.
 */
export function padEndVisual(str: string, targetWidth: number, padChar = " "): string {
  const currentWidth = getStringVisualWidth(str);
  if (currentWidth >= targetWidth) return str;
  return str + padChar.repeat(targetWidth - currentWidth);
}

/**
 * Pads the left side of a string to a target visual terminal width.
 * Accounts for wide characters and ignores ANSI escape codes in the input.
 */
export function padStartVisual(str: string, targetWidth: number, padChar = " "): string {
  const currentWidth = getStringVisualWidth(str);
  if (currentWidth >= targetWidth) return str;
  return padChar.repeat(targetWidth - currentWidth) + str;
}
