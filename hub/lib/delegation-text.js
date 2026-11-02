'use strict';
// Legacy records have no origin/request metadata. Preserve the existing
// prefix/full-line boundaries; a quotation later in a message never counts.
const envelope = /^(?:【(?:渡した依頼|已交接的要求)：[^\r\n]*】|\[Delegated request: [^\r\n]*\])(?:\r?\n|$)/;
const isDelegated = text => /^(?:【(?:渡した依頼|已交接的要求)：|\[Delegated request: )/.test(String(text || ''));
const isEnvelopeLine = text => /^(?:【(?:渡した依頼|已交接的要求)：.+】|\[Delegated request: .+\])$/.test(String(text || ''));
const unwrap = text => String(text || '').replace(envelope, '');
module.exports = { isDelegated, isEnvelopeLine, unwrap };
