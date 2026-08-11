import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const REQUIRED_VERSION = '0.26.2';
const STALE_TEMPORARY_FILE_AGE_MS = 60 * 60 * 1000;
const require = createRequire( path.join( process.cwd(), 'package.json' ) );
const manifestPath = require.resolve( '@ttsc/lint/package.json' );
const manifest = JSON.parse( fs.readFileSync( manifestPath, 'utf8' ) );

if ( manifest.version !== REQUIRED_VERSION ) {
	throw new Error(
		`Expected @ttsc/lint ${ REQUIRED_VERSION }, found ${ String(
			manifest.version
		) }. Remove this compatibility hook only after the mapped/infer and Node Buffer regressions pass on the replacement version.`
	);
}

const packageRoot = path.dirname( manifestPath );
const lintRulePath = path.join(
	packageRoot,
	'linthost',
	'rules_format_trailing_comma.go'
);
const lintIndexPath = path.join( packageRoot, 'src', 'index.ts' );
const lintRuntimePath = path.join( packageRoot, 'lib', 'index.js' );
const lintHostConfigPath = path.join( packageRoot, 'linthost', 'config.go' );
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
const bufferTargetPattern =
	/let target(?:: ([^=\r\n]+))? = Buffer\.alloc\(0\);(?=\r?\n\s*if \(entry\.isSymbolicLink\(\)\))/gu;
const unpatchedBufferTarget = 'let target = Buffer.alloc(0);';
const typedBufferTarget = 'let target: Buffer = Buffer.alloc(0);';
const legacyJSDocBufferTarget =
	'/** @type {Buffer} */ let target = Buffer.alloc(0);';

function countOccurrences( source, needle ) {
	let count = 0;
	let offset = 0;
	while ( ( offset = source.indexOf( needle, offset ) ) !== -1 ) {
		count += 1;
		offset += needle.length;
	}
	return count;
}

function prepareSourcePatches( { description, replacements, sourcePath } ) {
	const source = fs.readFileSync( sourcePath, 'utf8' );
	const states = replacements.map( ( replacement ) => ( {
		...replacement,
		patchedCount: countOccurrences( source, replacement.patchedSource ),
		unpatchedCount: countOccurrences(
			source.replaceAll( replacement.patchedSource, '' ),
			replacement.unpatchedSource
		),
	} ) );
	if (
		states.every(
			( state ) =>
				state.patchedCount === state.expectedOccurrences &&
				state.unpatchedCount === 0
		)
	) {
		return { nextSource: source, originalSource: source, sourcePath };
	}
	if (
		states.every(
			( state ) =>
				state.patchedCount === 0 &&
				state.unpatchedCount === state.expectedOccurrences
		)
	) {
		return {
			nextSource: replacements.reduce(
				( current, replacement ) =>
					current.replaceAll(
						replacement.unpatchedSource,
						replacement.patchedSource
					),
				source
			),
			originalSource: source,
			sourcePath,
		};
	}
	throw new Error(
		`Refusing to apply the ${ description } compatibility repair to unexpected @ttsc/lint source at ${ sourcePath }.`
	);
}

