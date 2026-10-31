import { config } from './config.js';
import { loadDb, flush } from './db.js';
import { createApp } from './app.js';
import { getEmbedder } from './embeddings.js';
import { warmAgent } from './agent.js';
import { llmConfigured } from './llm.js';
import { smtpConfigured } from './mailer.js';

if (Number(process.versions.node.split('.')[0]) < 18) {
  console.error('Hirelens needs Node.js 18 or newer. Please upgrade from https://nodejs.org');
  process.exit(1);
}

loadDb();
const app = createApp();

const server = app.listen(config.port, config.host, () => {
  const url = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
  console.log(`\nHirelens is running at ${url}`);
  console.log(`  Groq key:    ${llmConfigured() ? 'found' : 'MISSING. Add GROQ_API_KEY to .env'}`);
  console.log(`  Email:       ${smtpConfigured() ? 'SMTP configured' : 'simulated (SMTP not set up)'}`);
  console.log('  Loading the embedding model in the background (first run downloads it)...\n');
  getEmbedder().then((e) => console.log(`  Embeddings:  ${e.mode === 'model' ? e.tag : 'keyword fallback'}`));
  warmAgent().then(() => {});
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${config.port} is already in use. Set PORT in .env to another number.`);
  else console.error(err);
  process.exit(1);
});

const bye = () => {
  flush();
  process.exit(0);
};
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
