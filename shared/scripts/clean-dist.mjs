import fs from 'node:fs';
import path from 'node:path';

const target = process.argv[2] ?? 'dist';
const dir = path.resolve(process.cwd(), target);
fs.rmSync(dir, { recursive: true, force: true });
