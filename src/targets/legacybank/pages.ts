/**
 * LegacyBank — hostile HTML renderers.
 * Server-rendered, table-based layout, WebForms-style control naming, zero test ids,
 * <frameset> shell, native confirm() on the irreversible step. No client framework.
 */
import type { Member, TenantConfig } from './data.js';

const VIEWSTATE =
  '/wEPDwULLTE3NjE5NzY0ODNkZGQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export function page(tenant: TenantConfig, title: string, body: string): string {
  return `<!DOCTYPE html>
<html>
<head><title>${tenant.institutionName} - ${title}</title>
<meta http-equiv="Generator" content="Microsoft Visual Studio .NET 7.1">
<meta http-equiv="Cache-Control" content="no-store">
<style>
 body{font-family:"Tahoma","Segoe UI",Arial;font-size:11pt;background:#f4f2ec;margin:0}
 td{font-size:10.5pt;padding:4px}
 .grid{border-collapse:collapse;background:#fff}
 .grid td{border:1px solid #b9b4a5}
 .grid tr.hdr td{background:#d8d3c2;font-weight:bold}
 .err{color:#b00020;font-weight:bold}
 .ok{color:#1a6b3c;font-weight:bold}
 a{color:${tenant.themeColor}}
 .btn{background:${tenant.themeColor};color:#fff;border:1px solid #333;font-family:Tahoma;padding:2px 10px}
 h1{font-size:13pt;color:${tenant.themeColor}}
 .hdrbar{background:${tenant.themeColor};color:#fff;padding:6px 10px;font-family:Tahoma;font-size:11pt}
</style></head>
<body>
${body}
</body></html>`;
}

export function viewstate(): string {
  return `<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="${VIEWSTATE}" />`;
}

export function loginPage(tenant: TenantConfig, reason?: string): string {
  const msg =
    reason === 'session_expired'
      ? '<tr><td colspan="2"><span class="err">Your session has expired. Please sign in again.</span></td></tr>'
      : '';
  return page(
    tenant,
    'Operator Sign-In',
    `<form method="post" action="${tenant.pathPrefix}/login.aspx" id="frmLogin">
<table cellpadding="0" cellspacing="0" width="360" align="center" style="margin-top:90px">
<tr><td colspan="2"><div class="hdrbar">${tenant.institutionName} &mdash; ${tenant.vendorProduct}</div></td></tr>
${msg}
<tr><td>User ID:</td><td><input type="text" name="ctl00$ContentPlaceHolder1$txtUserId" id="ctl00_ContentPlaceHolder1_txtUserId" size="18" autocomplete="off"></td></tr>
<tr><td>Password:</td><td><input type="password" name="ctl00$ContentPlaceHolder1$txtPassword" id="ctl00_ContentPlaceHolder1_txtPassword" size="18"></td></tr>
<tr><td></td><td><input type="submit" name="ctl00$ContentPlaceHolder1$btnSignIn" value="${tenant.labels.signInButton}" id="ctl00_ContentPlaceHolder1_btnSignIn" class="btn"></td></tr>
</table>${viewstate()}</form>`
  );
}

export function topNavPage(tenant: TenantConfig, user: string): string {
  return `<!DOCTYPE html><html><head><title>nav</title><style>
 body{font-family:Tahoma;background:${tenant.themeColor};margin:0}
 a{color:#fff;margin-left:14px;text-decoration:none;font-size:10.5pt}
 span{color:#e8e6da;margin-right:14px;font-size:9.5pt}
</style></head><body style="padding:8px 12px">
<b style="color:#fff;font-size:10.5pt">${tenant.institutionName}</b>
<a href="${tenant.pathPrefix}/search.aspx" target="content">${tenant.labels.membersNavLink}</a>
<a href="${tenant.pathPrefix}/reports.aspx" target="content">Reports</a>
<span>| ${user}</span>
<a href="${tenant.pathPrefix}/logoff.aspx" target="_top">Log Off</a>
</body></html>`;
}

