# Artifact research

REA statically inspected the installed Postman 12.26.5 ASAR at `C:\Users\silwa\AppData\Local\Postman\app-12.26.5\resources\app.asar`.

- Artifact SHA-256: `4df9c045af374a5344ac410d696f42ff6341197e72f3ec30c483a09526c2c6e3`.
- Parent evidence: `ev_a27fd1345ac4cc6451901ed9fdefcdb2ad7d0c298f75ff7577c2d6bcdfe5347b`.
- Summary evidence: `ev_ede6496a2483b6fec7f7119ef44b81f4986f745d9bbd6d473df8d947a92b3d18`.
- Selected sources: `package.json`, `js/scratchpad/CollectionSidebar.js`, `js/scratchpad/EnvironmentSidebar.js`.
- The manifest identifies Postman 12.26.5 and its `main.js` entry point. The selected package contains collection and environment sidebar modules. This establishes package identity and those static module observations; it does not establish runtime behavior.
- Coverage is partial: 412 inventoried sources were outside the selected analysis. Dynamic relationships remain unknown. No Postman application code was executed or copied into Relay.

Relay's Rust engine, local workspace model, UI, and compatibility behavior are original implementation choices. Tests against a controlled local HTTP service establish Relay's behavior independently.
