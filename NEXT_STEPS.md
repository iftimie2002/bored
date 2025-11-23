# What to do next (plain-English, copy/paste friendly)

These steps assume you already have a Google Sheet and a deployed Apps Script web app URL. Follow them in order to make the survey save rows into the `RawData` tab.

## 0) What I still need from you
- Confirm the **current Apps Script web app URL** you want the page to call (replace `WEB_APP_URL` in `index.html` if it changes).
- Confirm the **RSA key pair** being used:
  - `PRIVATE_KEY_PEM` saved in Apps Script Script Properties.
  - `PUBLIC_KEY_PEM` (optional) saved in Script Properties; otherwise we will keep using the bundled public key already in `index.html`.

## 1) Prepare Apps Script (one time)
1. Open your Sheet → **Extensions → Apps Script**.
2. Create three files in the project (use the "+ New File" button):
   - `jsrsasign.js.gs` → paste the shim lines **first**, then the full minified library from https://cdnjs.cloudflare.com/ajax/libs/jsrsasign/10.8.6/jsrsasign-all-min.js
     ```javascript
     var window = typeof window !== 'undefined' ? window : {};
     var navigator = window.navigator || { userAgent: 'AppsScript' };
     // paste the cdn jsrsasign-all-min.js **under** these two lines
     ```
   - `cryptojs.js.gs` → paste the full minified build from https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.1.1/crypto-js.min.js
   - `Code.gs` → copy/paste the entire contents of the `Code.gs` file from this repo (see below).
3. Go to **Project Settings → Script Properties** and add `PRIVATE_KEY_PEM` (your RSA private key including the BEGIN/END lines). Optionally add `PUBLIC_KEY_PEM` (public key).
4. Ensure your Sheet has a tab named **RawData** (or the first tab will be used).

## 2) Deploy (or redeploy) the web app
1. In Apps Script, click **Deploy → New deployment** (or **Manage deployments → Edit → Deploy** if updating).
2. Choose **Web app**. Set **Execute as: Me**. Set **Who has access: Anyone**.
3. Click **Deploy**. Copy the **Web app URL** and paste it into `WEB_APP_URL` at the top of `index.html`.

## 3) Verify the backend is alive
1. Open the web app URL in your browser. You should see JSON like `{ "publicKey": "-----BEGIN PUBLIC KEY-----..." }`. If not, redeploy or check Script Properties.
2. In Apps Script, open **Executions** to confirm both `doGet` (public key) and `doPost` (test pings) show up when you exercise the page.

## 4) Test end-to-end from the page
1. Run a local server: `python -m http.server 8000` in this folder, then open `http://localhost:8000` in your browser.
2. On the landing screen, click **Send test to Sheet**. Watch the status badge (“Sent test ping …”).
3. Check the **RawData** tab; a new row should appear. If not:
   - In Apps Script **Executions**, look for errors (often missing `PRIVATE_KEY_PEM`, missing libraries, or key mismatch).
   - Confirm the web app URL in `index.html` matches the latest deployment.
   - Confirm the public/private keys match (regenerate both if unsure and update Script Properties + `index.html` fallback key).

## 5) Use the survey normally
- After most interactions (debounced ~800 ms), the page encrypts the payload (AES-256-CBC, AES key wrapped with RSA-OAEP) and sends it to `doPost`. The backend decrypts and appends a row to `RawData`.

If anything above is unclear, tell me which step you are on and what you see. I can update the code again once you confirm the current web app URL and which public key you want bundled in the page.
