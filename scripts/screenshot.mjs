import {call,close} from './cdp.mjs';import fs from 'node:fs';let r=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(process.argv[2],Buffer.from(r.result.data,'base64'));close();
