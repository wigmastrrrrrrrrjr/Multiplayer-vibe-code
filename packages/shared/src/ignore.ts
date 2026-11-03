import { minimatch } from 'minimatch';

/** Folder names ignored at any depth (top-level and nested). */
const FOLDER_IGNORES = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  '.next',
  '.turbo',
] as const;

/** For each folder: the name itself, in any parent, and its contents anywhere. */
const FOLDER_PATTERNS: string[] = FOLDER_IGNORES.flatMap((f) => [
  f,
  `**/${f}`,
  `**/${f}/**`,
]);

/**
 * Credential-shaped files are never synced by default. Syncing a project must
 * not leak local secrets to the lobby server or to every other member.
 * `.env.example` / `.env.sample` stay visible on purpose (they carry no secrets).
 */
const SECRET_IGNORES = [
  '.env',
  '**/.env',
  '.env.local',
  '**/.env.local',
  '.env.*.local',
  '**/.env.*.local',
  '.env.development',
  '**/.env.development',
  '.env.production',
  '**/.env.production',
  '.env.test',
  '**/.env.test',
  '.env.staging',
  '**/.env.staging',
  '.env.dev',
  '**/.env.dev',
  '.env.prod',
  '**/.env.prod',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.jks',
  '*.keystore',
  'id_rsa',
  '**/id_rsa',
  'id_ed25519',
  '**/id_ed25519',
  'id_ecdsa',
  '**/id_ecdsa',
  '.npmrc',
  '**/.npmrc',
  '.netrc',
  '**/.netrc',
  '.pgpass',
  '**/.pgpass',
  '.git-credentials',
  '**/.git-credentials',
  '.htpasswd',
  '**/.htpasswd',
  '.aws',
  '**/.aws',
  '.aws/**',
  '**/.aws/**',
  '.ssh',
  '**/.ssh',
  '.ssh/**',
  '**/.ssh/**',
  '.kube/config',
  '**/.kube/config',
];

/** Paths never synced — the same spirit as a sane .gitignore. */
export const DEFAULT_IGNORE: ReadonlyArray<string> = [
  ...FOLDER_PATTERNS,
  ...SECRET_IGNORES,
  '*.log',
  '.DS_Store',
  'Thumbs.db',
];

/**
 * True if `relativePath` should be excluded from syncing.
 * Applies the smart defaults, then the lobby's own `.lobbyignore` patterns.
 */
export function isIgnored(
  relativePath: string,
  extraPatterns: ReadonlyArray<string> = [],
): boolean {
  const normalized = relativePath.replaceAll('\\', '/');
  if (normalized.length === 0 || normalized === '.') return true;
  const patterns = [...DEFAULT_IGNORE, ...extraPatterns];
  return patterns.some((p) =>
    minimatch(normalized, p, { dot: true, matchBase: true }),
  );
}