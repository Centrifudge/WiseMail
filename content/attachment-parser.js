/**
 * attachment-parser.js — Plain-text extractors for email attachments
 *
 * Loaded before content.js. Defines cgExtractPDFText and cgExtractDocxText
 * in content-script scope so content.js can call them directly.
 *
 * No IIFE — intentionally exposes these functions to the shared
 * content-script scope (not the page's scope).
 */

/**
 * Extracts plain text from a PDF ArrayBuffer using BT/ET operator parsing.
 * Works for PDFs with standard Type 1 / TrueType text encoding.
 * Returns empty string for scanned images or encrypted documents.
 */
function cgExtractPDFText(buffer) {
  let raw;
  try {
    // Clone into content-script compartment to avoid Firefox Xray errors
    raw = new TextDecoder("latin1").decode(new Uint8Array(new Uint8Array(buffer)));
  } catch {
    return "";
  }

  const parts = [];
  const btEtRegex = /BT\s([\s\S]*?)ET/g;
  let block;
  while ((block = btEtRegex.exec(raw)) !== null) {
    // Match (string)Tj  or  [(string)]TJ  operators
    const tjRegex = /\(([^)\\]*(?:\\.[^)\\]*)*)\)\s*Tj|\[([^\]]*)\]\s*TJ/g;
    let match;
    while ((match = tjRegex.exec(block[1])) !== null) {
      const raw2 = match[1] || match[2] || "";
      const decoded = raw2
        .replace(/\\n/g, " ").replace(/\\r/g, " ").replace(/\\t/g, " ")
        .replace(/\\\(/g, "(").replace(/\\\)/g, ")").replace(/\\\\/g, "\\")
        .replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
      if (decoded.trim()) parts.push(decoded.trim());
    }
  }

  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Extracts plain text from a DOCX ArrayBuffer by locating and decompressing
 * the word/document.xml entry inside the ZIP container.
 */
async function cgExtractDocxText(buffer) {
  // Clone buffer into content-script compartment to avoid Firefox Xray wrapper errors
  const raw = new Uint8Array(new Uint8Array(buffer));
  const target = "word/document.xml";
  let pos = 0;

  while (pos < raw.length - 30) {
    // ZIP local file header signature: PK\x03\x04
    if (raw[pos] !== 0x50 || raw[pos+1] !== 0x4b || raw[pos+2] !== 0x03 || raw[pos+3] !== 0x04) {
      pos++; continue;
    }
    const compMethod = raw[pos+8]  | (raw[pos+9]  << 8);
    const compSize   = raw[pos+18] | (raw[pos+19] << 8) | (raw[pos+20] << 16) | (raw[pos+21] << 24);
    const nameLen    = raw[pos+26] | (raw[pos+27] << 8);
    const extraLen   = raw[pos+28] | (raw[pos+29] << 8);
    const nameStart  = pos + 30;
    const fileName   = new TextDecoder().decode(raw.slice(nameStart, nameStart + nameLen));
    const dataStart  = nameStart + nameLen + extraLen;

    if (fileName === target) {
      const compData = raw.slice(dataStart, dataStart + compSize);
      let xml = "";

      if (compMethod === 0) {
        xml = new TextDecoder().decode(compData);
      } else if (compMethod === 8) {
        try {
          const ds = new DecompressionStream("deflate-raw");
          const writer = ds.writable.getWriter();
          writer.write(compData);
          writer.close();
          const chunks = [];
          const reader = ds.readable.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
          }
          const total = chunks.reduce((n, c) => n + c.length, 0);
          const out = new Uint8Array(total);
          let off = 0;
          for (const c of chunks) { out.set(c, off); off += c.length; }
          xml = new TextDecoder().decode(out);
        } catch {
          return "";
        }
      }

      return xml
        .replace(/<\/w:p>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }
    pos = dataStart + Math.max(compSize, 1);
  }
  return "";
}
