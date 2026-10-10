import { Hono } from 'hono';
import { hinatamaDiagnosis, type DiagnosisEnv } from './routes/hinatama-diagnosis.js';

// Separate entry point deliberately never imports the generic webhook or cron.
const app = new Hono<DiagnosisEnv>();
app.route('/', hinatamaDiagnosis);
app.onError(() => new Response('処理を完了できませんでした。診断ページからもう一度お試しください。', { status: 503, headers: { 'Cache-Control': 'no-store' } }));
export default app;
