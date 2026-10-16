import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const running = new Map<string, (reason: string) => void>();
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke: async (command: string, args: Record<string, unknown>) => {
      if (command === "load_workspace") return JSON.parse(localStorage.getItem("test-workspace") ?? "null");
      if (command === "save_workspace") { localStorage.setItem("test-workspace", JSON.stringify(args.data)); return; }
      if (command === "start_demo") return "http://127.0.0.1:8787";
      if (command === "cancel_request") { running.get(args.id as string)?.("Request cancelled."); return true; }
      if (command === "send_request") {
        const request = args.request as Record<string, unknown>;
        (window as unknown as Record<string, unknown>).__lastRequest = request;
        if ((request.url as string).includes("/delay/")) return new Promise((_, reject) => running.set(request.id as string, reject));
        if ((request.url as string).includes("/offline")) throw "Could not connect to the server.";
        return { status: 200, statusText: "OK", url: request.url, headers: [["content-type", "application/json"], ["x-relay", "test"]], body: JSON.stringify({ users: [{ id: 1, name: "Alex Morgan" }], method: request.method, received: request.bodyMode === "json" ? JSON.parse(request.body as string) : null }), size: 120, timeMs: 12, truncated: false, binary: false };
      }
    } };
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
});

test("sends query parameters, renders highlighted JSON, searches response and opens headers", async ({ page }) => {
  await expect(page.getByText("Ready when you are.")).toBeVisible();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("200 OK")).toBeVisible();
  await expect(page.getByLabel("Response body")).toContainText("Alex Morgan");
  const sent = await page.evaluate(() => (window as unknown as Record<string, unknown>).__lastRequest) as { url: string; params: {key:string;value:string}[] };
  expect(sent.url).toBe("http://127.0.0.1:8787/users"); expect(sent.params[0].value).toBe("1");
  await page.getByLabel("Find in response").fill("Alex"); await expect(page.getByText("1 matching lines")).toBeVisible();
  await page.getByRole("tab", { name: "Headers 2" }).click(); await expect(page.getByText("application/json", { exact: true })).toBeVisible();
});

test("edits JSON and bearer authorization, rejects malformed JSON", async ({ page }) => {
  await page.getByRole("button", { name: "POST Create a user" }).click();
  await page.getByLabel("Request body").fill('{"name":"Ada"}');
  await page.getByRole("tab", { name: "Authorization" }).click();
  await page.getByLabel("Authorization type").selectOption("bearer");
  await page.getByLabel("Token", { exact: true }).fill("my-token");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByLabel("Response body")).toContainText("Ada");
  const sent = await page.evaluate(() => (window as unknown as Record<string, unknown>).__lastRequest) as {auth:{token:string};method:string}; expect(sent.auth.token).toBe("my-token"); expect(sent.method).toBe("POST");
  await page.getByRole("tab", { name: "Body", exact: true }).first().click();
  await page.getByLabel("Request body").fill("{broken");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("not valid JSON");
});

test("creates a collection, saves a request and restores it after reload", async ({ page }) => {
  await page.getByRole("button", { name: "New collection", exact: true }).click();
  await page.getByLabel("Collection name").fill("My API"); await page.getByRole("button", { name: "Create collection", exact: true }).click();
  await page.getByRole("button", { name: "New request", exact: true }).click();
  await page.getByLabel("Request URL").fill("https://example.com/api");
  await page.getByRole("button", { name: /^Save/ }).click();
  await page.getByRole("dialog").getByLabel("Request name").fill("Saved endpoint");
  await page.getByRole("dialog").getByLabel("Collection", { exact: true }).selectOption({ label: "My API" });
  await page.getByRole("button", { name: "Save request", exact: true }).click();
  await expect(page.getByRole("button", { name: "GET Saved endpoint" })).toBeVisible();
  await expect(page.getByText("Workspace saved", { exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByLabel("Request URL")).toHaveValue("https://example.com/api");
  await expect(page.getByRole("button", { name: "GET Saved endpoint" })).toBeVisible();
});

test("imports and exports a Postman collection", async ({ page }) => {
  await page.getByRole("button", { name: "Import collection", exact: true }).click();
  await page.getByLabel("Collection JSON").fill(JSON.stringify({ info: { name: "Imported API" }, item: [{ name: "Get example", request: { method: "GET", url: "https://example.com" } }] }));
  await page.getByRole("dialog").getByRole("button", { name: "Import collection", exact: true }).click();
  await expect(page.getByRole("button", { name: "GET Get example" })).toBeVisible();
  await page.getByRole("button", { name: "Manage Imported API" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export Postman collection" }).click();
  expect((await downloadPromise).suggestedFilename()).toContain("postman_collection.json");
});

test("cancels a pending request and records network failures in history", async ({ page }) => {
  await page.getByLabel("Request URL").fill("{{base_url}}/delay/3");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("cancelled");
  await page.getByLabel("Request URL").fill("{{base_url}}/offline");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Could not connect");
  await page.getByRole("button", { name: "History", exact: true }).click(); await expect(page.locator(".history-item")).toHaveCount(2);
});

test("supports keyboard shortcuts, environment editing and light appearance", async ({ page }) => {
  await page.keyboard.press("Control+t"); await expect(page.getByRole("tab", { name: /Untitled request/ })).toBeVisible();
  await page.getByRole("button", { name: "Edit environment", exact: true }).click();
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByLabel("Environment name").fill("Staging");
  await page.getByRole("button", { name: "Add variable" }).click();
  await page.getByLabel("Variable key").fill("base_url"); await page.getByLabel("Variable value").fill("https://staging.example.com");
  await page.getByRole("button", { name: "Save environment" }).click();
  await expect(page.getByLabel("Active environment")).toContainText("Staging");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Theme", { exact: true }).selectOption("light"); await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("workspace layout fits the desktop viewport and captures screenshot", async ({ page }) => {
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("200 OK")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: ".verification/relay-workspace.png", fullPage: true });
});
