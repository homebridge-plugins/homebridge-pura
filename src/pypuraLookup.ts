import { Logging } from 'homebridge';
import fetch from 'node-fetch';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tar, { ReadEntry } from 'tar';

type CognitoConfig = {
  userPoolId: string;
  clientId: string;
  version: string;
};

type PyPIFile = {
  packagetype?: string;
  url?: string;
};

type PyPIMetadata = {
  info?: {
    version?: string;
  };
  urls?: PyPIFile[];
  releases?: Record<string, PyPIFile[]>;
};

const PYPURA_JSON_URL = 'https://pypi.org/pypi/pypura/json';

const USER_POOL_RE = /USER_POOL_ID:\s*Final\s*=\s*"([^"]+)"/;
const CLIENT_ID_RE = /CLIENT_ID:\s*Final\s*=\s*"([^"]+)"/;

const decodeBase64 = (value: string): string => Buffer.from(value, 'base64').toString('utf8');

const findSdistUrl = (payload: PyPIMetadata, version: string): string | null => {
  const urls = Array.isArray(payload?.urls) ? payload.urls : [];
  const releaseUrls = Array.isArray(payload?.releases?.[version]) ? payload.releases[version] : [];
  const candidates = [...urls, ...releaseUrls];
  const sdist = candidates.find((entry) => entry?.packagetype === 'sdist' && typeof entry?.url === 'string');
  return sdist?.url ?? null;
};

const extractConstFile = async (archivePath: string): Promise<string | null> => {
  let contents: string | null = null;
  await tar.list({
    file: archivePath,
    onentry: (entry: ReadEntry) => {
      if (contents) {
        entry.resume();
        return;
      }
      if (entry.path.endsWith('/pypura/const.py') || entry.path === 'pypura/const.py') {
        const chunks: Buffer[] = [];
        entry.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        entry.on('end', () => {
          contents = Buffer.concat(chunks).toString('utf8');
        });
      } else {
        entry.resume();
      }
    },
  });
  return contents;
};

export const fetchLatestCognitoConfig = async (log: Logging): Promise<CognitoConfig | null> => {
  try {
    const response = await fetch(PYPURA_JSON_URL);
    if (!response.ok) {
      log.warn(`Failed to fetch pypura metadata: ${response.status} ${response.statusText}`);
      return null;
    }

    const payload = await response.json() as PyPIMetadata;
    const version = payload?.info?.version;
    if (!version || typeof version !== 'string') {
      log.warn('pypura metadata did not include a version');
      return null;
    }

    const sdistUrl = findSdistUrl(payload, version);
    if (!sdistUrl) {
      log.warn(`pypura ${version} metadata did not include an sdist URL`);
      return null;
    }

    const sdistResponse = await fetch(sdistUrl);
    if (!sdistResponse.ok) {
      log.warn(`Failed to download pypura sdist: ${sdistResponse.status} ${sdistResponse.statusText}`);
      return null;
    }

    const buffer = Buffer.from(await sdistResponse.arrayBuffer());
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pypura-'));
    const archivePath = path.join(tempDir, `pypura-${version}.tar.gz`);
    await fs.writeFile(archivePath, buffer);

    const constFile = await extractConstFile(archivePath);
    if (!constFile) {
      log.warn('Unable to locate pypura/const.py in sdist');
      return null;
    }

    const userPoolMatch = constFile.match(USER_POOL_RE);
    const clientIdMatch = constFile.match(CLIENT_ID_RE);
    if (!userPoolMatch || !clientIdMatch) {
      log.warn('Unable to parse Cognito constants from pypura/const.py');
      return null;
    }

    return {
      userPoolId: decodeBase64(userPoolMatch[1]),
      clientId: decodeBase64(clientIdMatch[1]),
      version,
    };
  } catch (error) {
    log.warn('Failed to fetch Cognito constants from pypura:', error);
    return null;
  }
};
