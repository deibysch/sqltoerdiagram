// A helper worker for Optimal Route on several cores: route-helper.js does the work.

import { createRouteHelper } from './route-helper.js';

const handle = createRouteHelper((answer) => self.postMessage(answer));
self.onmessage = (e) => handle(e.data);

// Up: until now the coordinator did the work itself.
self.postMessage({ type: 'ready' });
