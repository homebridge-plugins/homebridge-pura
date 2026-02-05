import { rmSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

const distPath = fileURLToPath(new URL('../dist', import.meta.url));
rmSync(distPath, { recursive: true, force: true });
