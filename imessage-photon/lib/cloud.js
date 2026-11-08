/**
 * The agent's Photon project: which iMessage lines it has and the bearer
 * token for each, from Spectrum's documented token endpoint
 * (`POST /projects/{id}/imessage/tokens`, HTTP Basic with the project id
 * and secret). This is Photon's Stable platform (Spectrum); its project
 * ids are UUIDs. Photon 2.0 (Beta) uses `pho_prj_` ids and other APIs.
 *
 * A token is reused until 80% of its lifetime has passed, then the next
 * caller fetches a new one; concurrent callers share one request. The
 * line list is read once, at start: a line added to the project while the
 * daemon runs is picked up at the next start.
 */

export const SPECTRUM_CLOUD = 'https://spectrum.photon.codes';
// Where a shared-pool project's line is served. spectrum-ts 12.15.0 uses
// the same default (its SPECTRUM_IMESSAGE_ADDRESS).
export const SHARED_ADDRESS = 'imessage.spectrum.photon.codes:443';
export const lineAddress = (instanceId) => `${instanceId}.imsg.photon.codes:443`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTANCE = /^[a-z0-9][a-z0-9-]{0,62}$/i;
const RENEW_AT = 0.8;

export class PhotonAuthError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'PhotonAuthError';
    this.status = status;
  }
}

const strings = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.values(value).every((entry) => typeof entry === 'string' && entry.length > 0);

/** The token payload, or why it isn't one. Never echoes a token. */
const tokenData = (json) => {
  const data = json?.succeed === true ? json.data : undefined;
  if (!data || !Number.isSafeInteger(data.expiresIn) || data.expiresIn <= 0) {
    return undefined;
  }
  if (data.type === 'shared' && typeof data.token === 'string' && data.token.length > 0) {
    return { type: 'shared', token: data.token, expiresIn: data.expiresIn };
  }
  if (data.type === 'dedicated' && strings(data.auth) && strings(data.numbers ?? {})) {
    return { type: 'dedicated', auth: data.auth, numbers: data.numbers ?? {}, expiresIn: data.expiresIn };
  }
  return undefined;
};

const reasonFor = async (response) => {
  let detail = '';
  try {
    const body = await response.json();
    if (typeof body?.message === 'string') {
      detail = `: ${body.message.slice(0, 200)}`;
    }
  } catch {
    // An unreadable body says nothing more than the status.
  }
  if (response.status === 401 || response.status === 403) {
    return `Photon refused this project id and secret (HTTP ${response.status}${detail}). Check them with \`stratus channel set imessage-photon --agent <id> projectId projectSecret\`.`;
  }
  if (response.status === 404) {
    return `Photon has no such project (HTTP 404${detail}).`;
  }
  return `Photon's token endpoint answered HTTP ${response.status}${detail}.`;
};

export const createPhotonAuth = ({
  projectId,
  projectSecret,
  fetch = globalThis.fetch,
  now = Date.now,
  cloudUrl = SPECTRUM_CLOUD,
  sharedAddress = SHARED_ADDRESS,
  addressFor = lineAddress,
}) => {
  if (typeof projectId !== 'string' || !UUID.test(projectId.trim())) {
    const beta = typeof projectId === 'string' && projectId.startsWith('pho_prj_');
    throw new PhotonAuthError(beta
      ? 'The stored projectId starts with pho_prj_, a Photon 2.0 (Beta) project. This plugin uses Photon Stable (Spectrum): create the project at app.photon.codes and store its UUID project id.'
      : 'The stored projectId is not a Photon project id (a UUID, from the project settings at app.photon.codes).');
  }
  if (typeof projectSecret !== 'string' || projectSecret.length === 0) {
    throw new PhotonAuthError('No projectSecret is stored for this agent.');
  }
  const id = projectId.trim();
  const authorization = `Basic ${Buffer.from(`${id}:${projectSecret}`).toString('base64')}`;
  let current;
  let pending;

  const issue = async (signal) => {
    let response;
    try {
      response = await fetch(`${cloudUrl}/projects/${encodeURIComponent(id)}/imessage/tokens`, {
        method: 'POST',
        headers: { Authorization: authorization },
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw new PhotonAuthError(`Could not reach Photon to get iMessage tokens: ${error?.message ?? String(error)}`);
    }
    if (!response.ok) {
      throw new PhotonAuthError(await reasonFor(response), response.status);
    }
    let json;
    try {
      json = await response.json();
    } catch {
      json = undefined;
    }
    const data = tokenData(json);
    if (!data) {
      throw new PhotonAuthError("Photon's token endpoint answered with something that isn't an iMessage token payload.");
    }
    current = { data, issuedAt: now() };
    return data;
  };

  const fresh = async (signal) => {
    if (current && now() - current.issuedAt < current.data.expiresIn * 1000 * RENEW_AT) {
      return current.data;
    }
    pending ??= issue(signal).finally(() => {
      pending = undefined;
    });
    return pending;
  };

  return {
    /**
     * The project's lines. A shared pool is one line, `shared`; dedicated
     * lines are keyed by Photon's instance id. A line Photon lists without
     * a phone number is left out, as spectrum-ts does.
     */
    lines: async (signal) => {
      const data = await fresh(signal);
      if (data.type === 'shared') {
        return [{ key: 'shared', address: sharedAddress, shared: true }];
      }
      return Object.keys(data.auth)
        .filter((instanceId) => INSTANCE.test(instanceId) && typeof data.numbers[instanceId] === 'string')
        .map((instanceId) => ({ key: instanceId, address: addressFor(instanceId), phone: data.numbers[instanceId], shared: false }));
    },
    /** A current token for one line, fetching a new set once the old one is 80% through its life. */
    token: async (key) => {
      const data = await fresh();
      if (data.type === 'shared') {
        return data.token;
      }
      const token = data.auth[key];
      if (typeof token !== 'string') {
        throw new PhotonAuthError(`Photon no longer lists line ${key} for this project.`);
      }
      return token;
    },
  };
};
