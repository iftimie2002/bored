# Encrypting survey submissions with Google Apps Script

This guide shows how to encrypt survey payloads in the browser with a public key, send them to a Google Apps Script web app, decrypt them with a private key stored in script properties, and write the plaintext into the connected Google Sheet.

> Quick fix for the exact error you reported (`ReferenceError: window is not defined` in `jsrsasign.js`):
> 1. In Apps Script, open the file that contains the minified `jsrsasign` code (for example `jsrsasign.js.gs`).
> 2. Go to the very top of that file and **add these two lines** above everything else:
>    ```javascript
>    var window = typeof window !== 'undefined' ? window : {};
>    var navigator = window.navigator || { userAgent: 'AppsScript' };
>    ```
> 3. Save the project.
> 4. Click **Deploy → Manage deployments → Edit** on your web app deployment, then click **Deploy** again so the new file contents are active.
> This gives the library the fake `window`/`navigator` objects it expects when it runs on the server, so the error goes away.

## 1) Generate a key pair (do this once)

Run these commands locally (not in the browser) to create a 2048-bit RSA key pair:

```bash
openssl genrsa -out private.pem 2048
openssl rsa -in private.pem -pubout -out public.pem
```

Keep `private.pem` secret. The `public.pem` contents are safe to embed in your HTML/JS.

## 2) Prepare the Google Sheet and Apps Script project

1. Create or open the Google Sheet that will store responses.
2. In the Sheet, click **Extensions → Apps Script** to open the Script Editor.
3. In **Project Settings**, turn on **Show "appsscript.json" manifest file** (helps with deployments).
4. In **Project Properties → Script Properties**, add a property named `PRIVATE_KEY_PEM` and paste the full contents of `private.pem` (including the `BEGIN/END` lines). This keeps the private key out of the client.

## 3) Add the Apps Script code

Create a new file `Code.gs` in the Script Editor and paste **exactly** the block below. Do not include an extra line that just says `javascript`—if you see that token in your file, delete it or you will get `ReferenceError: javascript is not defined`.

```javascript
// Decrypt RSA-OAEP ciphertexts produced in the browser and append rows to the active sheet.
// Requires the jsrsasign library pasted into a separate file (see below).

function doGet(e) {
  // Publish the public key so the browser can encrypt.
  return respond(200, { publicKey: getPublicKey() });
}

function doPost(e) {
  // Browser sends a JSON POST (CORS). If that fails, it falls back to sendBeacon
  // with text/plain, which still lands in doPost here.
  const body = JSON.parse(e.postData.contents || '{}');
  const cipherTextB64 = body.ciphertext;
  if (!cipherTextB64) return respond(400, { error: 'Missing ciphertext' });

  const plaintext = decryptCiphertext(cipherTextB64);
  const payload = JSON.parse(plaintext);

  // Append to the RawData tab; change the name here if you prefer a different tab.
  // Each item in the array below becomes one column in that row, in this order:
  //   A: timestamp, B: clientId, C: meta, D: answers, E: sequence,
  //   F: pointer,   G: smartScore, H: confidenceScore
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('RawData')
    || SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  sheet.appendRow([
    new Date(),
    payload.clientId,
    JSON.stringify(payload.meta),
    JSON.stringify(payload.answers),
    JSON.stringify(payload.sequence),
    payload.pointer,
    payload.smartScore,
    payload.confidenceScore,
  ]);

  return respond(200, { status: 'ok' });
}

function decryptCiphertext(cipherTextB64) {
  const privatePem = PropertiesService.getScriptProperties().getProperty('PRIVATE_KEY_PEM');
  if (!privatePem) throw new Error('Missing PRIVATE_KEY_PEM');

  const rsa = new RSAKey();
  rsa.readPrivateKeyFromPEMString(privatePem);

  // jsrsasign expects hex; convert base64 → bytes → hex
  const bytes = Utilities.base64Decode(cipherTextB64);
  const hex = bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');

  // Use OAEP with SHA-256 to match the browser's Web Crypto configuration.
  const decrypted = rsa.decryptOAEP(hex, 'sha256');
  if (!decrypted) throw new Error('Decryption failed');
  return decrypted;
}

function getPublicKey() {
  // Option 1: store the PEM in Script Properties (recommended so you don't rely on Drive files)
  const prop = PropertiesService.getScriptProperties().getProperty('PUBLIC_KEY_PEM');
  if (prop) return prop;

  // Option 2: hardcode the PEM here if you prefer (replace the string below)
  // return `-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----`;

  throw new Error('Missing PUBLIC_KEY_PEM script property or hardcoded public key');
}

function respond(status, obj) {
  const output = ContentService.createTextOutput(JSON.stringify(obj));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}
```

