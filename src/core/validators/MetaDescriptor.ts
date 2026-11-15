const DESCRIPTOR_OPEN = '<!--SINTER-META-DESCRIPTOR';
const DESCRIPTOR_CLOSE = '-->';

/** Remove only a leading descriptor so structural HTML validation sees the doctype. */
export function stripLeadingMetaDescriptor(code: string): string {
  const open = code.indexOf(DESCRIPTOR_OPEN);
  if (open === -1) return code;
  const close = code.indexOf(DESCRIPTOR_CLOSE, open + DESCRIPTOR_OPEN.length);
  if (close === -1 || code.slice(0, open).trim() !== '') return code;
  return code.slice(close + DESCRIPTOR_CLOSE.length).replace(/^\s+/, '');
}
