# Encrypting survey submissions with Google Apps Script (hybrid RSA + AES)

This guide matches the current `index.html` client and the `Code.gs` backend in this repo. The browser encrypts each payload with a random AES-256 key and IV, then wraps that AES key with your RSA public key. Apps Script decrypts the RSA-wrapped key, then AES-decrypts the payload, and appends it to the **RawData** sheet.

## 1) Generate a key pair (once)

```bash
openssl genrsa -out private.pem 2048
openssl rsa -in private.pem -pubout -out public.pem
```

Keep `private.pem` secret. The `public.pem` goes in the HTML and/or Script Properties.

## 2) Prepare the Sheet and Script Properties

1. Open your Google Sheet → **Extensions → Apps Script**.
2. In **Project Settings**, enable **Show "appsscript.json" manifest file** (helps with deployments).
3. In **Project Properties → Script Properties**, add `PRIVATE_KEY_PEM` with the full contents of `private.pem` (including the `BEGIN/END` lines). Optionally add `PUBLIC_KEY_PEM` with your public key PEM.
4. Make sure a tab named **RawData** exists; if not, the first tab will be used.

## 3) Add the required libraries (one-time)

Apps Script lacks Web Crypto, so we add two pure-JS libraries as separate files in the project:

1. **jsrsasign** (RSA decrypt): create `jsrsasign.js.gs`, paste the two shim lines below at the very top, then paste the minified library from https://cdnjs.cloudflare.com/ajax/libs/jsrsasign/10.8.6/jsrsasign-all-min.js under them.
2. **CryptoJS** (AES-CBC decrypt): create `cryptojs.js.gs` and paste the minified AES build from https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.1.1/crypto-js.min.js.

Shims to paste at the top of the jsrsasign file (prevents `window`/`navigator` reference errors when running server-side):
```javascript
var window = typeof window !== 'undefined' ? window : {};
var navigator = window.navigator || { userAgent: 'AppsScript' };
```

After pasting both files, click **Deploy → Manage deployments → Edit → Deploy** so the new libraries are active.

## 4) Add the backend (Code.gs)

Create or replace `Code.gs` with this exact code (it expects the libraries above):