### Add the jsrsasign library (for RSA-OAEP decryption)

Apps Script does not include Web Crypto, so we add a pure-JS RSA helper. Apps Script will suffix files with `.gs` or `.html`; either is fine, but using a `.gs` script file keeps it alongside the rest of your server-only code.

> **If you see `ReferenceError: navigator is not defined` _or_ `window is not defined` in Executions:** add these two shim lines directly above the minified library so the code has the browser-style globals it expects when running server-side:
> ```javascript
> // Paste these two lines first, then the full jsrsasign-all-min.js contents below them
> var window = typeof window !== 'undefined' ? window : {}; // prevents "window is not defined"
> var navigator = window.navigator || { userAgent: 'AppsScript' }; // prevents "navigator is not defined"
> ```

1. Create a new file in the Apps Script project (e.g., name it `jsrsasign.js.gs`).
2. At the very top of the file, paste the two shim lines shown above.
3. Directly under the shims, paste the contents of the minified library from https://cdnjs.cloudflare.com/ajax/libs/jsrsasign/10.8.6/jsrsasign-all-min.js
4. Save the project and **Deploy → Manage deployments → Edit → Deploy** so the updated file is live. (You do **not** need to expose this file publicly; it stays server-side.)

## 4) Deploy the web app endpoint

1. In the Script Editor, click **Deploy → New deployment**.
2. Type: **Web app**. Set **Execute as**: **Me**. Set **Who has access**: **Anyone** (or restrict by Google account domain if you prefer).
3. Click **Deploy** and copy the **Web app URL**; this will be your `WEB_APP_URL` for submissions.

## 5) Update the HTML to encrypt before sending

1. Fetch the public key from the web app: a `GET` to `WEB_APP_URL` returns JSON like `{ "publicKey": "-----BEGIN PUBLIC KEY-----..." }`. In your HTML/JS, do this once on load and keep the PEM string in memory (no need to store it locally):

```javascript
const WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbx2neRiFOxEA1nWWmvNk52OIkqWtXCOxn-TTrBr49NO65u11jsA1Sq2pORZbBIZcrwk_w/exec';
const { publicKey: pubKeyPem } = await fetch(WEB_APP_URL).then(r => r.json());
```

2. Import the public key into the browser using the Web Crypto API:

```javascript
const publicKey = await crypto.subtle.importKey(
  'spki',
  pemToArrayBuffer(pubKeyPem),
  { name: 'RSA-OAEP', hash: 'SHA-256' },
  false,
  ['encrypt']
);
```

3. Encrypt your JSON payload:

```javascript
const encoded = new TextEncoder().encode(JSON.stringify(payload));
const cipherBuffer = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, encoded);
const cipherTextB64 = btoa(String.fromCharCode(...new Uint8Array(cipherBuffer)));
```

4. POST the ciphertext to the web app. Use a simple CORS **text/plain** POST first (no preflight) so it shows up in `doPost`. If CORS fails, fall back to `sendBeacon` (also `text/plain`, still reaches `doPost`):

