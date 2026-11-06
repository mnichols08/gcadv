/* Cloudflare Pages adapter for the trail app's backup. It stays inactive, answering 503, until the
 * HIKE_DB and HIKE_BUCKET bindings and the three settings below exist. See apps/trails/README.md. */
import { createBackupHandler } from '../../../../apps/trails/server/backup-core.mjs';
import { d1Store, r2Bucket } from '../../../../apps/trails/server/d1-store.mjs';

function sendCodeWith(env) {
  return async (email, code) => {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.HIKE_MAIL_FROM,
        to: [email],
        subject: `${code} is your Garrett County Adventures sign-in code`,
        text: `Your Garrett County Adventures sign-in code is ${code}.\n\nIt works for 10 minutes. If you didn't ask for it, you can ignore this email.`,
      }),
    });
    if (!response.ok) throw new Error('Mail provider refused the message');
  };
}

function sendNoticeWith(env) {
  return async email => {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.HIKE_MAIL_FROM,
        to: [email],
        subject: 'New sign-in to your trail app backup',
        text: "A phone just signed in to your trail app backup.\n\nIf that was you, there's nothing to do. If it wasn't, open the trail app, go to More, then Backup, and choose Sign out other phones. Then contact us.",
      }),
    });
  };
}

export async function onRequest({ request, env }) {
  if (!env.HIKE_DB || !env.HIKE_BUCKET || !env.RESEND_API_KEY || !env.HIKE_MAIL_FROM || !env.HIKE_CODE_PEPPER) {
    return new Response(JSON.stringify({ error: 'backup_unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }
  const handle = createBackupHandler({
    store: d1Store(env.HIKE_DB),
    bucket: r2Bucket(env.HIKE_BUCKET),
    sendCode: sendCodeWith(env),
    sendNotice: sendNoticeWith(env),
    // Raise this to match the mail plan. The default suits a small free allowance.
    limits: Number(env.HIKE_MAIL_PER_DAY) > 0 ? { mailPerDay: Number(env.HIKE_MAIL_PER_DAY) } : {},
    pepper: env.HIKE_CODE_PEPPER,
  });
  return handle(request);
}
