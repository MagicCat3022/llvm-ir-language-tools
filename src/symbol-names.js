'use strict';

// Compare LLVM IR identifiers by bytes, not display spelling. A quoted "0" is a
// name, whereas bare 0 is a module/function-local numbered slot.
function nameBytes(name) {
  const sigil = /^[%@!#]/.test(name) ? name[0] : '';
  const value = sigil ? name.slice(1) : name;
  if (!value.startsWith('"')) return Buffer.from(value, 'utf8');
  const pieces = value.slice(1, -1).match(/\\[a-f\d]{2}|[^\\]+/gi) || [];
  return Buffer.concat(pieces.map(piece => piece.startsWith('\\')
    ? Buffer.from([parseInt(piece.slice(1), 16)]) : Buffer.from(piece, 'utf8')));
}
function canonicalName(name) {
  if (name == null) return '';
  const sigil = /^[%@!#]/.test(name) ? name[0] : '';
  const value = sigil ? name.slice(1) : name;
  return /^\d+$/.test(value) ? sigil + 'number:' + value : sigil + 'name:' + nameBytes(name).toString('hex');
}
function decodedName(name) { return nameBytes(name).toString('utf8'); }
module.exports = { canonicalName, decodedName };
