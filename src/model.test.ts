import { describe, expect, it } from "vitest";
import {
  exportCollection,
  importCollections,
  initialWorkspace,
  interpolate,
  newRequest,
  pair,
  resolveRequest,
  toCurl,
  validateWorkspace,
} from "./model";

describe("environment resolution", () => {
  const environment = {
    id: "dev",
    name: "Dev",
    variables: [
      pair("base", "https://example.com"),
      pair("token", "secret"),
      pair("disabled", "bad", false),
    ],
  };
  it("substitutes variables in URL, headers, body and active auth", () => {
    const request = newRequest({
      method: "POST",
      url: "{{ base }}/api",
      headers: [pair("Authorization", "{{token}}")],
      bodyMode: "json",
      body: '{"token":"{{token}}"}',
      auth: { kind: "bearer", token: "{{token}}", username: "", password: "" },
    });
    const resolved = resolveRequest(request, environment);
    expect(resolved.url).toBe("https://example.com/api");
    expect(resolved.headers[0].value).toBe("secret");
    expect(resolved.auth.token).toBe("secret");
    expect(JSON.parse(resolved.body).token).toBe("secret");
  });
  it("reports missing variables and invalid JSON, ignores unused fields", () => {
    expect(() => interpolate("{{disabled}}", environment)).toThrow(
      "not defined",
    );
    expect(() =>
      resolveRequest(
        newRequest({ url: "{{base}}", bodyMode: "json", body: "{" }),
        environment,
      ),
    ).toThrow("not valid JSON");
    expect(
      resolveRequest(
        newRequest({
          url: "{{base}}",
          params: [pair("disabled", "{{missing}}", false)],
          body: "{{missing}}",
        }),
        environment,
      ).url,
    ).toBe("https://example.com");
  });
});

describe("Postman compatibility", () => {
  it("imports folders, inherited authentication and duplicated raw/query correctly", () => {
    const result = importCollections({
      info: { name: "API" },
      auth: { type: "bearer", bearer: [{ key: "token", value: "{{token}}" }] },
      item: [
        {
          name: "Users",
          item: [
            {
              name: "Get",
              request: {
                method: "GET",
                url: {
                  raw: "{{base}}/users?page=1",
                  query: [{ key: "page", value: "1" }],
                },
              },
            },
          ],
        },
      ],
    });
    const request = result[1].requests[0];
    expect(result[1].name).toBe("API / Users");
    expect(request.url).toBe("{{base}}/users");
    expect(request.params).toHaveLength(1);
    expect(request.auth.token).toBe("{{token}}");
  });
  it("round-trips raw URL query, editable rows, JSON and auth without duplicating queries", () => {
    const request = newRequest({
      url: "https://example.com/api?existing=one",
      params: [pair("q", "hello world"), pair("skip", "no", false)],
      method: "POST",
      bodyMode: "json",
      body: '{"ok":true}',
      auth: { kind: "basic", username: "ada", password: "pass", token: "" },
    });
    const collection = { id: "test", name: "Tests", requests: [request] };
    const imported = importCollections(exportCollection(collection))[0]
      .requests[0];
    expect(imported.url).toBe("https://example.com/api");
    expect(imported.params.map((p) => [p.key, p.value, p.enabled])).toEqual([
      ["existing", "one", true],
      ["q", "hello world", true],
      ["skip", "no", false],
    ]);
    expect(imported.bodyMode).toBe("json");
    expect(imported.auth.password).toBe("pass");
  });
  it("rejects unsupported uploads or authentication instead of changing meaning", () => {
    expect(() =>
      importCollections({
        item: [
          {
            name: "Upload",
            request: { url: "https://example.com", body: { mode: "formdata" } },
          },
        ],
      }),
    ).toThrow("formdata");
    expect(() =>
      importCollections({
        item: [
          { request: { url: "https://example.com", auth: { type: "oauth2" } } },
        ],
      }),
    ).toThrow("authentication");
    expect(() => importCollections({})).toThrow("Postman Collection");
  });
});

it("generates cURL with escaped quotes and substituted parameters", () => {
  const value = toCurl(
    newRequest({
      url: "https://example.com",
      headers: [pair("X-Name", "O'Reilly")],
      params: [pair("q", "a b")],
    }),
  );
  expect(value).toContain("q=a+b");
  expect(value).toContain("O'\\''Reilly");
});

it("validates workspace versions and recovers a missing active tab", () => {
  const ws = initialWorkspace("http://localhost");
  ws.activeId = "missing";
  expect(validateWorkspace(ws).activeId).toBe(ws.tabs[0].id);
  expect(() => validateWorkspace({ ...ws, schemaVersion: 2 })).toThrow(
    "preserved",
  );
});
