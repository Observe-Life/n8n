#!/usr/bin/env node
// Lints the JSDoc on `@Env` config properties with the n8n-docs Vale rules.
// The docs site publishes these comments as the env var reference, so they
// must pass the same checks a docs PR gets.
//
//   node scripts/lint-env-var-docs.mjs            # @Env files changed vs origin/master
//   node scripts/lint-env-var-docs.mjs --all      # every @Env in packages/
//   node scripts/lint-env-var-docs.mjs --refresh  # re-fetch the n8n-docs rules

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'node_modules', '.cache', 'lint-env-var-docs');
const DOCS_REPO = 'https://github.com/n8n-io/n8n-docs.git';
// Pinned like other npx tools in scripts/; bump deliberately.
const VALE_NPM_VERSION = '3.24.0';
// Words the docs spell checker rejects but that are normal in operator-facing text.
const ACCEPT_WORDS = [
	'env',
	'config',
	'configs',
	'rollout',
	'eval',
	'dirs',
	'keepalive',
	'sqlite',
	'redis',
	'runtime',
	'uncached',
	'misconfigured',
	'lookups',
	'prepended',
	'errored',
	'sandboxing',
];

const args = new Set(process.argv.slice(2));
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();

// --- pick files -------------------------------------------------------------
const isSource = (f) =>
	f.endsWith('.ts') && !/\.(test|spec|d)\.ts$/.test(f) && !/\/(test|__tests__)\//.test(f);
let files;
if (args.has('--all')) {
	files = git('grep', '-l', '@Env(', '--', 'packages').split('\n');
} else {
	const base = git('merge-base', 'origin/master', 'HEAD');
	files = git('diff', '--name-only', base, '--', 'packages').split('\n').filter(Boolean);
	files = files.filter(
		(f) => existsSync(join(ROOT, f)) && readFileSync(join(ROOT, f), 'utf8').includes('@Env('),
	);
}
files = files.filter(isSource);
if (files.length === 0) {
	console.log('No @Env declarations to lint.');
	process.exit(0);
}

// --- extract jsdoc ------------------------------------------------------------
const ENV_RE = /(\/\*\*(?:(?!\*\/)[\s\S])*?\*\/\s*)?@Env\(['"]([A-Z0-9_]+)['"]/g;
const rows = [];
for (const file of files) {
	const source = readFileSync(join(ROOT, file), 'utf8');
	for (const match of source.matchAll(ENV_RE)) {
		const line = source.slice(0, match.index).split('\n').length;
		const doc = (match[1] ?? '')
			.replace(/^\s*\/\*\*|\*\/\s*$/g, '')
			.split('\n')
			.map((l) => l.replace(/^\s*\*\s?/, '').trim())
			.filter(Boolean)
			.join(' ');
		rows.push({ file, line, name: match[2], doc });
	}
}

// --- fetch n8n-docs rules ----------------------------------------------------
const styles = join(CACHE, 'n8n-docs');
if (args.has('--refresh')) rmSync(styles, { recursive: true, force: true });
if (!existsSync(join(styles, 'styles'))) {
	mkdirSync(CACHE, { recursive: true });
	rmSync(styles, { recursive: true, force: true });
	execFileSync(
		'git',
		['clone', '-q', '--depth', '1', '--filter=blob:none', '--sparse', DOCS_REPO, styles],
		{ stdio: 'inherit' },
	);
	execFileSync('git', ['sparse-checkout', 'set', 'styles'], { cwd: styles, stdio: 'inherit' });
}
// Own config: same rule set as n8n-docs, plus an accept list for operator vocabulary.
const vocab = join(styles, 'styles', 'config', 'vocabularies', 'env-var-docs');
mkdirSync(vocab, { recursive: true });
writeFileSync(join(vocab, 'accept.txt'), ACCEPT_WORDS.join('\n') + '\n');
const docsIni = readFileSync(join(styles, '.vale.ini'), 'utf8');
const basedOn =
	/BasedOnStyles = (.*)/.exec(docsIni)?.[1] ?? 'from-write-good, n8n-styles, from-microsoft, Vale';
writeFileSync(
	join(CACHE, '.vale.ini'),
	`StylesPath = n8n-docs/styles\nMinAlertLevel = warning\nVocab = default, env-var-docs\n[*.md]\nBasedOnStyles = ${basedOn}\nVale.Terms = NO\n`,
);

// --- run vale -----------------------------------------------------------------
const mdPath = join(CACHE, 'env-vars.md');
writeFileSync(mdPath, rows.map((r) => (r.doc || 'MISSING JSDOC') + '\n').join('\n'));
const vale = spawnSync(
	'npx',
	[
		'-y',
		`@vvago/vale@${VALE_NPM_VERSION}`,
		'--config',
		join(CACHE, '.vale.ini'),
		'--output=line',
		mdPath,
	],
	{ encoding: 'utf8' },
);
if (vale.error) throw vale.error;

// Each row is one paragraph: markdown line 2n+1 -> row n.
const alerts = [];
for (const r of rows) if (!r.doc) alerts.push(`${r.file}:${r.line} ${r.name}: missing JSDoc`);
for (const out of vale.stdout.split('\n').filter(Boolean)) {
	const [, mdLine, , rule, ...rest] = out.split(':');
	const row = rows[Math.floor((Number(mdLine) - 1) / 2)];
	alerts.push(`${row.file}:${row.line} ${row.name}: ${rule.trim()} ${rest.join(':').trim()}`);
}
for (const a of alerts.sort()) console.log(a);
console.log(`\n${rows.length} env vars checked, ${alerts.length} alerts.`);
process.exit(alerts.length ? 1 : 0);
