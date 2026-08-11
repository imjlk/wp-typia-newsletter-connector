import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire( import.meta.url );
const sourcePackageRoot = path.dirname(
	require.resolve( '@ttsc/lint/package.json' )
);
const compatibilityScriptPath = fileURLToPath(
	new URL( '../../scripts/apply-ttsc-lint-compat.mjs', import.meta.url )
);
const copiedPaths = [
	'package.json',
	'linthost/rules_format_trailing_comma.go',
	'linthost/config.go',
	'src/index.ts',
	'lib/index.js',
];
const bufferPaths = [ 'linthost/config.go', 'src/index.ts', 'lib/index.js' ];
const unpatchedParentGuard = `    list := node.Parent.TypeParameterList()
    if list == nil || len(list.Nodes) == 0 || list.Nodes[len(list.Nodes)-1] != node {
      return
    }`;
const patchedParentGuard = `    switch node.Parent.Kind {
    case shimast.KindClassDeclaration,
      shimast.KindClassExpression,
      shimast.KindInterfaceDeclaration,
      shimast.KindTypeAliasDeclaration,
      shimast.KindJSTypeAliasDeclaration,
      shimast.KindJSDocTemplateTag:
      // These declaration kinds own an actual type-parameter list.
    default:
      if node.Parent.FunctionLikeData() == nil {
        // Mapped and infer type parameters do not expose TypeParameterList.
        return
      }
    }
    list := node.Parent.TypeParameterList()
    if list == nil || len(list.Nodes) == 0 || list.Nodes[len(list.Nodes)-1] != node {
      return
    }`;

function createFixture() {
	const fixtureRoot = fs.mkdtempSync(
		path.join( os.tmpdir(), 'ttsc-lint-compat-' )
	);
	try {
		return populateFixture( fixtureRoot );
	} catch ( error ) {
		fs.rmSync( fixtureRoot, { force: true, recursive: true } );
		throw error;
	}
}

function populateFixture( fixtureRoot ) {
	const packageRoot = path.join(
		fixtureRoot,
		'node_modules',
		'@ttsc',
		'lint'
	);
	for ( const relativePath of copiedPaths ) {
		const targetPath = path.join( packageRoot, relativePath );
		fs.mkdirSync( path.dirname( targetPath ), { recursive: true } );
		fs.copyFileSync(
			path.join( sourcePackageRoot, relativePath ),
			targetPath
		);
	}

	const rulePath = path.join(
		packageRoot,
		'linthost',
		'rules_format_trailing_comma.go'
	);
	const ruleSource = fs.readFileSync( rulePath, 'utf8' );
	assert.equal( ruleSource.includes( patchedParentGuard ), true );
	fs.writeFileSync(
		rulePath,
		ruleSource.replace( patchedParentGuard, unpatchedParentGuard )
	);

	for ( const relativePath of bufferPaths ) {
		const sourcePath = path.join( packageRoot, relativePath );
		const source = fs.readFileSync( sourcePath, 'utf8' );
		const unpatchedSource = source
			.replaceAll(
				'let target: Buffer = Buffer.alloc(0);',
				'let target = Buffer.alloc(0);'
			)
			.replaceAll(
				'/** @type {Buffer} */ let target = Buffer.alloc(0);',
				'let target = Buffer.alloc(0);'
			);
		assert.notEqual( unpatchedSource, source );
		fs.writeFileSync( sourcePath, unpatchedSource );
	}
	return { fixtureRoot, packageRoot, rulePath };
}

function runCompatibilityScript( fixtureRoot ) {
	return spawnSync( process.execPath, [ compatibilityScriptPath ], {
		cwd: fixtureRoot,
		encoding: 'utf8',
		timeout: 30_000,
	} );
}

function runNodeSyntaxCheck( sourcePath ) {
	return spawnSync( process.execPath, [ '--check', sourcePath ], {
		encoding: 'utf8',
		timeout: 30_000,
	} );
}

function assertNormalExit( result ) {
	assert.equal(
		result.error,
		undefined,
		result.error?.code === 'ETIMEDOUT'
			? 'The compatibility script timed out after 30 seconds.'
			: String( result.error )
	);
	assert.equal(
		result.signal,
		null,
		`Expected a normal exit, received ${ String( result.signal ) }${
			result.stderr === '' ? '' : `\n${ result.stderr }`
		}`
	);
}

function assertSuccessfulRun( result ) {
	assertNormalExit( result );
	assert.equal( result.status, 0, result.stderr );
}

