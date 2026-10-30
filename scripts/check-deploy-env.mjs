import { loadEnv } from 'vite';
import { validateDeploymentEnv } from './deploy-env.mjs';
const errors = validateDeploymentEnv({ ...loadEnv('production', process.cwd(), 'VITE_'), ...process.env });
if (errors.length) {
  console.error('Vercel configuration check failed:\n' + errors.map(error => `- ${error}`).join('\n'));
  process.exitCode = 1;
} else console.log('Vercel frontend environment is configured. Server credentials were not inspected.');
