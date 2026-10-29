// FUTURE OPERATOR ACTION. Never run at startup, migration, CI or local tests.
// This changes the merchant channel; the current local implementation task
// explicitly does not authorize executing it.
require('./load-env.cjs').loadEnvironment();
const { PayOS } = require('@payos/node');
const url='https://api.homemind.vn/v1/billing/payos/webhook';
async function main() {
 if(process.env.NODE_ENV!=='production' || process.env.PAYOS_ENABLED!=='true'
  || !process.argv.includes('--confirm-channel-change='+url)
  || !/^[a-f0-9]{40}$/.test(process.env.RELEASE_SHA||'')) throw Error('Review flags missing');
 const keys=['PAYOS_CLIENT_ID','PAYOS_API_KEY','PAYOS_CHECKSUM_KEY'].map(n=>process.env[n]?.trim());
 if(keys.some(v=>!v||/change.?me|placeholder|replace.?me/i.test(v)))throw Error('Credentials missing');
 const ready=await fetch('https://api.homemind.vn/v1/health/ready',{signal:AbortSignal.timeout(8000),redirect:'error'});
 const state=await ready.json();
 if(!ready.ok||state.status!=='ready'||ready.headers.get('x-homemind-revision')!==process.env.RELEASE_SHA)throw Error('Revision not verified');
 for(const path of ['return','cancel']) {
  const response=await fetch('https://api.homemind.vn/v1/billing/payos/'+path,{signal:AbortSignal.timeout(8000),redirect:'error'});
  if(!response.ok||!response.headers.get('content-type')?.includes('text/html'))throw Error('Public billing pages unavailable');
 }
 const client=new PayOS({clientId:keys[0],apiKey:keys[1],checksumKey:keys[2],baseURL:'https://api-merchant.payos.vn',maxRetries:0,timeout:10000,logLevel:'off'});
 await client.webhooks.confirm(url);
 console.log('payOS webhook confirmation completed for the reviewed public URL.');
}
main().catch(()=>{console.error('Webhook confirmation refused or failed. Verify reviewed flags, deployed revision, public routes and private channel credentials.');process.exitCode=1;});
