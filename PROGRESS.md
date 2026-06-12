# Twin Lakes HOA — Project Progress & Resume Notes

_Last updated: 2026-06-11_

## What this project adds

A **resident request form** on the public website that flows submissions to the
Board + Mulloy (Eddie Douglas), stores them in **Google Sheets**, and surfaces
them on the **board dashboard** with counts, status, filters, and internal notes.

There are two request flows:
- **ARC (Architectural) requests** → saved to the `ARC_Requests` sheet tab, shown
  under the dashboard's **🏗️ ARC Requests** tab (feeds the board voting workflow).
- **All other categories** (Landscaping, Irrigation, Common Area/Repair,
  Violation/Complaint, General) → saved to the new `Resident_Requests` tab, shown
  under the **📨 Resident Requests** tab.

## Files changed

- **index.html** — Added Request Type dropdown (6 categories) + large conditional
  ARC form section (`#arc-section`, shown only when type = ARC) capturing all
  fields from the paper Mulloy ARC form, file upload input, acknowledgment
  checkbox + typed-name e-signature.
- **script.js** — `onTypeChange()`, `readArcFiles()` (files → base64),
  async `submitForm()` with ARC validation + 4.5 MB size guard, posts to
  `/.netlify/functions/submit-request`, `showSuccess()` resets the form.
- **netlify/functions/submit-request.js** — NEW. Handles submissions: saves to
  Sheets, emails board/Mulloy + resident confirmation. ARC submissions go through
  `handleArcSubmission`.
- **netlify/functions/board-api.js** — Dashboard now returns `Resident_Requests`;
  added `updateRequestStatus` and `addRequestNote` actions.
- **board.html** — New "📨 Resident Requests" tab with counters, filters, status
  dropdown, reply-to-resident mailto, and internal notes.

## Key decisions / gotchas discovered

### 1. Files can NOT be stored in Google Drive (service-account limitation)
Google **service accounts have zero storage quota**, so they can create empty
Drive folders but cannot upload actual files (confirmed 403:
_"Service Accounts do not have storage quota. Leverage shared drives."_).
A Shared Drive requires Google Workspace; this account is free Gmail.

**Resolution (implemented):** ARC attachments are now **emailed to the board as
real email attachments** (multipart/mixed via Gmail API) instead of going to
Drive. All Drive-upload code was removed from `submit-request.js`. The ARC sheet
row records a note like `"2 file(s) emailed to the board: plot.pdf, plan.png"`.

### 2. Submissions are now resilient to email failures
The request is saved to Sheets **before** any email is attempted; email is
best-effort. The function response includes `emailSent: true/false`. A broken
Gmail token can no longer cause a resident's submission to be lost.

### 3. Email sends now verify Google's HTTP status
Previously a 401 (expired token) looked like success. `sendEmail` /
`sendEmailWithAttachments` now throw on status >= 400.

## OUTSTANDING — must do before email works in production

**The Gmail send token (`GMAIL_REFRESH_TOKEN`) is EXPIRED** (`invalid_grant`).
This is why notification + confirmation emails currently do not send. Likely the
Google OAuth consent screen is in **"Testing"** mode (refresh tokens expire ~7
days). Requests still SAVE to the dashboard; only emails are affected.

### How to re-authorize (manual — requires signing into the board Gmail)
1. Open https://developers.google.com/oauthplayground
2. ⚙️ gear (top-right) → check **"Use your own OAuth credentials"** → paste
   `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET` (already in Netlify env).
3. Step 1 box: enter scope `https://www.googleapis.com/auth/gmail.send` →
   **Authorize APIs** → sign in as **hoa.twinlakes.board@gmail.com** → allow.
4. **Exchange authorization code for tokens** → copy the **Refresh token**.
5. Netlify → Site settings → Environment variables → update
   **`GMAIL_REFRESH_TOKEN`** → redeploy.
   - If you hit a redirect-URI error in step 2, add
     `https://developers.google.com/oauthplayground` as an authorized redirect
     URI on the OAuth client in Google Cloud Console.
6. (Recommended later) Publish the OAuth consent screen from "Testing" to "In
   production" so tokens stop expiring every 7 days.

## Test data to clean up (in the live Google Sheet)
Test rows created during debugging — safe to delete:
`ARC-MQAAO3FI`, `ARC-MQABHZAD`, `ARC-MQABIRHO`, `REQ-MQABJP85`.

## Board login credentials (plaintext in board-api.js — future: move to env/hash)
tony / yashu / ramana / raja (admin) / aimee / mike

## Resume checklist for tomorrow
- [ ] Re-authorize Gmail token (steps above); update Netlify env; redeploy.
- [ ] Submit a real ARC test with a file → confirm `emailSent: true`, email
      arrives at board with the file attached, and the row shows on the dashboard.
- [ ] Delete the test rows listed above from the Google Sheet.
- [ ] (Optional) Publish OAuth consent screen to stop 7-day token expiry.
- [ ] (Optional) Move board passwords to env vars + hashing.
