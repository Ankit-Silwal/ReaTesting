import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

// Attach to a development Relay window started with a loopback WebView2 debugging
// port and RELAY_DATA_DIR pointing to an isolated test workspace. No IPC is mocked.
const browser = await chromium.connectOverCDP(
  process.env.RELAY_CDP_URL ?? "http://127.0.0.1:9223",
);
try {
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((page) => /1420|tauri.localhost/.test(page.url()));
  if (!page)
    throw new Error(
      "No Relay WebView found. Start the native verification configuration first.",
    );
  const errors = [];
  const collectionName = `Native verification ${Date.now()}`;
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "GET List users", exact: true })
    .click();
  await page.getByLabel("Request URL").fill("{{base_url}}/users");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("200 OK", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Response body")).toContainText('"total": 2');
  await expect(page.getByLabel("Response body")).toContainText(
    "sam@example.com",
  );
  console.log("PASS: native GET through Rust HTTP engine");
  await mkdir(".verification", { recursive: true });
  await page.screenshot({ path: ".verification/relay-native.png" });

  await page
    .getByRole("button", { name: "POST Create a user", exact: true })
    .click();
  await page.getByLabel("Request URL").fill("{{base_url}}/echo");
  await page.getByRole("tab", { name: "Body", exact: true }).first().click();
  await page
    .getByLabel("Request body")
    .fill('{"name":"Rust native verification","number":42}');
  await page.getByRole("tab", { name: "Authorization", exact: true }).click();
  await page.getByLabel("Authorization type").selectOption("bearer");
  await page.getByRole("textbox", { name: /^Token/ }).fill("test-native-token");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByLabel("Response body")).toContainText(
    "Bearer test-native-token",
  );
  await expect(page.getByLabel("Response body")).toContainText('"number": 42');
  console.log("PASS: native POST body and Authorization header");

  await page.getByLabel("Request URL").fill("{{base_url}}/delay/3");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("cancelled");
  console.log("PASS: cancellation over native IPC");

  await page
    .getByRole("button", { name: "GET List users", exact: true })
    .click();
  await page.getByLabel("Request URL").fill("{{base_url}}/status/404");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("404 Not Found", { exact: true })).toBeVisible();
  console.log("PASS: HTTP errors displayed as responses");

  await page
    .getByRole("button", { name: "New collection", exact: true })
    .first()
    .click();
  await page.getByLabel("Collection name").fill(collectionName);
  await page
    .getByRole("button", { name: "Create collection", exact: true })
    .click();
  await expect(
    page.getByText("Workspace saved", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: `${collectionName} 0`, exact: true }),
  ).toBeVisible();
  const data = await page.evaluate(async () =>
    window.__TAURI_INTERNALS__.invoke("load_workspace"),
  );
  if (!data.collections.some((c) => c.name === collectionName))
    throw new Error("Native workspace did not persist.");
  if (errors.length) throw new Error(errors.join("\n"));
  await writeFile(
    ".verification/native-result.json",
    JSON.stringify(
      {
        passed: true,
        checks: [
          "GET",
          "POST",
          "bearer auth",
          "cancel",
          "404",
          "workspace persistence",
        ],
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log("PASS: native workspace persistence; no page errors");
} finally {
  await browser.close();
}
