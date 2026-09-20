// Verify a provider-signed transfer payload. Never construct payment QR data.
export function memoMatches(requested: string, canonical: unknown): canonical is string {
  if (typeof canonical !== 'string' || !canonical || canonical.length > 200) return false;
  if (canonical === requested) return true;
  if (!requested || !canonical.endsWith(requested)) return false;
  return /^[A-Z0-9]{1,32} $/.test(canonical.slice(0, -requested.length));
}

export function qrTags(value: string): Map<string, string> {
  const result = new Map<string, string>();
  for (let offset = 0; offset < value.length;) {
    const header = value.slice(offset, offset + 4);
    if (!/^\d{4}$/.test(header)) throw new Error('PROVIDER_IDENTITY_CONFLICT');
    const key = header.slice(0, 2), size = Number(header.slice(2)); offset += 4;
    if (result.has(key) || offset + size > value.length) throw new Error('PROVIDER_IDENTITY_CONFLICT');
    result.set(key, value.slice(offset, offset + size)); offset += size;
  }
  return result;
}

export function verifyTransferQr(data: { qrCode: string; amount: number; bin: string; accountNumber: string; description: string }): void {
  try {
    const value = data.qrCode;
    if (!/^[\x20-\x7e]{1,4096}$/.test(value) || !/6304[A-F0-9]{4}$/.test(value)) throw new Error();
    let crc = 0xffff;
    for (const byte of Buffer.from(value.slice(0, -4))) {
      crc ^= byte << 8;
      for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff;
    }
    const root = qrTags(value), merchant = qrTags(root.get('38') ?? '');
    const receiver = qrTags(merchant.get('01') ?? ''), extra = qrTags(root.get('62') ?? '');
    if (root.get('63') !== crc.toString(16).toUpperCase().padStart(4, '0')
      || root.get('53') !== '704' || root.get('58') !== 'VN' || merchant.get('00') !== 'A000000727'
      || !/^\d+(?:\.0+)?$/.test(root.get('54') ?? '') || Number(root.get('54')) !== data.amount
      || receiver.get('00') !== data.bin || receiver.get('01') !== data.accountNumber
      || extra.get('08') !== data.description) throw new Error();
  } catch { throw new Error('PROVIDER_IDENTITY_CONFLICT'); }
}
