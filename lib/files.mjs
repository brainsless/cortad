// Which of the repository's files are code, and which are tests: where a problem is placed at its
// line (lib/replay.mjs), and which files count as the app a run plays (lib/fresh.mjs).
export const CODE = /\.(?:[cm]?[jt]sx?|py|rb|go|php)$/;
// A test opens its own scratch file; that is not where the app keeps its data.
export const TEST = /(?:^|\/)(?:tests?|__tests__|spec|e2e|fixtures?)\/|[._-](?:test|spec)\.[^/]+$|(?:^|\/)(?:test_[^/]+|conftest)\.py$/;
