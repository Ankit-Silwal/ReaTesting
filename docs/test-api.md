# Local testing API

A small **Rust** server at **http://localhost:3000** for trying Relay's HTTP methods. Records are saved in `data/test-api.json`; there is no database.

## Start

Double-click **Start Test API.cmd**, or open PowerShell in the project and run:

```powershell
cd C:\Studies\Testing\ReaTesting
npm.cmd run api
```

Keep the server terminal open. Press **Ctrl+C** to stop it. Opening `http://localhost:3000` in a browser shows available routes; `http://localhost:3000/health` confirms it is running.

## Requests to try in Relay

| Method | URL                            | Result                                                    |
| ------ | ------------------------------ | --------------------------------------------------------- |
| GET    | `http://localhost:3000/test`   | List all records and total count                          |
| GET    | `http://localhost:3000/test/1` | Read the initial sample record                            |
| POST   | `http://localhost:3000/test`   | Create a record; responds **201** with its new ID         |
| PUT    | `http://localhost:3000/test/1` | Replace a record, keeping its ID                          |
| PATCH  | `http://localhost:3000/test/1` | Change selected fields, keeping others                    |
| DELETE | `http://localhost:3000/test/1` | Delete a record and return `{ "deleted": true, "id": 1 }` |

For POST, PUT, or PATCH, select **Body → JSON** in Relay and send an object such as:

```json
{
  "name": "My test item",
  "message": "Created from Relay",
  "count": 1
}
```

On a fresh file, ID **1** already exists and the first POST creates ID **2**, then **3**, and so on. Use the returned `id` in the next GET, PATCH, PUT, or DELETE URL. IDs keep increasing after deletion and restart. Client-supplied `id` values are replaced with the server's ID.

PUT replaces every field except the ID. PATCH shallowly merges the supplied fields. Missing records return JSON **404** errors; invalid IDs/objects return **400**, and a missing JSON content type returns **415**. Bodies are limited to 1 MiB. Data is saved atomically, with serialized writes so concurrent requests do not lose records. Malformed existing files are preserved and prevent startup.

## Ready-to-import collection

In Relay, click **Import collection**, choose `examples/local-test-api.postman_collection.json`, and import it. This adds the GET, POST, PUT, PATCH, and DELETE examples and selects an environment with `base_url=http://localhost:3000`. Change its `id` variable after creating a new record.

## Storage and custom configuration

`data/test-api.json` is created on first start and ignored by Git. Stop the server before editing this file manually. To start with fresh data, stop the server and move that file aside; the next start creates a sample record and counter again. Use one server per data file.

Optional settings:

```powershell
npm.cmd run api -- --port 3001 --file data/another-test.json
```

Or call the compiled server directly:

```powershell
.\target\debug\relay-test-api.exe --port 3001 --file data/another-test.json
```

The server binds only to IPv4 loopback (`127.0.0.1`). `localhost` also works on this computer. Run `npm.cmd run test:api` for the CRUD, persistence, concurrency, validation, and failed-write checks.
