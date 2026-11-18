import { cpSync, mkdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const path = (relative) => new URL(relative, root);
mkdirSync(path('dist/'), { recursive: true });
for (const file of ['index.cjs', 'model-host.cjs']) cpSync(path(`src/${file}`), path(`dist/${file}`));
cpSync(path('src/table/'), path('dist/table/'), { recursive: true });