export function homePage(tenant: TenantConfig): string {
  return page(
    tenant,
    'Home',
    `<table width="100%" cellspacing="0"><tr><td>
<h1>Branch Operations Home</h1>
<table class="grid" width="60%">
<tr class="hdr"><td>Teller Queue</td><td>Items</td></tr>
<tr><td>Pending member requests</td><td>3</td></tr>
<tr><td>Overdraft reviews</td><td>1</td></tr>
<tr><td>End-of-day batch</td><td>Scheduled 18:00 ET</td></tr>
</table>
<p>Use <a href="${tenant.pathPrefix}/search.aspx">Member Search</a> to service a member record.</p>
</td></tr></table>`
  );
}

/** One-shot interstitial injected by the chaos controller (transient condition). */
export function maintenancePage(tenant: TenantConfig, resumeUrl: string): string {
  return page(
    tenant,
    'Scheduled Maintenance',
    `<table align="center" style="margin-top:80px" cellpadding="8"><tr><td bgcolor="#fdf3d7">
<b>Scheduled maintenance in progress.</b><br>
Some functions may be temporarily unavailable.<br><br>
<a href="${resumeUrl}">Continue to LegacyBank Core</a>
</td></tr></table>`
  );
}

export function searchPage(tenant: TenantConfig): string {
  return page(
    tenant,
    'Member Search',
    `<h1>${tenant.labels.membersNavLink}</h1>
<form method="post" action="${tenant.pathPrefix}/results.aspx">
<table cellspacing="2">
<tr><td>${tenant.labels.memberIdLabel}</td>
<td><input type="text" name="ctl00$ContentPlaceHolder1$txtMemberId" id="ctl00_ContentPlaceHolder1_txtMemberId" maxlength="10" size="12"></td></tr>
<tr><td></td><td><input type="submit" name="ctl00$ContentPlaceHolder1$btnSearch" value="${tenant.labels.searchButton}" id="ctl00_ContentPlaceHolder1_btnSearch" class="btn"></td></tr>
</table>${viewstate()}</form>`
  );
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function resultsPage(
  tenant: TenantConfig,
  queryId: string,
  members: Member[]
): string {
  if (members.length === 0) {
    return page(
      tenant,
      tenant.labels.resultsHeading,
      `<h1>${tenant.labels.resultsHeading}</h1>
<span class="err">No matching member records were found for "${esc(queryId)}".</span>
<p><a href="${tenant.pathPrefix}/search.aspx">Return to search</a></p>`
    );
  }
  const rows = members
    .map((m) => {
      const i = members.indexOf(m);
      const r = String(i + 2).padStart(2, '0');
      return `<tr>
<td><a href="${tenant.pathPrefix}/detail.aspx?id=${m.id}" id="ctl00_ContentPlaceHolder1_grdResults_ctl${r}_lnkSelect">Select</a></td>
<td><span id="ctl00_ContentPlaceHolder1_grdResults_ctl${r}_lblMemberId">${esc(m.id)}</span></td>
<td><span id="ctl00_ContentPlaceHolder1_grdResults_ctl${r}_lblName">${esc(m.lastName)}, ${esc(m.firstName)}</span></td>
<td><span id="ctl00_ContentPlaceHolder1_grdResults_ctl${r}_lblStatus">${m.status}</span></td>
</tr>`;
    })
    .join('\n');
  return page(
    tenant,
    tenant.labels.resultsHeading,
    `<h1>${tenant.labels.resultsHeading}</h1>
<table class="grid" width="70%">
<tr class="hdr"><td>&nbsp;</td><td>Member</td><td>Name</td><td>Status</td></tr>
${rows}
</table>
<p><a href="${tenant.pathPrefix}/search.aspx">New search</a></p>`
  );
}

export function accessDeniedPage(tenant: TenantConfig, m: Member): string {
  return page(
    tenant,
    'Access Denied',
    `<h1>Member Record</h1>
<div class="err">ACCESS DENIED: This record is under compliance hold and requires supervisor privileges.</div>
<p>Record reference ${esc(m.id)}.</p>
<p><a href="${tenant.pathPrefix}/search.aspx">Return to search</a></p>`
  );
}

export function detailPage(tenant: TenantConfig, m: Member): string {
  const accounts =
    m.accounts.length === 0
      ? '<tr><td colspan="3">No open accounts.</td></tr>'
      : m.accounts
          .map(
            (a, i) => `<tr>
<td><span id="ctl00_ContentPlaceHolder1_grdAccounts_ctl${String(i + 2).padStart(2, '0')}_lblType">${a.type}</span></td>
<td><span id="ctl00_ContentPlaceHolder1_grdAccounts_ctl${String(i + 2).padStart(2, '0')}_lblNumber">${a.number}</span></td>
<td align="right"><span id="ctl00_ContentPlaceHolder1_grdAccounts_ctl${String(i + 2).padStart(2, '0')}_lblBalance">${a.balance}</span></td>
</tr>`
          )
          .join('\n');
  return page(
    tenant,
    `Member Detail - ${m.lastName}`,
    `<h1>Member Detail</h1>
<table class="grid" width="55%">
<tr><td>Member ID</td><td><span id="ctl00_ContentPlaceHolder1_lblMemberId">${esc(m.id)}</span></td></tr>
<tr><td>Name</td><td><span id="ctl00_ContentPlaceHolder1_lblFullName">${esc(m.firstName)} ${esc(m.lastName)}</span></td></tr>
<tr><td>Member since</td><td>${esc(m.since)}</td></tr>
<tr><td>Status</td><td>${esc(m.status)}</td></tr>
</table>
<h2>Accounts</h2>
<table class="grid" width="55%">
<tr class="hdr"><td>Account Type</td><td>Number</td><td>Balance</td></tr>
${accounts}
</table>
<p><a href="${tenant.pathPrefix}/newaccount.aspx?id=${m.id}" id="ctl00_ContentPlaceHolder1_lnkOpenAccount">${tenant.labels.openSubAccountLink}</a>
&nbsp;|&nbsp;<a href="${tenant.pathPrefix}/search.aspx">Back to search</a></p>`
  );
}

export interface NewAccountForm {
  error?: string;
  values?: { type?: string; nickname?: string; deposit?: string; debitCard?: boolean };
}

export function newAccountPage(
  tenant: TenantConfig,
  m: Member,
  form: NewAccountForm = {}
): string {
  const v = form.values ?? {};
  const errRow = form.error
    ? `<tr><td colspan="2"><span class="err">ERROR: ${esc(form.error)}</span></td></tr>`
    : '';
  const sel = (val: string) => (v.type === val ? ' selected' : '');
  return page(
    tenant,
    'Open Sub-Account',
    `<h1>Open Sub-Account for ${esc(m.firstName)} ${esc(m.lastName)} (${esc(m.id)})</h1>
<form method="post" action="${tenant.pathPrefix}/newaccount.aspx?id=${m.id}">
<table cellspacing="2">
${errRow}
<tr><td>Account Type:</td><td>
<select name="ctl00$ContentPlaceHolder1$ddlAccountType" id="ctl00_ContentPlaceHolder1_ddlAccountType">
<option value="">-- select --</option>
<option value="Savings"${sel('Savings')}>Savings</option>
<option value="Checking"${sel('Checking')}>Checking</option>
<option value="Money Market"${sel('Money Market')}>Money Market</option>
</select></td></tr>
<tr><td>Nickname:</td><td><input type="text" name="ctl00$ContentPlaceHolder1$txtNickname" id="ctl00_ContentPlaceHolder1_txtNickname" size="28" value="${esc(v.nickname ?? '')}" maxlength="40"></td></tr>
<tr><td>Initial Deposit (USD):</td><td><input type="text" name="ctl00$ContentPlaceHolder1$txtInitialDeposit" id="ctl00_ContentPlaceHolder1_txtInitialDeposit" size="12" value="${esc(v.deposit ?? '')}"></td></tr>
<tr><td></td><td><input type="checkbox" name="ctl00$ContentPlaceHolder1$chkDebitCard" id="ctl00_ContentPlaceHolder1_chkDebitCard" value="on"${v.debitCard ? ' checked' : ''}> Request debit card</td></tr>
<tr><td></td><td><input type="submit" name="ctl00$ContentPlaceHolder1$btnReview" value="Review & Continue" id="ctl00_ContentPlaceHolder1_btnReview" class="btn"></td></tr>
</table>${viewstate()}</form>
<p><a href="${tenant.pathPrefix}/detail.aspx?id=${m.id}">Cancel</a></p>`
  );
}

export function confirmOpenPage(
  tenant: TenantConfig,
  m: Member,
  vals: { type: string; nickname: string; deposit: string; debitCard: boolean }
): string {
  return page(
    tenant,
    'Review Sub-Account',
    `<h1>Review New Sub-Account</h1>
<table class="grid" width="50%">
<tr class="hdr"><td colspan="2">Please review before submitting</td></tr>
<tr><td>Member</td><td>${esc(m.firstName)} ${esc(m.lastName)} (${esc(m.id)})</td></tr>
<tr><td>Account Type</td><td>${esc(vals.type)}</td></tr>
<tr><td>Nickname</td><td>${esc(vals.nickname)}</td></tr>
<tr><td>Initial Deposit</td><td>$${esc(vals.deposit)}</td></tr>
<tr><td>Debit card</td><td>${vals.debitCard ? 'Requested' : 'No'}</td></tr>
</table>
<form method="post" action="${tenant.pathPrefix}/openaccount.aspx?id=${m.id}" onsubmit="return window.confirm('Opening this account is irreversible. Continue?');">
<input type="hidden" name="type" value="${esc(vals.type)}">
<input type="hidden" name="nickname" value="${esc(vals.nickname)}">
<input type="hidden" name="deposit" value="${esc(vals.deposit)}">
<input type="hidden" name="debitCard" value="${vals.debitCard ? 'on' : ''}">
<input type="submit" name="ctl00$ContentPlaceHolder1$btnConfirm" value="${tenant.labels.confirmButton}" id="ctl00_ContentPlaceHolder1_btnConfirm" class="btn">
</form>
<p><a href="${tenant.pathPrefix}/newaccount.aspx?id=${m.id}&back=1">Go back and edit</a></p>`
  );
}

let nextAccountSeq = 90000001;

export function accountOpenedPage(tenant: TenantConfig, m: Member, number: string): string {
  nextAccountSeq += 17;
  return page(
    tenant,
    'Sub-Account Opened',
    `<h1>Confirmation</h1>
<table class="grid" width="55%">
<tr><td colspan="2" class="ok">Sub-account opened successfully for member ${esc(m.id)}.</td></tr>
<tr><td>New account number</td><td><span id="ctl00_ContentPlaceHolder1_lblNewAccountNumber">${number}</span></td></tr>
<tr><td>Member services copy</td><td>Emailed to branch ops</td></tr>
</table>
<p><a href="${tenant.pathPrefix}/detail.aspx?id=${m.id}">View member detail</a></p>`
  );
}

export function genericErrorPage(tenant: TenantConfig, code: string, message: string): string {
  return page(
    tenant,
    'System Error',
    `<h1>Unexpected application error</h1>
<div class="err">${esc(code)}: ${esc(message)}</div>
<p><a href="${tenant.pathPrefix}/home.aspx">Return to home</a></p>`
  );
}


