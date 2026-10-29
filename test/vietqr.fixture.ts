// Deterministic test-only encoding, never a bank transaction or real QR proof.
export function transferQr(amount: number, memo: string, bin = '000000', account = '000000000') {
  const tag = (id: string, value: string) => id + String(value.length).padStart(2, '0') + value;
  const receiver = tag('00', bin) + tag('01', account);
  const merchant = tag('00', 'A000000727') + tag('01', receiver) + tag('02', 'QRIBFTTA');
  const payload = tag('00', '01') + tag('01', '12') + tag('38', merchant) + tag('53', '704')
    + tag('54', String(amount)) + tag('58', 'VN') + tag('62', tag('08', memo)) + '6304';
  let crc = 0xffff;
  for (const byte of Buffer.from(payload)) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff;
  }
  return payload + crc.toString(16).toUpperCase().padStart(4, '0');
}
