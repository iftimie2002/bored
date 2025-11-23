# bored
surveys for general market research

## Data flow (current setup)
- The browser encrypts survey state (metadata, answers, scores) with the Apps Script web app’s public key.
- Autosave runs after most interactions (debounced ~800ms) and posts the encrypted payload to the web app endpoint.
- Your Apps Script/web app is responsible for decrypting and writing the plaintext into Google Sheets, so submissions arrive nearly in real time once decrypted.