function prepareBufferTargetRepair(
	sourcePath,
	functionNames,
	{
		legacyTargets = [],
		patchedTarget = typedBufferTarget,
		scopeMarker,
	} = {}
) {
	const source = fs.readFileSync( sourcePath, 'utf8' );
	let nextSource = source;
	const searchStart =
		scopeMarker === undefined ? 0 : nextSource.indexOf( scopeMarker );
	if ( searchStart === -1 ) {
		throw new Error(
			`Refusing to apply the Node Buffer generic compatibility repair: scope marker '${ scopeMarker }' was not found at ${ sourcePath }.`
		);
	}
	for ( const functionName of functionNames ) {
		const functionStart = nextSource.indexOf(
			`function ${ functionName }(`,
			searchStart
		);
		// @ttsc/lint 0.26.2 places each digest function directly before its
		// Record variant. The exact version lock and validations below fail closed
		// if that upstream layout changes.
		const functionEnd = nextSource.indexOf(
			`function ${ functionName }Record(`,
			functionStart
		);
		if ( functionStart === -1 || functionEnd === -1 ) {
			throw new Error(
				`Refusing to apply the Node Buffer generic compatibility repair: function boundary for '${ functionName }' was not found at ${ sourcePath }.`
			);
		}
		let functionSource = nextSource.slice( functionStart, functionEnd );
		const trimmedFunctionSource = functionSource.trimEnd();
		if (
			! trimmedFunctionSource.startsWith( `function ${ functionName }(` ) ||
			! trimmedFunctionSource.endsWith( '}' )
		) {
			throw new Error(
				`Refusing to apply the Node Buffer generic compatibility repair: incoherent function boundary for '${ functionName }' at ${ sourcePath }.`
			);
		}
		// Strip the most specific declarations first: the runtime JSDoc form
		// contains the plain declaration as a literal suffix.
		let unmatchedSource = functionSource;
		const patchedCount = countOccurrences(
			unmatchedSource,
			patchedTarget
		);
		unmatchedSource = unmatchedSource.replaceAll( patchedTarget, '' );
		const legacyStates = legacyTargets.map( ( target ) => {
			const count = countOccurrences( unmatchedSource, target );
			unmatchedSource = unmatchedSource.replaceAll( target, '' );
			return { count, target };
		} );
		const unpatchedCount = countOccurrences(
			unmatchedSource,
			unpatchedBufferTarget
		);
		const activeStates = [
			{ count: patchedCount, target: patchedTarget },
			...legacyStates,
			{ count: unpatchedCount, target: unpatchedBufferTarget },
		].filter( ( state ) => state.count !== 0 );
		if (
			activeStates.length !== 1 ||
			activeStates[ 0 ].count !== 2
		) {
			const unexpectedAnnotation = [
				...functionSource.matchAll( bufferTargetPattern ),
			]
				.map( ( match ) => match[ 1 ]?.trim() )
				.find(
					( annotation ) =>
						annotation !== undefined &&
						! /^Buffer(?:<.+>)?$/u.test( annotation )
				);
			if ( unexpectedAnnotation !== undefined ) {
				throw new Error(
					`Refusing to apply the Node Buffer generic compatibility repair: unexpected type annotation '${ unexpectedAnnotation }' in '${ functionName }()' at ${ sourcePath }.`
				);
			}
			throw new Error(
				`Refusing to apply the Node Buffer generic compatibility repair: expected 2 consistent target declarations in '${ functionName }()' at ${ sourcePath }.`
			);
		}
		if ( activeStates[ 0 ].target !== patchedTarget ) {
			functionSource = functionSource.replaceAll(
				activeStates[ 0 ].target,
				patchedTarget
			);
		}
		nextSource = `${ nextSource.slice(
			0,
			functionStart
		) }${ functionSource }${ nextSource.slice( functionEnd ) }`;
	}
	return { nextSource, originalSource: source, sourcePath };
}

function removeStaleTemporaryFiles( sourcePath ) {
	const directoryPath = path.dirname( sourcePath );
	const temporaryFilePrefix = `${ path.basename(
		sourcePath
	) }.wp-typia-`;
	const staleBefore = Date.now() - STALE_TEMPORARY_FILE_AGE_MS;
	for ( const entry of fs.readdirSync( directoryPath, {
		withFileTypes: true,
	} ) ) {
		if (
			! entry.isFile() ||
			! entry.name.startsWith( temporaryFilePrefix ) ||
			! entry.name.endsWith( '.tmp' )
		) {
			continue;
		}
		const temporaryPath = path.join( directoryPath, entry.name );
		const stat = fs.statSync( temporaryPath, { throwIfNoEntry: false } );
		if ( stat === undefined ) {
			continue;
		}
		if ( stat.mtimeMs < staleBefore ) {
			fs.rmSync( temporaryPath, { force: true } );
		}
	}
}

function prepareRepairs() {
	return [
		prepareSourcePatches( {
			description: 'mapped/infer type-parameter',
			replacements: [
				{
					expectedOccurrences: 1,
					patchedSource: patchedParentGuard,
					unpatchedSource: unpatchedParentGuard,
				},
			],
			sourcePath: lintRulePath,
		} ),
		prepareBufferTargetRepair( lintIndexPath, [
			'directoryDigest',
			'configDirectoryDigest',
		] ),
		prepareBufferTargetRepair( lintRuntimePath, [ 'directoryDigest' ], {
			// This function is TypeScript source embedded in a JavaScript template
			// literal. Its explicit type is required when ttsx evaluates the string,
			// while node --check remains authoritative for the container file.
			legacyTargets: [ legacyJSDocBufferTarget ],
			scopeMarker: 'exports.TTSX_EXTRACTOR_SCRIPT = `',
		} ),
		prepareBufferTargetRepair(
			lintHostConfigPath,
			[ 'directoryDigest' ],
			{ scopeMarker: 'func typeScriptConfigLoaderSource(' }
		),
	];
}

try {
	const repairs = prepareRepairs();
	for ( const { nextSource, originalSource, sourcePath } of repairs ) {
		removeStaleTemporaryFiles( sourcePath );
		if ( originalSource === nextSource ) {
			continue;
		}
		const temporaryPath = `${ sourcePath }.wp-typia-${ process.pid }.tmp`;
		try {
			fs.writeFileSync( temporaryPath, nextSource, {
				encoding: 'utf8',
				mode: fs.statSync( sourcePath ).mode % 0o1000,
			} );
			fs.renameSync( temporaryPath, sourcePath );
		} finally {
			fs.rmSync( temporaryPath, { force: true } );
		}
	}
	// Each repair is idempotent, so a later install completes any partial write.
} catch ( error ) {
	throw new Error(
		'Failed to apply the @ttsc/lint compatibility repairs. Re-run pnpm install to recover from a partial write.',
		{ cause: error }
	);
}
