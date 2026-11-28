/** GAM inventory codes are identifiers, not CSS selectors or JavaScript names.
 * Keep their exact spelling and escape only when rendering HTML/CSS.
 * https://developers.google.com/ad-manager/api/reference/v202508/InventoryService.AdUnitCodeError.Reason
 */
export function validateAdUnitCode(value) {
  if (typeof value !== 'string' || !value.length) return ['code is required.'];
  if (value.length > 100) return ['GAM ad unit code must be at most 100 characters.'];
  if (value.startsWith('/')) return ['GAM ad unit code cannot start with a forward slash.'];
  if (!/^[\p{L}\p{M}\p{N}_\-.*"\\/!<:()]+$/u.test(value)) {
    return ['Use a GAM ad unit code: letters, numbers, underscore, dash, period, asterisk, double quote, backslash, forward slash, exclamation mark, left angle bracket, colon or parentheses. Spaces are not allowed.'];
  }
  return [];
}

export function escapeCssId(value) {
  const errors = validateAdUnitCode(value);
  if (errors.length) throw Error(errors.join(' '));
  let escaped = '';
  for (let i = 0; i < value.length; i++) {
    const c = value[i], n = value.charCodeAt(i);
    if ((i === 0 && n >= 48 && n <= 57) || (i === 1 && n >= 48 && n <= 57 && value[0] === '-')) escaped += '\\' + n.toString(16) + ' ';
    else if (i === 0 && c === '-' && value.length === 1) escaped += '\\-';
    else if (n >= 128 || /[A-Za-z0-9_-]/.test(c)) escaped += c;
    else escaped += '\\' + c;
  }
  return '#' + escaped;
}

export const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