```javascript
// Apps Script backend for encrypted autosaves/test pings written from index.html.
// Requirements:
//   1) jsrsasign (with shims) pasted into its own file.
//   2) CryptoJS (core + enc-base64 + mode-cbc + pad-pkcs7 + aes) pasted into its own file.
//   3) PRIVATE_KEY_PEM set in Script Properties; PUBLIC_KEY_PEM optional.
//   4) A sheet/tab named "RawData" (falls back to the first tab).

function doGet() {
  return respond(200, { publicKey: getPublicKey() });
}

function doPost(e) {
  return withErrorHandling(() => {
    const rawBody = e && e.postData && e.postData.contents;
    if (!rawBody) return respond(400, { error: 'Missing body' });

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch (err) {
      return respond(400, { error: 'Invalid JSON', detail: String(err) });
    }

    if (!body || !body.key || !body.iv || !body.ciphertext) {
      return respond(400, { error: 'Missing key/iv/ciphertext' });
    }

    const plaintext = decryptCiphertext(body);
    const payload = JSON.parse(plaintext);

    appendRow(payload);
    return respond(200, { status: 'ok' });
  });
}

function appendRow(payload) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('RawData') || ss.getSheets()[0];
  sheet.appendRow([
    new Date(),
    payload.clientId || '',
    payload.timestamp || '',
    JSON.stringify(payload.meta || {}),
    JSON.stringify(payload.answers || {}),
    JSON.stringify(payload.sequence || {}),
    payload.pointer !== undefined ? payload.pointer : '',
    payload.smartScore !== undefined ? payload.smartScore : '',
    payload.confidenceScore !== undefined ? payload.confidenceScore : '',
    payload.testPing ? 'test' : ''
  ]);
}

function decryptCiphertext(body) {
  if (typeof CryptoJS === 'undefined') throw new Error('Missing CryptoJS library');

  const privatePem = PropertiesService.getScriptProperties().getProperty('PRIVATE_KEY_PEM');
  if (!privatePem) throw new Error('Missing PRIVATE_KEY_PEM');

  // 1) RSA-decrypt the AES key (browser wraps a base64 AES key string with RSA-OAEP).
  const rsa = new RSAKey();
  rsa.readPrivateKeyFromPEMString(privatePem);
  const aesKeyB64 = rsaDecryptToString(rsa, body.key);
  const aesKeyBytes = Utilities.base64Decode(aesKeyB64);
  const aesKeyWords = CryptoJS.lib.WordArray.create(aesKeyBytes);

  // 2) AES-CBC decrypt the payload using IV + ciphertext from the browser.
  const ivWords = CryptoJS.enc.Base64.parse(body.iv);
  const cipherParams = CryptoJS.lib.CipherParams.create({
    ciphertext: CryptoJS.enc.Base64.parse(body.ciphertext)
  });

  const decrypted = CryptoJS.AES.decrypt(cipherParams, aesKeyWords, {
    iv: ivWords,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7
  });

  const plaintext = CryptoJS.enc.Utf8.stringify(decrypted);
  if (!plaintext) throw new Error('AES decryption failed');
  return plaintext;
}

function rsaDecryptToString(rsa, cipherTextB64) {
  const bytes = Utilities.base64Decode(cipherTextB64);
  const hex = bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
  const decrypted =
    (typeof rsa.decryptOAEP === 'function' ? rsa.decryptOAEP(hex, 'sha256') : null) ||
    rsa.decrypt(hex);
  if (!decrypted) throw new Error('RSA decryption failed');
  return decrypted;
}

function getPublicKey() {
  const stored = PropertiesService.getScriptProperties().getProperty('PUBLIC_KEY_PEM');
  if (stored) return stored;
  // Fallback to the bundled key if Script Properties is empty; replace with your own PEM if desired.
  return `
-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAosrKjxh9+l3IFR557b4Z
Pm240gpFj0vYwKkqfPLMtEqgcYEKnYAw2AuWoszm/5aBc3AGsnF5im1NgGntTRGL
ZY5+1D5SwlNAiijTyoNoiMVNqh0/VSc9Y1JZqzbXsdvXu6Uc5utIe5DQ/UzpLsEF
topZsEjphI0PFtI2S0ByxH4LKA6x6gcz3dmzFOkKxsUwdCoWbjy23E0RltcYBA8U
6Q3k1AHLwNIPpHbmlm2Dy7WCIhPpzzGVouXx7FzFKHecZciVZXnqzFrO6hjOKY6v
j6/8Fhbsetk1vRz+ejy48JRB2V+VJ3vaG2k4Joj08/XWRZdTaOfiHMOfs+tYK4sC
jwIDAQAB
-----END PUBLIC KEY-----
`;
}

function respond(status, obj) {
  const output = ContentService.createTextOutput(JSON.stringify(obj));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

function doOptions() {
  return respond(200, { status: 'ok' });
}

function withErrorHandling(fn) {
  try {
    return fn();
  } catch (err) {
    console.error(err);
    return respond(500, { error: String(err) });
  }
}
```

## 5) Deploy the web app

1. In the Script Editor, click **Deploy → New deployment**.
2. Type: **Web app**. **Execute as**: **Me**. **Who has access**: **Anyone** (or restrict by domain if preferred).
3. Click **Deploy** and copy the **Web app URL**; set this as `WEB_APP_URL` in `index.html`.

## 6) Test end-to-end

1. Open the web app URL in a browser; you should see JSON with your public key (confirms **doGet** works).
2. Run the HTML locally (e.g., `python -m http.server 8000` and visit `http://localhost:8000`).
3. Click **Send test to Sheet** on the landing screen. Watch the floating status badge for “Sent test ping …”.
4. In the Google Sheet, check the **RawData** tab for a new row. If none appears, open **Apps Script → Executions** to see errors (decryption or missing libs). Fix, redeploy, and try again.

