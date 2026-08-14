import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

import { expect, test, type Page } from '@playwright/test';

type Fixture = {
	baseUrl: string;
	defaultFromEmail: string;
	defaultListIds: string;
	optionToken: string;
	settingsPath: string;
};

const LOCAL_LISTMONK_HOSTS = new Set( [
	'host.docker.internal',
	'localhost',
	'127.0.0.1',
] );

function loadDotEnv( filePath: string ) {
	if ( ! fs.existsSync( filePath ) ) {
		throw new Error(
			`${ filePath } is required. Run pnpm run listmonk:start before settings E2E.`
		);
	}

	for ( const rawLine of fs
		.readFileSync( filePath, 'utf8' )
		.split( /\r?\n/ ) ) {
		const line = rawLine.trim();
		if ( ! line || line.startsWith( '#' ) ) {
			continue;
		}

		const equalsIndex = line.indexOf( '=' );
		if ( equalsIndex < 1 ) {
			continue;
		}

		const key = line.slice( 0, equalsIndex ).trim();
		let value = line.slice( equalsIndex + 1 ).trim();
		if (
			( value.startsWith( '"' ) && value.endsWith( '"' ) ) ||
			( value.startsWith( "'" ) && value.endsWith( "'" ) )
		) {
			value = value.slice( 1, -1 );
		}

		process.env[ key ] = process.env[ key ] || value;
	}
}

function requireEnv( name: string ): string {
	const value = process.env[ name ]?.trim();
	if ( ! value ) {
		throw new Error( `Missing required environment variable: ${ name }` );
	}

	return value;
}

function assertLocalListmonk() {
	const baseUrl = requireEnv( 'LISTMONK_BASE_URL' );
	let parsed: URL;
	try {
		parsed = new URL( baseUrl );
	} catch {
		throw new Error( `Invalid LISTMONK_BASE_URL: ${ baseUrl }` );
	}

	if ( ! LOCAL_LISTMONK_HOSTS.has( parsed.hostname ) ) {
		throw new Error(
			`Refusing to run settings E2E against non-local Listmonk host: ${ parsed.hostname }`
		);
	}
}

function parseListIds( rawValue: string ): number[] {
	const ids = rawValue
		.split( /[,\s]+/ )
		.map( ( value ) => Number.parseInt( value, 10 ) )
		.filter( ( value ) => Number.isInteger( value ) && value > 0 );

	if ( ids.length === 0 ) {
		throw new Error(
			'LISTMONK_DEFAULT_LIST_IDS must contain at least one positive integer.'
		);
	}

	return [ ...new Set( ids ) ];
}

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

function createFixture(): Fixture {
	loadDotEnv( '.listmonk.env' );
	assertLocalListmonk();

	const listIds = parseListIds( requireEnv( 'LISTMONK_DEFAULT_LIST_IDS' ) );
	const settings = {
		api_token: requireEnv( 'LISTMONK_API_TOKEN' ),
		api_user: requireEnv( 'LISTMONK_API_USER' ),
		base_url: requireEnv( 'LISTMONK_BASE_URL' ),
		default_from_email: requireEnv( 'LISTMONK_FROM_EMAIL' ),
		default_list_ids: listIds,
		default_template_id: 0,
		send_mode: 'campaign',
	};

	runWp( [ 'plugin', 'activate', 'wp-typia-newsletter-connector' ] );

	const php = `
$settings = json_decode( ${ phpString( JSON.stringify( settings ) ) }, true );
if ( ! is_array( $settings ) ) {
	echo wp_json_encode( array( 'ok' => false, 'error' => 'Unable to decode settings.' ) ) . PHP_EOL;
	exit( 1 );
}
update_option( 'newspack_listmonk_connector_settings', $settings, false );
echo wp_json_encode( array( 'ok' => true ), JSON_PRETTY_PRINT ) . PHP_EOL;
`;

	const output = runWp( [ 'eval', php ] );
	const decoded = JSON.parse( output ) as { error?: string; ok?: boolean };
	if ( ! decoded.ok ) {
		throw new Error( decoded.error || 'Fixture setup failed.' );
	}

	return {
		baseUrl: settings.base_url,
		defaultFromEmail: settings.default_from_email,
		defaultListIds: listIds.join( ', ' ),
		optionToken: settings.api_token,
		settingsPath:
			'/wp-admin/options-general.php?page=wp-typia-newsletter-connector',
	};
}

function readStoredApiToken(): string {
	const php = `
$settings = get_option( 'newspack_listmonk_connector_settings', array() );
echo is_array( $settings ) && isset( $settings['api_token'] ) ? $settings['api_token'] : '';
`;
	return runWp( [ 'eval', php ] );
}

async function loginAsAdmin( page: Page ) {
	await page.goto( '/wp-admin/' );
	if ( ! page.url().includes( 'wp-login.php' ) ) {
		return;
	}

	await page.locator( '#user_login' ).fill( 'admin' );
	await page.locator( '#user_pass' ).fill( 'password' );
	await Promise.all( [
		page.waitForURL( /\/wp-admin\// ),
		page.locator( '#wp-submit' ).click(),
	] );
}

test.describe.configure( { mode: 'serial' } );

test.describe( 'Listmonk settings screen', () => {
	let fixture: Fixture;

	test.beforeAll( () => {
		fixture = createFixture();
	} );

	test( 'hydrates, saves without replacing the token, and tests the connection', async ( {
		page,
	} ) => {
		await loginAsAdmin( page );
		await page.goto( fixture.settingsPath );
		await expect(
			page.getByRole( 'heading', {
				level: 1,
				name: 'WPTypia Email Service Provider Connector for Newspack Newsletters with Listmonk',
			} )
		).toBeVisible();

		const settings = page.locator(
			'.wp-typia-newsletter-connector-settings'
		);
		await expect( settings ).toBeVisible();

		await expect( settings.getByLabel( 'Listmonk API URL' ) ).toHaveValue(
			fixture.baseUrl
		);
		await expect( settings.getByLabel( 'API user' ) ).not.toHaveValue( '' );
		await expect( settings.getByLabel( 'API token' ) ).toHaveValue( '' );
		await expect(
			settings.getByText( 'API token saved: yes' )
		).toBeVisible();
		await expect( settings.getByLabel( 'Default From email' ) ).toHaveValue(
			fixture.defaultFromEmail
		);
		await expect( settings.getByLabel( 'Default list IDs' ) ).toHaveValue(
			fixture.defaultListIds
		);

		await settings
			.getByLabel( 'Default From email' )
			.fill( 'settings-e2e@example.com' );
		await settings.getByRole( 'button', { name: 'Save settings' } ).click();
		await expect(
			settings
				.locator( '.components-notice' )
				.filter( { hasText: 'Listmonk settings saved.' } )
		).toBeVisible();
		expect( readStoredApiToken() ).toBe( fixture.optionToken );

		await settings
			.getByRole( 'button', { name: 'Save and test connection' } )
			.click();
		await expect(
			settings
				.locator( '.components-notice' )
				.filter( { hasText: 'Listmonk connection succeeded.' } )
		).toBeVisible();

		await page.reload();
		await expect( page.getByLabel( 'Default From email' ) ).toHaveValue(
			'settings-e2e@example.com'
		);
		await expect( page.getByText( 'API token saved: yes' ) ).toBeVisible();
	} );
} );
