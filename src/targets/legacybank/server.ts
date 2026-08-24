/**
 * LegacyBank server — Express app with sessions, chaos injection, two tenants.
 *
 * Chaos controller (deterministic fault injection for evidence runs):
 *   POST /:tenant/admin/chaos  { "slowNext" | "interstitialNext" | "expireNow": true }
 * The REPLAY ENGINE never calls these — the demo harness does, to simulate
 * legitimate runtime conditions of a real institution's app.
 */
import express from 'express';
import crypto from 'node:crypto';
import { TENANTS, DEMO_USER, findMember, type TenantConfig } from './data.js';
import {
  loginPage,
  topNavPage,
  homePage,
  searchPage,
  resultsPage,
  detailPage,
  accessDeniedPage,
  newAccountPage,
  confirmOpenPage,
  accountOpenedPage,
  maintenancePage,
} from './pages.js';

interface Session {
  sid: string;
  tenantId: string;
  userId: string;
  lastSeen: number;
  chaos: { slowNext?: boolean; interstitialNext?: boolean; expireNow?: boolean };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenant?: TenantConfig;
      session?: Session;
    }
  }
}

const sessions = new Map<string, Session>();
const SESSION_COOKIE = 'lbsid';
const SESSION_TIMEOUT_MS = Number(process.env.LEGACYBANK_SESSION_TIMEOUT_MS ?? 120_000);
const SLOW_MS = Number(process.env.LEGACYBANK_SLOW_MS ?? 4000);

