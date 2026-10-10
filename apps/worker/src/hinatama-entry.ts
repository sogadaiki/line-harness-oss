import { Hono } from 'hono';
import { diagnosisRecovery, hinatamaDiagnosis, type DiagnosisEnv } from './routes/hinatama-diagnosis.js';
import harness, { type Env } from './index.js';
import { account } from './services/hinatama-diagnosis.js';

// Dedicated DB and account. The generic webhook is never exposed and no cron is installed.
const app = new Hono<DiagnosisEnv>();
app.route('/', hinatamaDiagnosis);
app.onError((_error,c) => diagnosisRecovery(c,'接続を完了できませんでした。少し時間をおいてから診断ページへ戻るか、LINEでスタッフにご相談ください。',503));
export default {
  async fetch(request: Request, env: DiagnosisEnv['Bindings'] & Env['Bindings'], ctx: ExecutionContext) {
    const path = new URL(request.url).pathname;
    if (path === '/health' || path.startsWith('/hinatama/diagnosis/')) return app.fetch(request, env, ctx);
    if (path.startsWith('/api/') || path.startsWith('/auth/staff/') || path.startsWith('/t/')) {
      const target = await account(env);
      if (!target || env.SCOPED_LINE_ACCOUNT_ID !== target.id) return new Response('Account scope not configured', { status: 503 });
      if (path==='/api/account-stop') return Response.json({success:false,error:'Use /api/diagnosis/pause for this dedicated receiver'},{status:409});
      return harness.fetch(request, env, ctx);
    }
    return new Response('Not found', { status: 404 });
  },
};
