import 'dotenv/config';
import { createApp } from './app.js';

const port = Number(process.env.API_PORT ?? 3001);
const app = await createApp();
app.listen(port, '127.0.0.1', () => console.log(`Mockup Automation API: http://localhost:${port}`));
