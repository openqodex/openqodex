// The self-update's only network use: three GETs to the npm registry. Each
// sends no body and no header but the user agent, follows redirects by hand
// so every hop stays on registry.npmjs.org over https, and stops at a size
// cap and a deadline. With OPENQODEX_OFFLINE=1 nothing is requested.

const REGISTRY_HOST = "registry.npmjs.org";
const METADATA_URL = `https://${REGISTRY_HOST}/openqodex`;
const MAX_REDIRECTS = 5;
const DEADLINE_MS = 120_000;

const MB = 1024 * 1024;
const LIMITS = { metadata: 20 * MB, attestations: 5 * MB, tarball: 50 * MB };

const VERSION = typeof __OPENQODEX_VERSION__ === "string" ? __OPENQODEX_VERSION__ : "dev";

export class UpdateFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdateFetchError";
  }
}

function registryUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UpdateFetchError(`not a URL: ${raw.slice(0, 200)}`);
  }
  if (url.protocol !== "https:") throw new UpdateFetchError(`refused ${url.protocol} URL, only https to ${REGISTRY_HOST}`);
  if (url.hostname !== REGISTRY_HOST || url.port !== "" || url.username !== "" || url.password !== "") {
    throw new UpdateFetchError(`refused host ${url.host}, only ${REGISTRY_HOST}`);
  }
  return url;
}

async function get(raw: string, maxBytes: number): Promise<Buffer> {
  if (process.env.OPENQODEX_OFFLINE === "1") throw new UpdateFetchError("offline, the registry is not contacted");
  let url = registryUrl(raw);
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), DEADLINE_MS);
  try {
    for (let hop = 0; ; hop++) {
      const response = await fetch(url, {
        method: "GET",
        redirect: "manual",
        headers: { "user-agent": `openqodex/${VERSION}` },
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (location === null) throw new UpdateFetchError(`HTTP ${response.status} without a location`);
        if (hop >= MAX_REDIRECTS) throw new UpdateFetchError("too many redirects");
        url = registryUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok || response.body === null) {
        await response.body?.cancel();
        throw new UpdateFetchError(`HTTP ${response.status} from ${url.pathname}`);
      }
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body.cancel();
        throw new UpdateFetchError(`larger than ${Math.round(maxBytes / MB)} MB`);
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          controller.abort();
          throw new UpdateFetchError(`larger than ${Math.round(maxBytes / MB)} MB`);
        }
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    }
  } catch (error) {
    if (error instanceof UpdateFetchError) throw error;
    if (controller.signal.aborted) throw new UpdateFetchError(`not finished after ${DEADLINE_MS / 1000} seconds`);
    const cause = error instanceof Error ? ((error.cause as { code?: string } | undefined)?.code ?? error.message) : String(error);
    throw new UpdateFetchError(`registry request failed: ${cause}`);
  } finally {
    clearTimeout(deadline);
  }
}

function json(bytes: Buffer, what: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new UpdateFetchError(`the registry sent ${what} that is not JSON`);
  }
}

// npm's full metadata document for openqodex: versions, publish times, dist.
export async function fetchMetadata(): Promise<unknown> {
  return json(await get(METADATA_URL, LIMITS.metadata), "metadata");
}

// The attestation set at a version's dist.attestations.url.
export async function fetchAttestations(url: string): Promise<unknown> {
  return json(await get(url, LIMITS.attestations), "attestations");
}

// A release tarball's bytes, unverified; verifyRelease decides whether to use them.
export async function fetchTarball(url: string): Promise<Buffer> {
  return get(url, LIMITS.tarball);
}
