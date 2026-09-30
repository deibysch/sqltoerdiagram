// A helper worker for Refine on several cores: refine-parallel.js does the work.

import { createRefineHelper } from './refine-parallel.js';

const handle = createRefineHelper((answer) => self.postMessage(answer));
self.onmessage = (e) => handle(e.data);