```javascript
try {
  const res = await fetch(WEB_APP_URL, {
    method: 'POST',
    mode: 'cors',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ ciphertext: cipherTextB64 })
  });
  if (!res.ok) throw new Error(`POST failed: ${res.status}`);
} catch (err) {
  navigator.sendBeacon(
    WEB_APP_URL,
    new Blob([JSON.stringify({ ciphertext: cipherTextB64 })], { type: 'text/plain' })
  );
}
```

## 6) Test end-to-end

Follow these micro-steps so you can see each piece working and isolate where it breaks.

> **If you see `ReferenceError: javascript is not defined` in Executions:** open `Code.gs` and delete any line that only contains the word `javascript`. That stray token appears if the language hint from this guide was accidentally pasted into the file.

### Step 1 — Confirm the web app serves the public key (hits **doGet**)

1. Copy your deployed **Web app URL** from **Deployments → Web app** (it ends with `/exec`).
2. Paste that URL into a new browser tab and press Enter.
3. Expected result: the tab shows raw JSON like `{"publicKey":"-----BEGIN PUBLIC KEY-----..."}`.
   * If you see an error page instead, redeploy the web app and make sure **Who has access** is **Anyone**.
   * If the JSON loads, you know the Apps Script is reachable and **doGet** works.

### Step 2 — Send a test payload from the survey page (hits **doPost**)

1. Open your `index.html` locally (e.g., run `python -m http.server 8000` from the project folder and visit `http://localhost:8000`).
2. On the first screen, click **Send test to Sheet** once.
3. Watch the floating status badge in the bottom-right:
   * It should flash green with a timestamp like `Sent test ping @ 12:34:56`.
   * If it turns red or says “Send failed,” open the browser console for the exact error.
4. In Apps Script, open **Executions** (left sidebar) and refresh. You should see a recent **doPost** entry.
   * If you only see **doGet**, your POST is not arriving—check CORS, the deployment URL, or try the sendBeacon fallback by clicking the test button again.

### Step 3 — Verify the Sheet receives and decrypts the row

1. In the connected Google Sheet, open the **RawData** tab (create it if it doesn’t exist; the script uses `getSheetByName('RawData')` if you set that in `Code.gs`).
2. A new row should appear with columns for timestamp, clientId, meta, answers, sequence, pointer, smartScore, and confidenceScore.
   * The `meta` column will include `{"test":true,"note":"manual ping from UI",...}` when using the test button.
3. If no row appears:
   * Check **Executions** for errors; decryption failures usually mention the key.
   * Reopen **Project Properties → Script Properties** and confirm `PRIVATE_KEY_PEM` is set to the private key that matches the public key in the HTML.
   * If needed, regenerate a fresh key pair (see step 1) and update both the HTML public key and the script properties, then redeploy the web app.

### Quick connectivity test from the browser UI

* The HTML includes a **"Send test to Sheet"** button on the first screen. Clicking it sends a minimal encrypted payload marked `testPing:true`.
* If the Apps Script is working, a new row should appear in your target tab (e.g., **RawData**) with those fields. The floating status badge in the bottom-right of the page turns green when the ping is dispatched and red if an error is thrown in the browser.

### If rows are not appearing

* In Apps Script, open **Executions** to see whether the `doPost` handler is running and whether decryption errors occur.
* Verify the web app deployment you are calling matches the latest code and that **Who has access** allows anonymous access.
* Ensure the Sheet tab name in `getSheetByName('RawData')` (or your chosen name) exists and matches exactly.
* Reconfirm `PRIVATE_KEY_PEM` (and optionally `PUBLIC_KEY_PEM`) are set in Script Properties and match the public key bundled in the HTML.

## Key handling reminders

* Never embed the private key in HTML or JavaScript sent to users.
* Rotate keys periodically: repeat step 1 and update `PRIVATE_KEY_PEM` (and the public key) when needed.
* Restrict who can access the Sheet; only decrypted data is stored there, but the sheet itself holds sensitive responses.
