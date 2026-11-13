/**
 * Sending email.
 *
 * In the demo every email goes to Mailpit, a fake inbox that runs in Docker:
 * open http://localhost:8025 to read what the app "sent". Nothing reaches real people.
 * To send real email, set SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_SECURE
 * in .env (e.g. Gmail, Brevo, Resend). No code change needed.
 *
 * The rest of the app only sees the small `Mailer` interface, so tests can swap in a
 * fake mailer that just collects messages.
 */
import nodemailer from 'nodemailer';

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain-text version (always included: some inboxes and screen readers prefer it). */
  text: string;
  html?: string;
  /** Extra email headers, e.g. List-Unsubscribe (the "Unsubscribe" button in Gmail). */
  headers?: Record<string, string>;
}

export interface Mailer {
  send(message: EmailMessage): Promise<void>;
}

export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

export function createMailer(settings: SmtpSettings): Mailer {
  const transport = nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure, // true = TLS from the start (port 465); false = plain or STARTTLS
    auth: settings.user ? { user: settings.user, pass: settings.pass } : undefined,
  });
  return {
    async send(message) {
      await transport.sendMail({ from: settings.from, ...message });
    },
  };
}

/** For tests: remembers every message instead of sending it. */
export function createMemoryMailer(): Mailer & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return {
    sent,
    async send(message) {
      sent.push(message);
    },
  };
}

/** Escapes text for safe use inside HTML emails. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * The mailer for OUTREACH emails to candidates. Sandbox (default): always Mailpit, even
 * if real SMTP is configured for sign-up emails, so testing never emails real people.
 * Live: the real SMTP settings.
 */
export function createOutreachMailer(
  outreach: { mode: 'sandbox' | 'live'; sandboxHost: string; sandboxPort: number },
  smtp: SmtpSettings,
): Mailer {
  return outreach.mode === 'live'
    ? createMailer(smtp)
    : createMailer({ host: outreach.sandboxHost, port: outreach.sandboxPort, secure: false, from: smtp.from });
}
