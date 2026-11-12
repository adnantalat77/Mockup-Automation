import { config as loadEnvironment } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

loadEnvironment({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });

const port = Number(process.env.API_PORT ?? 3001);
const app = await createApp();
app.listen(port, '127.0.0.1', () => console.log(`Mockup Automation API: http://127.0.0.1:${port}`));
