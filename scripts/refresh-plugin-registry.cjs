const fs = require("fs");
const path = require("path");

const DEFAULT_ORG = "ubiquity-os-marketplace";
const REGISTRY_PATH = path.join(".github", "ubiquity-os-marketplace.plugin-registry.json");
const META_PATH = path.join(".github", "ubiquity-os-marketplace.plugin-registry.meta.json");

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) return null;

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function createHeaders(token = process.env.GITHUB_TOKEN) {
  const headers = {
    "User-Agent": "ubiquity-os-marketplace-plugin-registry",
    Accept: "application/vnd.github+json",
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

function resolveArtifactRef(ref) {
  if (!ref) return ref;
  return ref.startsWith("dist/") ? ref : `dist/${ref}`;
}

function buildManifestUrl(owner, repo, ref) {
  return `https://api.github.com/repos/${owner}/${repo}/contents/manifest.json?ref=${encodeURIComponent(ref)}`;
}

async function fetchJson(url, { fetchImpl = fetch, headers = createHeaders() } = {}) {
  const response = await fetchImpl(url, { headers });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText} (${url})`);
  }
  return response.json();
}

async function fetchAllRepos({ org = DEFAULT_ORG, fetchImpl = fetch, headers = createHeaders() } = {}) {
  const repos = [];
  let page = 1;

  while (true) {
    const url = `https://api.github.com/orgs/${org}/repos?per_page=100&type=public&page=${page}`;
    const data = await fetchJson(url, { fetchImpl, headers });

    if (!Array.isArray(data) || data.length === 0) break;

    repos.push(...data);
    if (data.length < 100) break;
    page += 1;
  }

  return repos;
}

function parseManifestResponse(data) {
  if (Array.isArray(data) || !data?.content) return null;

  const raw = Buffer.from(data.content, "base64").toString("utf8");
  return JSON.parse(raw);
}

async function fetchManifestFromRef(owner, repo, ref, { fetchImpl = fetch, headers = createHeaders() } = {}) {
  const response = await fetchImpl(buildManifestUrl(owner, repo, ref), { headers });

  if (response.status === 404) return null;

  if (!response.ok) {
    throw new Error(`Manifest request failed: ${response.status} ${response.statusText} (${owner}/${repo}@${ref})`);
  }

  const data = await response.json();
  const manifest = parseManifestResponse(data);
  if (!manifest) return null;

  return { manifest, ref };
}

async function fetchManifest(owner, repo, sourceRef, { fetchImpl = fetch, headers = createHeaders() } = {}) {
  const artifactRef = resolveArtifactRef(sourceRef);
  const refsToTry = artifactRef === sourceRef ? [sourceRef] : [artifactRef, sourceRef];

  for (const ref of refsToTry) {
    const result = await fetchManifestFromRef(owner, repo, ref, { fetchImpl, headers });
    if (result?.manifest) {
      return {
        manifest: result.manifest,
        ref,
        source: ref === artifactRef ? "artifact" : "legacy",
      };
    }
  }

  return null;
}

function getConfigProperties(manifest) {
  if (manifest?.configuration?.properties && typeof manifest.configuration.properties === "object") {
    return Object.keys(manifest.configuration.properties).sort((a, b) => a.localeCompare(b));
  }

  return [];
}

function createPluginRecord(org, repo, defaultBranch, manifest) {
  return {
    owner: org,
    repo,
    default_branch: defaultBranch,
    manifest: {
      name: manifest?.name ?? "",
      short_name: manifest?.short_name ?? "",
      description: manifest?.description ?? "",
      homepage_url: manifest?.homepage_url ?? "",
      listeners: manifest?.["ubiquity:listeners"] ?? [],
      commands: manifest?.commands ?? {},
      config_properties: getConfigProperties(manifest),
    },
  };
}

