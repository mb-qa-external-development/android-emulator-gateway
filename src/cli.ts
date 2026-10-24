import { ensureCredentials, rotatePassword, rotateCiToken } from './auth.js';
import { DATA_DIR } from './config.js';

const command = process.argv[2];
if (command === 'init') { ensureCredentials(); console.log(DATA_DIR); }
else if (command === 'rotate-password') { console.log(`New password: ${rotatePassword()}`); }
else if (command === 'rotate-ci-token') { console.log(`New CI token: ${rotateCiToken()}`); }
else { console.error('Usage: npm run cli -- init|rotate-password|rotate-ci-token'); process.exitCode = 2; }
