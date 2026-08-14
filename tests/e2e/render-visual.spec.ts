import { spawnSync } from 'node:child_process';

import { expect, test, type Page } from '@playwright/test';

type RenderFixture = {
	name: string;
	rawHtml: string;
};

function phpString( value: string ): string {
	return `'${ value.replace( /\\/g, '\\\\' ).replace( /'/g, "\\'" ) }'`;
}

function runWp( args: string[] ): string {
	const result = spawnSync(
		process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
		[ 'exec', 'wp-env', 'run', 'cli', 'wp', ...args ],
		{
			cwd: process.cwd(),
			encoding: 'utf8',
			stdio: [ 'pipe', 'pipe', 'pipe' ],
		}
	);

	if ( result.error ) {
		throw result.error;
	}

	if ( result.status !== 0 ) {
		throw new Error(
			[
				`WP-CLI command failed: wp ${ args.join( ' ' ) }`,
				result.stdout.trim(),
				result.stderr.trim(),
			]
				.filter( Boolean )
				.join( '\n' )
		);
	}

	return result.stdout.trim();
}

function resolvePluginSlug( candidates: string[] ): string {
	const installed = runWp( [ 'plugin', 'list', '--field=name' ] )
		.split( /\r?\n/ )
		.map( ( line ) => line.trim() )
		.filter( Boolean );

	const slug = candidates.find( ( candidate ) =>
		installed.includes( candidate )
	);
	if ( ! slug ) {
		throw new Error(
			`Unable to find plugin slug. Expected one of ${ candidates.join(
				', '
			) }. Installed: ${ installed.join( ', ' ) }`
		);
	}

	return slug;
}

function createRenderFixture(): RenderFixture {
	runWp( [
		'plugin',
		'activate',
		resolvePluginSlug( [
			'newspack-newsletters',
			'newspack-newsletters.latest-stable',
		] ),
	] );
	runWp( [ 'plugin', 'activate', 'wp-typia-newsletter-connector' ] );

	const imageSvg =
		'<svg xmlns="http://www.w3.org/2000/svg" width="480" height="220" viewBox="0 0 480 220"><rect width="480" height="220" fill="#f3f4f6"/><circle cx="110" cy="112" r="52" fill="#0069c2"/><rect x="190" y="72" width="210" height="24" rx="12" fill="#232323"/><rect x="190" y="116" width="160" height="18" rx="9" fill="#646970"/></svg>';
	const imageSrc = `data:image/svg+xml;base64,${ Buffer.from(
		imageSvg
	).toString( 'base64' ) }`;

	const content = [
		'<!-- wp:heading --><h2 class="wp-block-heading">Visual Fixture Digest</h2><!-- /wp:heading -->',
		'<!-- wp:paragraph --><p>A stable newsletter render fixture with paragraph text, emphasized copy, and a root-relative link to <a href="/visual-fixture">the site archive</a>.</p><!-- /wp:paragraph -->',
		'<!-- wp:image --><figure class="wp-block-image"><img src="' +
			imageSrc +
			'" alt="Abstract newsletter illustration"/><figcaption>Representative image block</figcaption></figure><!-- /wp:image -->',
		'<!-- wp:columns --><div class="wp-block-columns"><!-- wp:column --><div class="wp-block-column"><p><strong>Left column</strong><br>Short summary item.</p></div><!-- /wp:column --><!-- wp:column --><div class="wp-block-column"><p><strong>Right column</strong><br>Secondary detail with enough text to wrap naturally.</p></div><!-- /wp:column --></div><!-- /wp:columns -->',
		'<!-- wp:quote --><blockquote class="wp-block-quote"><p>Quotes should survive the raw HTML cleanup path.</p><cite>WPTypia Email Service Provider Connector for Newspack Newsletters with Listmonk</cite></blockquote><!-- /wp:quote -->',
		'<!-- wp:buttons --><div class="wp-block-buttons"><!-- wp:button --><div class="wp-block-button"><a class="wp-block-button__link" href="/subscribe">Read more</a></div><!-- /wp:button --></div><!-- /wp:buttons -->',
	].join( '\n' );

	const php = `
$post_id = wp_insert_post(
	array(
		'post_type' => 'post',
		'post_status' => 'draft',
		'post_title' => 'Visual Fixture Digest',
		'post_content' => ${ phpString( content ) },
	),
	true
);

if ( is_wp_error( $post_id ) ) {
	echo wp_json_encode( array( 'ok' => false, 'error' => $post_id->get_error_message() ), JSON_PRETTY_PRINT ) . PHP_EOL;
	exit( 1 );
}

$builder = new Newspack_Listmonk_Connector_Raw_HTML_Builder();
$raw_html = $builder->build( get_post( $post_id ), array( 'template_id' => 0 ) );

echo wp_json_encode(
	array(
		'ok' => true,
		'name' => 'representative-blocks',
		'rawHtml' => $raw_html,
	),
	JSON_PRETTY_PRINT
) . PHP_EOL;
`;

	const decoded = JSON.parse( runWp( [ 'eval', php ] ) ) as RenderFixture & {
		error?: string;
		ok?: boolean;
	};

	if ( ! decoded.ok ) {
		throw new Error( decoded.error || 'Render fixture setup failed.' );
	}

	return decoded;
}

async function renderEmailHtml( page: Page, rawHtml: string ) {
	await page.setViewportSize( {
		height: 900,
		width: 640,
	} );
	await page.setContent( rawHtml, {
		waitUntil: 'load',
	} );
	await page.addStyleTag( {
		content:
			'html { background: #e5e7eb; } body { background: #ffffff; box-sizing: border-box; margin: 0 auto; max-width: 640px; min-height: 100vh; padding: 32px; } img { height: auto; max-width: 100%; }',
	} );
}

test.describe( 'Listmonk raw HTML visual fixtures', () => {
	let fixture: RenderFixture;

	test.beforeAll( () => {
		fixture = createRenderFixture();
	} );

	test( 'representative newsletter blocks remain visually stable', async ( {
		page,
	} ) => {
		await renderEmailHtml( page, fixture.rawHtml );

		await expect( page ).toHaveScreenshot( `${ fixture.name }.png`, {
			animations: 'disabled',
			fullPage: true,
			maxDiffPixelRatio: 0.01,
		} );
	} );
} );