export function createLegacyBankApp(): express.Express {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  const tenantOf = (prefix: string): TenantConfig | undefined =>
    Object.values(TENANTS).find((t) => t.pathPrefix === prefix);

  // ---- session middleware -------------------------------------------------
  app.use((req, res, next) => {
    const prefix = '/' + (req.path.split('/')[1] ?? '');
    req.tenant = tenantOf(prefix);
    if (!req.tenant) {
      res.status(404).send('Unknown institution. Use /acme/... or /nw/...');
      return;
    }
    if (req.path.includes('/admin/chaos')) {
      next(); // chaos controller is test instrumentation — no session required
      return;
    }

    const sid = readCookie(req.headers.cookie, SESSION_COOKIE);
    let session = sid ? sessions.get(sid) : undefined;

    if (req.path.endsWith('/login.aspx')) {
      next(); // login page must be reachable when logged out (GET) and before session exists (POST)
      return;
    }

    if (session && session.chaos.expireNow) {
      sessions.delete(session.sid);
      session = undefined;
    } else if (session) {
      const idle = Date.now() - session.lastSeen;
      if (idle > SESSION_TIMEOUT_MS) {
        sessions.delete(session.sid);
        session = undefined;
      }
    }

    if (!session || session.tenantId !== req.tenant.id) {
      res.redirect(302, `${req.tenant.pathPrefix}/login.aspx?reason=session_expired`);
      return;
    }
    session.lastSeen = Date.now();
    req.session = session;
    next();
  });

  const sendWithSession = (
    req: express.Request,
    res: express.Response,
    body: string,
    opts: { newSession?: { tenantId: string; userId: string }; delay?: number; status?: number } = {}
  ): void => {
    const fire = () => {
      if (opts.newSession) {
        const sid = crypto.randomBytes(12).toString('hex');
        sessions.set(sid, {
          sid,
          tenantId: opts.newSession.tenantId,
          userId: opts.newSession.userId,
          lastSeen: Date.now(),
          chaos: {},
        });
        res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly`);
      }
      res.status(opts.status ?? 200).type('html').send(body);
    };
    if (opts.delay) setTimeout(fire, opts.delay);
    else fire();
  };

  /** Applies one-shot chaos flags to the current request. Returns delay if slowNext fired. */
  const applyChaos = (req: express.Request): number | undefined => {
    const s = req.session as Session | undefined;
    if (!s) return undefined;
    let delay: number | undefined;
    if (s.chaos.slowNext) delay = SLOW_MS;
    s.chaos.slowNext = false;
    return delay;
  };

  const interstitialGuard = (
    req: express.Request,
    res: express.Response,
    renderUrl: string
  ): boolean => {
    const s = req.session as Session | undefined;
    if (s?.chaos.interstitialNext) {
      s.chaos.interstitialNext = false;
      sendWithSession(req, res, maintenancePage(req.tenant!, renderUrl), { delay: applyChaos(req) });
      return true;
    }
    return false;
  };

  // ---- auth ----------------------------------------------------------------
  for (const tenant of Object.values(TENANTS)) {
    const p = tenant.pathPrefix;

    app.get(`${p}/login.aspx`, (req, res) => {
      const reason = new URL(req.url, 'http://x').searchParams.get('reason') ?? undefined;
      res.type('html').send(loginPage(tenant, reason ?? undefined));
    });

    app.post(`${p}/login.aspx`, (req, res) => {
      const userId = String(req.body['ctl00$ContentPlaceHolder1$txtUserId'] ?? '');
      const password = String(req.body['ctl00$ContentPlaceHolder1$txtPassword'] ?? '');
      if (userId === DEMO_USER.userId && password === DEMO_USER.password) {
        const sid = crypto.randomBytes(12).toString('hex');
        sessions.set(sid, {
          sid,
          tenantId: tenant.id,
          userId,
          lastSeen: Date.now(),
          chaos: {},
        });
        res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly`);
        res.redirect(302, `${p}/main.aspx`);
        return;
      }
      res
        .status(200)
        .type('html')
        .send(
          loginPage(tenant).replace(
            '</table>',
            '<tr><td colspan="2"><span class="err">Invalid user ID or password.</span></td></tr></table>'
          )
        );
    });

    app.get(`${p}/main.aspx`, (req, res) => {
      res
        .type('html')
        .send(
          `<html><head><title>${tenant.institutionName} Core</title></head>
<frameset rows="58,*" frameborder="1" border="1">
  <frame name="topFrame" src="${p}/topnav.aspx" scrolling="no">
  <frame name="content" src="${p}/home.aspx">
</frameset></html>`
        );
    });

    app.get(`${p}/topnav.aspx`, (req, res) => {
      const s = req.session!;
      res.type('html').send(topNavPage(tenant, s.userId));
    });

    app.get(`${p}/logoff.aspx`, (req, res) => {
      const s = req.session;
      if (s) sessions.delete(s.sid);
      res.redirect(302, `${p}/login.aspx?reason=session_expired`);
    });

    app.get(`${p}/home.aspx`, (req, res) => {
      if (interstitialGuard(req, res, `${p}/home.aspx`)) return;
      sendWithSession(req, res, homePage(tenant), { delay: applyChaos(req) });
    });

    app.get(`${p}/search.aspx`, (req, res) => {
      if (interstitialGuard(req, res, `${p}/search.aspx`)) return;
      sendWithSession(req, res, searchPage(tenant), { delay: applyChaos(req) });
    });

    app.post(`${p}/results.aspx`, (req, res) => {
      if (interstitialGuard(req, res, `${p}/results.aspx`)) return;
      const q = String(req.body['ctl00$ContentPlaceHolder1$txtMemberId'] ?? '').trim();
      const matches = q ? [findMember(q)].filter(Boolean) : [];
      sendWithSession(
        req,
        res,
        resultsPage(tenant, q, matches as never),
        { delay: applyChaos(req) }
      );
    });

    app.get(`${p}/detail.aspx`, (req, res) => {
      if (interstitialGuard(req, res, `${p}/detail.aspx?id=${String(req.query.id ?? '')}`)) return;
      const m = findMember(String(req.query.id ?? ''));
      if (!m) {
        res.redirect(302, `${p}/search.aspx`);
        return;
      }
      if (m.locked) {
        sendWithSession(req, res, accessDeniedPage(tenant, m), { delay: applyChaos(req) });
        return;
      }
      sendWithSession(req, res, detailPage(tenant, m), { delay: applyChaos(req) });
    });

    app.get(`${p}/newaccount.aspx`, (req, res) => {
      if (interstitialGuard(req, res, `${p}/newaccount.aspx?id=${String(req.query.id ?? '')}`))
        return;
      const m = findMember(String(req.query.id ?? ''));
      if (!m || m.locked) {
        res.redirect(302, `${p}/search.aspx`);
        return;
      }
      const back = req.query.back === '1';
      const vals = back
        ? {
            type: String(req.query.type ?? ''),
            nickname: String(req.query.nickname ?? ''),
            deposit: String(req.query.deposit ?? ''),
            debitCard: req.query.debitCard === 'on',
          }
        : {};
      sendWithSession(req, res, newAccountPage(tenant, m, { values: vals }), {
        delay: applyChaos(req),
      });
    });

    app.post(`${p}/newaccount.aspx`, (req, res) => {
      const m = findMember(String(req.query.id ?? ''));
      if (!m || m.locked) {
        res.redirect(302, `${p}/search.aspx`);
        return;
      }
      const type = String(req.body['ctl00$ContentPlaceHolder1$ddlAccountType'] ?? '');
      const nickname = String(req.body['ctl00$ContentPlaceHolder1$txtNickname'] ?? '').trim();
      const deposit = String(req.body['ctl00$ContentPlaceHolder1$txtInitialDeposit'] ?? '').trim();
      const debitCard = req.body['ctl00$ContentPlaceHolder1$chkDebitCard'] === 'on';

      // Server-side validation errors (legitimate runtime conditions):
      if (!type) {
        sendWithSession(req, res, newAccountPage(tenant, m, {
          error: 'Account type is required.',
          values: { type, nickname, deposit, debitCard },
        }));
        return;
      }
      if (!nickname) {
        sendWithSession(req, res, newAccountPage(tenant, m, {
          error: 'Nickname is required.',
          values: { type, nickname, deposit, debitCard },
        }));
        return;
      }
      const amount = Number(deposit.replace(/[$,]/g, ''));
      if (!Number.isFinite(amount) || amount <= 0) {
        sendWithSession(req, res, newAccountPage(tenant, m, {
          error: 'Initial deposit must be a positive amount.',
          values: { type, nickname, deposit, debitCard },
        }));
        return;
      }
      if (type === 'Money Market' && amount < 500) {
        sendWithSession(req, res, newAccountPage(tenant, m, {
          error: 'Money Market accounts require a minimum initial deposit of $500.00.',
          values: { type, nickname, deposit, debitCard },
        }));
        return;
      }
      const qs = `type=${encodeURIComponent(type)}&nickname=${encodeURIComponent(nickname)}&deposit=${encodeURIComponent(deposit)}${debitCard ? '&debitCard=on' : ''}`;
      res.redirect(302, `${p}/confirmopen.aspx?id=${m.id}&${qs}`);
    });

    app.get(`${p}/confirmopen.aspx`, (req, res) => {
      const m = findMember(String(req.query.id ?? ''));
      if (!m) {
        res.redirect(302, `${p}/search.aspx`);
        return;
      }
      sendWithSession(
        req,
        res,
        confirmOpenPage(tenant, m, {
          type: String(req.query.type ?? ''),
          nickname: String(req.query.nickname ?? ''),
          deposit: String(req.query.deposit ?? ''),
          debitCard: req.query.debitCard === 'on',
        }),
        { delay: applyChaos(req) }
      );
    });

    app.post(`${p}/openaccount.aspx`, (req, res) => {
      const m = findMember(String(req.query.id ?? ''));
      if (!m) {
        res.redirect(302, `${p}/search.aspx`);
        return;
      }
      const number = `0009${String(Math.floor(Math.random() * 9000000 + 1000000))}`;
      m.accounts.push({
        type: String(req.body.type ?? 'Savings') as never,
        number,
        balance: `$${Number(String(req.body.deposit ?? '0').replace(/[$,]/g, '') || 0).toFixed(2)}`,
      });
      sendWithSession(req, res, accountOpenedPage(tenant, m, number));
    });
  }

  // ---- chaos controller ----------------------------------------------------
  // Expires EVERY active session — lets the demo harness force a mid-flow
  // session timeout deterministically (the replay engine never calls this).
  app.post('/:tenant/admin/chaos-all', (req, res) => {
    const body = req.body as Record<string, boolean>;
    let n = 0;
    if (body.expireNow) {
      for (const s of sessions.values()) {
        s.chaos.expireNow = true;
        n += 1;
      }
    }
    res.json({ ok: true, sessionsMarked: n });
  });

  app.post('/:tenant/admin/chaos', (req, res) => {
    const tenant = tenantOf('/' + req.params.tenant);
    const sid = readCookie(req.headers.cookie, SESSION_COOKIE);
    const session = sid ? sessions.get(sid) : undefined;
    if (!tenant || !session) {
      res.status(400).json({ ok: false, error: 'no active session for tenant' });
      return;
    }
    const body = req.body as Record<string, boolean>;
    for (const key of ['slowNext', 'interstitialNext', 'expireNow'] as const) {
      if (body[key]) session.chaos[key] = true;
    }
    res.json({ ok: true, chaos: session.chaos });
  });

  app.get('/:tenant/admin/state', (_req, res) => {
    res.json({ activeSessions: sessions.size });
  });

  return app;
}

function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return undefined;
}

// Direct execution guard (source: server.ts | built: dist/.../server.js)
const port = Number(process.env.LEGACYBANK_PORT ?? 7788);
if (process.argv[1] && /server\.(ts|js)$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const app = createLegacyBankApp();
  app.listen(port, () => {
    console.log(`LegacyBank simulator on http://localhost:${port}/acme/login.aspx and /nw/login.aspx`);
  });
}

