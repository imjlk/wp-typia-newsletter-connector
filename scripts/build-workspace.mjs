#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function getBlockRoot() {
	return path.join( process.cwd(), 'src', 'blocks' );
}

function getBlockSlugs() {
	const blockRoot = getBlockRoot();
	if ( ! fs.existsSync( blockRoot ) ) {
		return [];
	}

	return fs
		.readdirSync( blockRoot, { withFileTypes: true } )
		.filter( ( entry ) => entry.isDirectory() )
		.map( ( entry ) => entry.name )
		.sort();
}

function hasSharedEditorEntries() {
	for ( const relativePath of [
		'src/bindings/index.ts',
		'src/bindings/index.js',
		'src/editor-plugins/index.tsx',
		'src/editor-plugins/index.ts',
		'src/editor-plugins/index.js',
		'src/admin-views/index.tsx',
		'src/admin-views/index.ts',
		'src/admin-views/index.js',
	] ) {
		if ( fs.existsSync( path.join( process.cwd(), relativePath ) ) ) {
			return true;
		}
	}

	return false;
}

function ensureEmptyWorkspaceArtifacts() {
	const buildBlocksDir = path.join( process.cwd(), 'build', 'blocks' );
	const manifestPath = path.join( process.cwd(), 'build', 'blocks-manifest.php' );
	fs.rmSync( buildBlocksDir, { force: true, recursive: true } );
	fs.mkdirSync( buildBlocksDir, { recursive: true } );
	fs.writeFileSync(
		manifestPath,
		"<?php\nreturn array();\n",
		'utf8'
	);
}

function getWpScriptsBin() {
	return path.join(
		process.cwd(),
		'node_modules',
		'.bin',
		process.platform === 'win32' ? 'wp-scripts.cmd' : 'wp-scripts'
	);
}

function main() {
	const mode = process.argv[ 2 ] ?? 'build';
	if ( mode !== 'build' && mode !== 'start' ) {
		throw new Error( `Unknown workspace build mode: ${ mode }` );
	}

	const blockSlugs = getBlockSlugs();
	const hasSharedEntries = hasSharedEditorEntries();
	if ( blockSlugs.length === 0 && ! hasSharedEntries ) {
		ensureEmptyWorkspaceArtifacts();
		console.log(
			mode === 'start'
				? 'ℹ️ No workspace blocks are registered yet. Add one with `wp-typia add block <name> --template basic` before starting the watcher.'
				: 'ℹ️ No workspace blocks are registered yet. Empty workspace build artifacts are up to date.'
		);
		return;
	}

	const passthroughArgs = process.argv.slice( 3 );
	execFileSync(
		getWpScriptsBin(),
		[ mode, '--experimental-modules', '--blocks-manifest', ...passthroughArgs ],
		{
			cwd: process.cwd(),
			stdio: 'inherit',
		}
	);

	if ( blockSlugs.length === 0 ) {
		ensureEmptyWorkspaceArtifacts();
	}
}

main();
