import {providers} from './core.js';
const command=process.argv[2];
if(command==='check') console.log(JSON.stringify({ok:true,node:process.versions.node,providers}));
else if(command==='discover') console.log('Provider catalogs require configured credentials. Supported: '+providers.join(', '));
else if(command==='review'){console.error('Review requires --repo OWNER/NAME --pr NUMBER and a configured GitHub App.');process.exitCode=2;}
else if(command==='serve'){console.error('Hosted webhook server is not configured yet; see docs/setup.md');process.exitCode=2;}
else console.log('review-app <check|discover|review|serve>');