async function generateRegistry({
  org = DEFAULT_ORG,
  workspace = process.env.GITHUB_WORKSPACE || process.cwd(),
  fetchImpl = fetch,
  logger = console,
  now = new Date(),
} = {}) {
  const registryFile = path.join(workspace, REGISTRY_PATH);
  const metaFile = path.join(workspace, META_PATH);

  const existingRegistry = loadJson(registryFile);
  const existingMeta = loadJson(metaFile);
  const existingPlugins = Array.isArray(existingRegistry?.plugins) ? existingRegistry.plugins : [];
  const existingPluginsByRepo = new Map(existingPlugins.map((plugin) => [plugin.repo, plugin]));
  const previousRepoState =
    existingMeta?.repo_state && typeof existingMeta.repo_state === "object" ? existingMeta.repo_state : {};

  const headers = createHeaders();
  const repos = (await fetchAllRepos({ org, fetchImpl, headers })).filter((repo) => repo?.name);
  repos.sort((a, b) => a.name.localeCompare(b.name));

  const repoState = {};
  const plugins = [];

  for (const repo of repos) {
    const defaultBranch = repo.default_branch || "main";
    const pushedAt = repo.pushed_at ?? null;
    const artifactRef = resolveArtifactRef(defaultBranch);
    const previousState = previousRepoState[repo.name];
    const cachedPlugin = existingPluginsByRepo.get(repo.name);

    const baseState = {
      pushed_at: pushedAt,
      default_branch: defaultBranch,
      artifact_ref: artifactRef,
    };

    const needsRefresh =
      !cachedPlugin ||
      !previousState ||
      previousState.pushed_at !== pushedAt ||
      previousState.default_branch !== defaultBranch ||
      previousState.artifact_ref !== artifactRef;

    if (!needsRefresh && cachedPlugin) {
      repoState[repo.name] = {
        ...baseState,
        manifest_ref: previousState.manifest_ref ?? null,
        manifest_source: previousState.manifest_source ?? null,
      };
      plugins.push(cachedPlugin);
      continue;
    }

    repoState[repo.name] = {
      ...baseState,
      manifest_ref: null,
      manifest_source: null,
    };

    try {
      const manifestResult = await fetchManifest(org, repo.name, defaultBranch, { fetchImpl, headers });
      if (!manifestResult) continue;

      repoState[repo.name].manifest_ref = manifestResult.ref;
      repoState[repo.name].manifest_source = manifestResult.source;

      if (manifestResult.source === "legacy") {
        logger.warn(
          `Using legacy source manifest for ${repo.name}@${defaultBranch}; ${artifactRef} is not available yet.`
        );
      }

      plugins.push(createPluginRecord(org, repo.name, defaultBranch, manifestResult.manifest));
    } catch (error) {
      logger.warn(`Skipping ${repo.name}: ${error.message}`);
    }
  }

  plugins.sort((a, b) => a.repo.localeCompare(b.repo));

  const pluginsChanged =
    !existingRegistry ||
    existingRegistry?.count !== plugins.length ||
    JSON.stringify(existingRegistry?.plugins ?? []) !== JSON.stringify(plugins);

  const repoStateChanged = JSON.stringify(previousRepoState) !== JSON.stringify(repoState);
  const generatedAt = now.toISOString();

  if (pluginsChanged) {
    writeJson(registryFile, {
      generated_at: generatedAt,
      source_org: org,
      count: plugins.length,
      plugins,
    });
  } else {
    logger.log("Registry unchanged; skipping write.");
  }

  if (repoStateChanged) {
    writeJson(metaFile, {
      generated_at: generatedAt,
      source_org: org,
      repo_state: repoState,
    });
  } else {
    logger.log("Repo state unchanged; skipping meta write.");
  }

  return {
    plugins,
    repoState,
    pluginsChanged,
    repoStateChanged,
    registryFile,
    metaFile,
  };
}

async function main() {
  const result = await generateRegistry();
  console.log(`Processed ${result.plugins.length} plugin manifests.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_ORG,
  REGISTRY_PATH,
  META_PATH,
  loadJson,
  writeJson,
  createHeaders,
  resolveArtifactRef,
  buildManifestUrl,
  fetchJson,
  fetchAllRepos,
  parseManifestResponse,
  fetchManifestFromRef,
  fetchManifest,
  getConfigProperties,
  createPluginRecord,
  generateRegistry,
};
