const encoder = new TextEncoder();
const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const REQUIRED_MEMBER_NAMES = Object.freeze(['manifest.json', 'run-report.json', 'checksums.sha256']);

function cleanPath(value = '') {
  const path = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/').trim();
  if (!path || path.includes('..') || path.includes('\0')) throw new Error(`Unsafe ZIP member path: ${value}`);
  return path;
}

function bytesFrom(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string') return encoder.encode(value);
  throw new Error('ZIP member data must be text, Uint8Array, or ArrayBuffer.');
}

export function base64ToBytes(value = '') {
  const raw = String(value || '').replace(/^data:[^;,]+;base64,/, '').replace(/\s+/g, '');
  if (!raw) return new Uint8Array();
  if (typeof atob === 'function') {
    const binary = atob(raw);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return Uint8Array.from(Buffer.from(raw, 'base64'));
}

export function isVerifiedPngData(value) {
  let bytes;
  try { bytes = typeof value === 'string' ? base64ToBytes(value) : bytesFrom(value); } catch { return false; }
  return bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

export async function sha256Hex(value) {
  const bytes = bytesFrom(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value) { return Uint8Array.from([value & 0xff, (value >>> 8) & 0xff]); }
function u32(value) { return Uint8Array.from([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]); }

function concatBytes(...items) {
  const total = items.reduce((sum, item) => sum + item.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const item of items) { output.set(item, offset); offset += item.length; }
  return output;
}

function dosDateTime(value = Date.now()) {
  const date = new Date(value);
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Build a UTF-8, uncompressed ZIP. Store mode keeps the implementation
 * deterministic and works in a Chrome MV3 service worker without a library. */
export function buildZipBytes(members = [], now = Date.now()) {
  const local = [];
  const central = [];
  let offset = 0;
  const stamp = dosDateTime(now);
  for (const member of members) {
    const name = cleanPath(member.path);
    const nameBytes = encoder.encode(name);
    const data = bytesFrom(member.data);
    const crc = crc32(data);
    const localHeader = concatBytes(
      Uint8Array.from([0x50, 0x4b, 0x03, 0x04]),
      u16(20), u16(0x800), u16(0), u16(stamp.time), u16(stamp.date), u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), nameBytes,
    );
    local.push(localHeader, data);
    const centralHeader = concatBytes(
      Uint8Array.from([0x50, 0x4b, 0x01, 0x02]),
      u16(20), u16(20), u16(0x800), u16(0), u16(stamp.time), u16(stamp.date), u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBytes,
    );
    central.push(centralHeader);
    offset += localHeader.length + data.length;
  }
  const localBytes = concatBytes(...local);
  const centralBytes = concatBytes(...central);
  const end = concatBytes(
    Uint8Array.from([0x50, 0x4b, 0x05, 0x06]),
    u16(0), u16(0), u16(members.length), u16(members.length), u32(centralBytes.length), u32(localBytes.length), u16(0),
  );
  return concatBytes(localBytes, centralBytes, end);
}

function jsonBytes(value) {
  return encoder.encode(`${JSON.stringify(value && typeof value === 'object' ? value : {}, null, 2)}\n`);
}

function orderedScreenshotPath(path) {
  const normalized = cleanPath(path);
  if (!normalized.toLowerCase().endsWith('.png') || !normalized.startsWith('screenshots/')) throw new Error(`Screenshot must be a PNG under screenshots/: ${normalized}`);
  return normalized;
}

/**
 * Create the verified ZIP payload. Screenshot members are accepted only when
 * the caller has marked them verified and their bytes carry a real PNG header.
 */
export async function buildZipBundle({ manifest = {}, runReport = {}, screenshots = [], now = Date.now() } = {}) {
  const screenshotItems = Array.isArray(screenshots) ? screenshots : [];
  if (!screenshotItems.length) throw new Error('Missing required ZIP members: screenshots/*.png');
  const members = [
    { path: 'manifest.json', data: jsonBytes(manifest) },
    { path: 'run-report.json', data: jsonBytes(runReport) },
  ];
  const seen = new Set(members.map((member) => member.path));
  for (const screenshot of screenshotItems) {
    if (screenshot?.verified !== true) throw new Error(`Screenshot ${screenshot?.path || 'unknown'} is not verified.`);
    if (String(screenshot?.captureKind || '').trim().toLowerCase() !== 'assistant-response' || !String(screenshot?.responseId || '').trim()) {
      throw new Error(`Screenshot ${screenshot?.path || 'unknown'} is missing verified assistant-response evidence.`);
    }
    const path = orderedScreenshotPath(screenshot.path);
    if (seen.has(path)) throw new Error(`Duplicate ZIP member: ${path}`);
    let data;
    try {
      data = screenshot.bytes ? bytesFrom(screenshot.bytes) : base64ToBytes(screenshot.dataBase64 || screenshot.data || '');
    } catch {
      throw new Error(`Screenshot ${path} is not a valid PNG response-card payload.`);
    }
    if (!isVerifiedPngData(data)) throw new Error(`Screenshot ${path} is not a valid PNG response-card payload.`);
    seen.add(path);
    members.push({ path, data });
  }
  members.sort((left, right) => {
    if (left.path === 'manifest.json') return -1;
    if (right.path === 'manifest.json') return 1;
    if (left.path === 'run-report.json') return -1;
    if (right.path === 'run-report.json') return 1;
    return left.path.localeCompare(right.path);
  });
  const checksumLines = [];
  const checksums = [];
  for (const member of members) {
    const hash = await sha256Hex(member.data);
    checksums.push({ path: member.path, sha256: hash });
    checksumLines.push(`${hash}  ${member.path}`);
  }
  const checksumsText = `${checksumLines.join('\n')}\n`;
  members.push({ path: 'checksums.sha256', data: encoder.encode(checksumsText) });
  const requiredMissing = REQUIRED_MEMBER_NAMES.filter((name) => !members.some((member) => member.path === name));
  if (requiredMissing.length) throw new Error(`Missing required ZIP members: ${requiredMissing.join(', ')}`);
  const bytes = buildZipBytes(members, now);
  return {
    bytes,
    members,
    paths: members.map((member) => member.path),
    checksums,
    checksumsText,
    requiredMissing,
    fileCount: members.length,
    byteLength: bytes.length,
  };
}

export function bytesToBase64(value) {
  const bytes = bytesFrom(value);
  if (typeof btoa === 'function') {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
  return Buffer.from(bytes).toString('base64');
}
