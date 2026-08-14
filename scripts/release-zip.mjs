#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const rootDir = process.cwd();
const packageJsonPath = path.join(rootDir, 'package.json');
const pluginFile = 'wp-typia-newsletter-connector.php';
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const pluginSlug = packageJson.name;
const escapedPluginSlug = escapeRegExp(pluginSlug);
// Keep exact forbidden markers fragmented: the WP.org source archive includes
// these scripts and is itself scanned byte-for-byte for those markers.
const legacyPluginSlug = [
	'connector-for-',
	'newspack-newsletters-',
	'and-listmonk',
].join('');
const version = packageJson.version;
const artifactsDir = path.join(rootDir, 'artifacts');
const releaseWorkDir = path.join(artifactsDir, 'release');
const distDir = path.join(releaseWorkDir, pluginSlug);
const zipPath = path.join(artifactsDir, `${pluginSlug}-${version}.zip`);

const restSchemaResources = [
	'listmonk-settings',
	'newsletter-preview',
	'newsletter-sync',
	'campaign-analytics',
];

const runtimePaths = [
	pluginFile,
	'uninstall.php',
	'inc',
	'build',
	'README.md',
	'CHANGELOG.md',
	'readme.txt',
	'LICENSE',
	'docs/SETUP.md',
	'docs/PRIVACY.md',
	'docs/WEBHOOK-POLICY.md',
	'docs/COMPATIBILITY.md',
	'docs/METHOD-MAPPING.md',
];

const requiredFiles = [
	pluginFile,
	'uninstall.php',
	'inc/bootstrap.php',
	'inc/compat.php',
	'inc/options.php',
	'inc/uninstall.php',
	'inc/admin/settings-page.php',
	'inc/listmonk/class-listmonk-client.php',
	'inc/provider/class-listmonk-controller.php',
	'inc/provider/class-listmonk-provider.php',
	'inc/render/class-plain-text-builder.php',
	'inc/render/class-raw-html-builder.php',
	'inc/rest/listmonk-settings.php',
	'inc/rest/newsletter-preview.php',
	'inc/rest/newsletter-sync.php',
	'inc/rest/campaign-analytics.php',
	'build/blocks-manifest.php',
	'build/admin-views/index.js',
	'build/admin-views/index.asset.php',
	'build/admin-views/style-index.css',
	'build/editor-plugins/index.js',
	'build/editor-plugins/index.asset.php',
	'build/editor-plugins/style-index.css',
	'README.md',
	'CHANGELOG.md',
	'readme.txt',
	'LICENSE',
	'docs/SETUP.md',
	'docs/PRIVACY.md',
	'docs/WEBHOOK-POLICY.md',
];

const forbiddenReviewDocuments = new Set([
	[ 'docs/STAGING-', 'CHECKLIST.md' ].join(''),
	[ 'docs/PLUGIN-REVIEW-', 'CHECKLIST.md' ].join(''),
]);

const requiredRestSchemaFiles = restSchemaResources.flatMap((resource) => {
	const schemaDir = path.join(rootDir, 'src/rest', resource, 'api-schemas');
	if (!fs.existsSync(schemaDir)) {
		return [];
	}

	return fs
		.readdirSync(schemaDir)
		.filter((fileName) => fileName.endsWith('.schema.json'))
		.map((fileName) => `src/rest/${resource}/api-schemas/${fileName}`);
});

const forbiddenZipPatterns = [
	new RegExp(`^${escapedPluginSlug}/(?:.*/)?\\.DS_Store$`),
	new RegExp(`^${escapedPluginSlug}/node_modules/`),
	new RegExp(`^${escapedPluginSlug}/vendor/`),
	new RegExp(`^${escapedPluginSlug}/src/`),
	new RegExp(`^${escapedPluginSlug}/tests/`),
	new RegExp(`^${escapedPluginSlug}/scripts/`),
	new RegExp(`^${escapedPluginSlug}/artifacts/`),
	new RegExp(`^${escapedPluginSlug}/\\.git(?:/|$)`),
	new RegExp(`^${escapedPluginSlug}/\\.env(?:\\.|$)`),
	new RegExp(`^${escapedPluginSlug}/\\.listmonk\\.env$`),
	new RegExp(`^${escapedPluginSlug}/\\.wp-env(?:\\.|/|$)`),
	new RegExp(`^${escapedPluginSlug}/.*/\\.gitkeep$`),
	new RegExp(`^${escapedPluginSlug}/docker-compose\\.listmonk\\.yml$`),
	new RegExp(`^${escapedPluginSlug}/playwright\\.config\\.js$`),
	new RegExp(`^${escapedPluginSlug}/phpunit\\.xml\\.dist$`),
	new RegExp(`^${escapedPluginSlug}/composer\\.(?:json|lock)$`),
	new RegExp(`^${escapedPluginSlug}/package\\.json$`),
	new RegExp(`^${escapedPluginSlug}/pnpm-lock\\.yaml$`),
	new RegExp(`^${escapedPluginSlug}/tsconfig\\.json$`),
	new RegExp(`^${escapedPluginSlug}/webpack\\.config\\.js$`),
];

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function logStep(message) {
	console.log(`\n> ${message}`);
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd ?? rootDir,
		encoding: 'utf8',
		stdio: options.stdio ?? 'inherit',
	});

	if (result.error) {
		throw result.error;
	}

	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
	}

	return result;
}

function readPluginFile() {
	return fs.readFileSync(path.join(rootDir, pluginFile), 'utf8');
}

