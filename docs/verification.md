# Verification — Relay 0.1.0

Verified on Windows x64 with Rust 1.99.1, Node 24.11.0, MSVC Build Tools 2022, and WebView2 155.

## Automated checks

- Frontend production build: passed TypeScript checking and Vite bundling.
- Frontend model tests: **10 passed**. Covers variables, invalid JSON, collection folders/auth/variables, query round trips, cURL escaping/settings, and malformed saved data.
- Rust integration tests: **8 passed**. Uses real loopback HTTP requests for headers, queries, JSON bodies, Basic/Bearer auth, cookies, HTTP errors, HEAD, redirects, timeouts, cancellation, duplicate request identifiers, invalid inputs, response capture limits, binary hex rendering, and atomic storage.
- Browser workflow tests: **7 passed** in installed Chrome, using a mocked Tauri bridge. Covers request editing and display, collections and reload persistence, import/export, cancellation/errors/history, keyboard shortcuts, environment editing, and light appearance.
- Rust formatting and workspace compilation: passed.

A Windows test rebuild encountered `LNK1104` while linking test executables concurrently. The complete test suite passed with `--jobs 1`; the documented npm test command now uses that scheduling setting.

## Native application checks

Connected Playwright to Relay's actual WebView2 debugging port, with no IPC mocks and a separate test data directory:

1. GET `/users` through the Rust backend: returned both expected demo users and HTTP 200.
2. POST `/echo`: the server observed the JSON body and Bearer Authorization header.
3. Cancellation: the native Rust request was cancelled and the UI reported cancellation.
4. HTTP 404: rendered as an ordinary response with its status and body.
5. Workspace persistence: a collection survived a WebView reload and was present in the backend's saved workspace.
6. No JavaScript page errors were observed during these checks.

Repeated the native checks against the **bundled executable**, served from `http://tauri.localhost/`, after stopping Vite on port 1420. All checks passed, establishing that the built application works without the development server.

## Windows artifacts

- `target/debug/relay.exe`: bundled development executable.
- `target/debug/bundle/nsis/Relay_0.1.0_x64-setup.exe`: generated NSIS development installer, approximately 3.3 MiB.
- The app was launched directly from the executable. Installer generation passed; the installer itself was not run, because the workspace executable already provides the requested local app.
- A production-optimized release can be generated with `npm.cmd run desktop:build`; the supplied local artifacts are development builds.

These checks establish the included HTTP workflows. They do not claim complete Postman feature parity or validation of every public API, TLS configuration, proxy, or imported collection.
