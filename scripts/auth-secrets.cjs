const { randomBytes } = require('node:crypto');
const names = ['AUTH_ACCESS_SECRET','AUTH_REFRESH_SECRET','AUTH_RESET_SECRET'];
function valid(value) {
 return typeof value === 'string' && Buffer.byteLength(value)>=32 && !/change.?me|placeholder|replace.?me|your.?secret/i.test(value);
}
// Operator bootstrap primitive: persist the returned settings privately. Never
// generate signing secrets in the server's startup path or overwrite valid keys.
function ensureAuthSecrets(settings) {
 const result={...settings}; const seen=new Set();
 for(const name of names) {
  if(!valid(result[name]) || seen.has(result[name])) result[name]=randomBytes(64).toString('hex');
  seen.add(result[name]);
 }
 return result;
}
module.exports={ensureAuthSecrets};
