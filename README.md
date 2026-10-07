# Dobble Connect Live Match Finder

Static, on-device camera app. No frame data leaves the browser.

Local desktop test (camera access works on `localhost`):

```powershell
python -m http.server 8080
```

Open `http://localhost:8080`. For iPhone testing, deploy this directory to Vercel so the camera runs over HTTPS, then add the opened site to the Home Screen for offline use.