test( 'compatibility repairs are recoverable and idempotent', ( t ) => {
	const { fixtureRoot, packageRoot, rulePath } = createFixture();
	t.after( () => fs.rmSync( fixtureRoot, { force: true, recursive: true } ) );

	const indexPath = path.join( packageRoot, 'src', 'index.ts' );
	const staleTemporaryPath = `${ indexPath }.wp-typia-12345.tmp`;
	const freshTemporaryPath = `${ indexPath }.wp-typia-67890.tmp`;
	fs.writeFileSync( staleTemporaryPath, 'stale' );
	fs.writeFileSync( freshTemporaryPath, 'fresh' );
	const staleTime = new Date( Date.now() - 2 * 60 * 60 * 1000 );
	fs.utimesSync( staleTemporaryPath, staleTime, staleTime );

	const firstRun = runCompatibilityScript( fixtureRoot );
	assertSuccessfulRun( firstRun );
	assert.equal( fs.existsSync( staleTemporaryPath ), false );
	assert.equal( fs.existsSync( freshTemporaryPath ), true );
	assert.equal(
		fs.readFileSync( rulePath, 'utf8' ).includes( patchedParentGuard ),
		true
	);
	const firstPatchedIndex = fs.readFileSync( indexPath, 'utf8' );
	assert.equal(
		firstPatchedIndex.includes(
			'let target: Buffer = Buffer.alloc(0);'
		),
		true
	);
	const runtimePath = path.join( packageRoot, 'lib', 'index.js' );
	const patchedRuntime = fs.readFileSync( runtimePath, 'utf8' );
	assert.equal(
		patchedRuntime.match( /let target: Buffer = Buffer\.alloc\(0\);/gu )
			?.length,
		2,
		'The embedded ttsx extractor must retain explicit Buffer types.'
	);
	assert.equal(
		patchedRuntime.includes(
			'/** @type {Buffer} */ let target = Buffer.alloc(0);'
		),
		false
	);
	// The typed declarations above are inside a template literal, not executable
	// syntax in lib/index.js. Guard both halves of that boundary.
	assertSuccessfulRun( runNodeSyntaxCheck( runtimePath ) );

	const postRepairStalePath = `${ indexPath }.wp-typia-24680.tmp`;
	fs.writeFileSync( postRepairStalePath, 'stale after repair' );
	fs.utimesSync( postRepairStalePath, staleTime, staleTime );

	const secondRun = runCompatibilityScript( fixtureRoot );
	assertSuccessfulRun( secondRun );
	assert.equal( fs.existsSync( postRepairStalePath ), false );
	assert.equal( fs.readFileSync( indexPath, 'utf8' ), firstPatchedIndex );
} );

test( 'unexpected Buffer annotations fail with recovery guidance', ( t ) => {
	const { fixtureRoot, packageRoot } = createFixture();
	t.after( () => fs.rmSync( fixtureRoot, { force: true, recursive: true } ) );

	const indexPath = path.join( packageRoot, 'src', 'index.ts' );
	const source = fs.readFileSync( indexPath, 'utf8' );
	const modifiedSource = source.replace(
		'let target = Buffer.alloc(0);',
		'let target: Uint8Array = Buffer.alloc(0);'
	);
	assert.notEqual( modifiedSource, source );
	fs.writeFileSync( indexPath, modifiedSource );

	const result = runCompatibilityScript( fixtureRoot );
	assertNormalExit( result );
	assert.notEqual( result.status, 0 );
	assert.match(
		result.stderr,
		/Failed to apply the @ttsc\/lint compatibility repairs/u
	);
	assert.match(
		result.stderr,
		/unexpected type annotation 'Uint8Array'/u
	);
	assert.match( result.stderr, /Re-run pnpm install/u );
} );

test( 'production-only installs skip an absent lint dependency', ( t ) => {
	const fixtureRoot = fs.mkdtempSync(
		path.join( os.tmpdir(), 'ttsc-lint-compat-production-' )
	);
	t.after( () => fs.rmSync( fixtureRoot, { force: true, recursive: true } ) );
	fs.writeFileSync( path.join( fixtureRoot, 'package.json' ), '{}\n' );

	const result = runCompatibilityScript( fixtureRoot );
	assertSuccessfulRun( result );
	assert.match(
		result.stdout,
		/@ttsc\/lint is not installed; skipping development-only compatibility repairs/u
	);
} );