function assertVersionSync() {
	const pluginSource = readPluginFile();
	const headerMatch = pluginSource.match(/^\s*\*\s*Version:\s*([^\s]+)/m);
	const constantMatch = pluginSource.match(
		/define\(\s*'NEWSPACK_LISTMONK_CONNECTOR_VERSION'\s*,\s*'([^']+)'\s*\)/
	);

	if (!headerMatch) {
		throw new Error('Unable to find plugin header Version.');
	}
	if (!constantMatch) {
		throw new Error('Unable to find NEWSPACK_LISTMONK_CONNECTOR_VERSION.');
	}

	const pluginHeaderVersion = headerMatch[1];
	const pluginConstantVersion = constantMatch[1];
	const versions = [version, pluginHeaderVersion, pluginConstantVersion];
	if (new Set(versions).size !== 1) {
		throw new Error(
			`Version mismatch: package=${version}, header=${pluginHeaderVersion}, constant=${pluginConstantVersion}`
		);
	}
}

function assertSourceFilesExist() {
	for (const relativePath of [...requiredFiles, ...requiredRestSchemaFiles]) {
		const fullPath = path.join(rootDir, relativePath);
		if (!fs.existsSync(fullPath)) {
			throw new Error(`Missing required release file: ${relativePath}`);
		}
	}
}

function copyRuntimeFiles() {
	fs.rmSync(releaseWorkDir, { force: true, recursive: true });
	fs.mkdirSync(distDir, { recursive: true });

	for (const relativePath of runtimePaths) {
		const sourcePath = path.join(rootDir, relativePath);
		const targetPath = path.join(distDir, relativePath);
		if (!fs.existsSync(sourcePath)) {
			throw new Error(`Release source path does not exist: ${relativePath}`);
		}

		fs.mkdirSync(path.dirname(targetPath), { recursive: true });
		fs.cpSync(sourcePath, targetPath, {
			recursive: true,
			filter: (candidatePath) => path.basename(candidatePath) !== '.DS_Store',
		});
	}
}

function copyRestSchemas() {
	for (const relativePath of requiredRestSchemaFiles) {
		const sourcePath = path.join(rootDir, relativePath);
		const [, , resource, , fileName] = relativePath.split('/');
		const targetPath = path.join(distDir, 'inc/rest-schemas', resource, fileName);

		fs.mkdirSync(path.dirname(targetPath), { recursive: true });
		fs.copyFileSync(sourcePath, targetPath);
	}
}

function collectFiles(dir) {
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...collectFiles(fullPath));
		} else if (entry.isFile()) {
			files.push(fullPath);
		}
	}
	return files;
}

function lintPhpFiles() {
	const phpFiles = collectFiles(distDir).filter((file) => file.endsWith('.php'));
	for (const phpFile of phpFiles) {
		execFileSync('php', ['-l', phpFile], {
			cwd: rootDir,
			stdio: 'pipe',
		});
	}
}

function assertCleanReleaseTree() {
	const legacySlugBuffer = Buffer.from(legacyPluginSlug);
	for (const file of collectFiles(distDir)) {
		const relativePath = path
			.relative(distDir, file)
			.split(path.sep)
			.join('/');
		if (forbiddenReviewDocuments.has(relativePath)) {
			throw new Error(
				`Release tree contains review-only document: ${relativePath}`
			);
		}
		if (fs.readFileSync(file).includes(legacySlugBuffer)) {
			throw new Error(`Release tree contains legacy plugin slug: ${relativePath}`);
		}
	}
}

function createZip() {
	fs.mkdirSync(artifactsDir, { recursive: true });
	fs.rmSync(zipPath, { force: true });
	run('zip', ['-qr', zipPath, pluginSlug], {
		cwd: releaseWorkDir,
		stdio: 'inherit',
	});
}

function listZipEntries() {
	const output = execFileSync('unzip', ['-Z1', zipPath], {
		cwd: rootDir,
		encoding: 'utf8',
	});

	return output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
}

function assertZipContents() {
	const entries = listZipEntries();
	const entrySet = new Set(entries);
	const requiredZipEntries = requiredFiles
		.map((relativePath) => `${pluginSlug}/${relativePath}`)
		.concat(
			requiredRestSchemaFiles.map((relativePath) => {
				const [, , resource, , fileName] = relativePath.split('/');
				return `${pluginSlug}/inc/rest-schemas/${resource}/${fileName}`;
			})
		);

	for (const requiredEntry of requiredZipEntries) {
		if (!entrySet.has(requiredEntry)) {
			throw new Error(`Release zip is missing required entry: ${requiredEntry}`);
		}
	}

	for (const entry of entries) {
		if (entry.includes(legacyPluginSlug)) {
			throw new Error(`Release zip contains legacy plugin slug: ${entry}`);
		}
		if (forbiddenZipPatterns.some((pattern) => pattern.test(entry))) {
			throw new Error(`Release zip contains development-only entry: ${entry}`);
		}
	}
}

function main() {
	logStep('Validating synchronized release metadata');
	run('node', ['scripts/sync-release-version.mjs', '--check']);

	logStep('Building production assets');
	run('pnpm', ['run', 'build']);

	logStep('Validating release inputs');
	assertVersionSync();
	assertSourceFilesExist();

	logStep('Preparing release directory');
	copyRuntimeFiles();
	copyRestSchemas();
	assertCleanReleaseTree();
	lintPhpFiles();

	logStep('Creating plugin zip');
	createZip();
	assertZipContents();

	console.log(`\nCreated ${path.relative(rootDir, zipPath)}`);
}

main();
