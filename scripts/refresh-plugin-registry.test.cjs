const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const { fetchManifest, generateRegistry, resolveArtifactRef } = require("./refresh-plugin-registry.cjs");

function createJsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: status === 404 ? "Not Found" : "OK",
    async json() {
      return body;
    },
  };
}

function encodeManifest(manifest) {
  return {
    content: Buffer.from(JSON.stringify(manifest), "utf8").toString("base64"),
  };
}

test("resolveArtifactRef prefixes source refs and preserves dist refs", () => {
  assert.equal(resolveArtifactRef("development"), "dist/development");
  assert.equal(resolveArtifactRef("dist/development"), "dist/development");
});

test("fetchManifest prefers the dist ref when it exists", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);

    if (url.includes("ref=dist%2Fdevelopment")) {
      return createJsonResponse(
        200,
        encodeManifest({
          name: "artifact-manifest",
          configuration: { properties: { zebra: {}, alpha: {} } },
        })
      );
    }

    return createJsonResponse(404, { message: "Not Found" });
  };

  const result = await fetchManifest("ubiquity-os-marketplace", "command-config", "development", {
    fetchImpl,
    headers: {},
  });

  assert.deepEqual(calls, [
    "https://api.github.com/repos/ubiquity-os-marketplace/command-config/contents/manifest.json?ref=dist%2Fdevelopment",
  ]);
  assert.equal(result.ref, "dist/development");
  assert.equal(result.source, "artifact");
  assert.equal(result.manifest.name, "artifact-manifest");
});

test("fetchManifest falls back to the source ref during migration", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);

    if (url.includes("ref=dist%2Fdevelopment")) {
      return createJsonResponse(404, { message: "Not Found" });
    }

    if (url.includes("ref=development")) {
      return createJsonResponse(200, encodeManifest({ name: "legacy-manifest" }));
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await fetchManifest("ubiquity-os-marketplace", "command-config", "development", {
    fetchImpl,
    headers: {},
  });

  assert.deepEqual(calls, [
    "https://api.github.com/repos/ubiquity-os-marketplace/command-config/contents/manifest.json?ref=dist%2Fdevelopment",
    "https://api.github.com/repos/ubiquity-os-marketplace/command-config/contents/manifest.json?ref=development",
  ]);
  assert.equal(result.ref, "development");
  assert.equal(result.source, "legacy");
  assert.equal(result.manifest.name, "legacy-manifest");
});

test("generateRegistry writes plugin and meta files using artifact refs", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-registry-"));

  const fetchImpl = async (url) => {
    if (url.startsWith("https://api.github.com/orgs/ubiquity-os-marketplace/repos")) {
      if (url.includes("page=1")) {
        return createJsonResponse(200, [
          {
            name: "command-config",
            default_branch: "development",
            pushed_at: "2026-03-17T15:12:55Z",
          },
        ]);
      }

      return createJsonResponse(200, []);
    }

    if (url.includes("/command-config/contents/manifest.json?ref=dist%2Fdevelopment")) {
      return createJsonResponse(
        200,
        encodeManifest({
          name: "@ubiquity-os-marketplace/command-config",
          short_name: "ubiquity-os-marketplace/command-config@development",
          description: "Example manifest",
          homepage_url: "https://command-config-development.deno.dev",
          "ubiquity:listeners": ["issues.opened"],
          commands: {
            config: {
              description: "Configure the plugin.",
            },
          },
          configuration: {
            properties: {
              zebra: {},
              alpha: {},
            },
          },
        })
      );
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  const logger = {
    log() {},
    warn() {},
  };

  try {
    const result = await generateRegistry({
      workspace: tempDir,
      fetchImpl,
      logger,
      now: new Date("2026-03-18T00:00:00.000Z"),
    });

    assert.equal(result.plugins.length, 1);

    const registry = JSON.parse(
      fs.readFileSync(path.join(tempDir, ".github", "ubiquity-os-marketplace.plugin-registry.json"), "utf8")
    );
    const meta = JSON.parse(
      fs.readFileSync(path.join(tempDir, ".github", "ubiquity-os-marketplace.plugin-registry.meta.json"), "utf8")
    );

    assert.equal(registry.count, 1);
    assert.equal(registry.plugins[0].repo, "command-config");
    assert.deepEqual(registry.plugins[0].manifest.config_properties, ["alpha", "zebra"]);
    assert.equal(meta.repo_state["command-config"].artifact_ref, "dist/development");
    assert.equal(meta.repo_state["command-config"].manifest_ref, "dist/development");
    assert.equal(meta.repo_state["command-config"].manifest_source, "artifact");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
